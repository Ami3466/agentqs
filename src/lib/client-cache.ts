"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The app's one client-side data cache — stale-while-revalidate over `fetch`.
 *
 * Every panel used to own `useState<T | null>(null)` + a `useEffect` that fetched
 * on mount. Because the tab bar is a client-side route change, moving between tabs
 * UNMOUNTS those panels and remounts them empty, so every visit paid the full
 * round trip again (on a real record: coverage ~1s, sources ~2s, journal ~3s and
 * 2.6MB) and showed a bare "Loading…" the whole time. Nothing was wrong with the
 * server — the client simply threw its answers away.
 *
 * This keeps them in a module-level map, which outlives any component and any
 * route change (it dies with the tab, as a cache should). A revisit renders the
 * previous answer INSTANTLY and refetches in the background, so the second visit
 * to a tab has no loading state at all. Three other properties matter as much:
 *
 *   • DEDUPE — three panels asking for /api/sources in the same tick share ONE
 *     request, instead of racing three identical scans of the record.
 *   • QUIET REVALIDATION — a background refresh never flips `loading` back on, so
 *     it can't unmount the panel the user is working in (the house rule).
 *   • EXPLICIT INVALIDATION — after a mutation, `invalidate(key)` drops the entry
 *     so the next read is authoritative. A cache that can't be busted is a bug.
 *
 * Server data stays the source of truth: this only decides WHEN to ask, never what
 * the answer is.
 */

interface Entry<T> {
  data?: T;
  error?: string;
  /** When `data` was last written — drives staleness. */
  at: number;
  /** The in-flight request, so concurrent readers share one round trip. */
  inflight?: Promise<void>;
}

const cache = new Map<string, Entry<unknown>>();
const listeners = new Map<string, Set<() => void>>();

/** Default freshness window. Long enough that flipping between tabs never
 *  refetches, short enough that a tab left open catches up on its own. */
const DEFAULT_TTL_MS = 30_000;

function emit(key: string): void {
  for (const fn of listeners.get(key) ?? []) fn();
}

function subscribe(key: string, fn: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(key);
  };
}

/** Drop cached answers so the next read hits the server. Call after any mutation.
 *  A bare `invalidate()` clears everything — the right move after a sync/import
 *  that can move more than one panel's numbers. */
export function invalidate(...keys: string[]): void {
  if (keys.length === 0) {
    const all = [...cache.keys()];
    cache.clear();
    for (const k of all) emit(k);
    return;
  }
  for (const key of keys) {
    cache.delete(key);
    emit(key);
  }
}

/** Write a value straight into the cache — for a response that already carries the
 *  fresh state, so the UI updates without a second round trip. */
export function primeCache<T>(key: string, data: T): void {
  cache.set(key, { data, at: Date.now() });
  emit(key);
}

/** Read the cached value without subscribing (for a one-off seed). */
export function peekCache<T>(key: string): T | undefined {
  return cache.get(key)?.data as T | undefined;
}

async function revalidate<T>(key: string, url: string, init?: RequestInit): Promise<void> {
  const entry = (cache.get(key) as Entry<T>) ?? { at: 0 };
  if (entry.inflight) return entry.inflight;

  const run = (async () => {
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Request failed (${res.status}).`);
      }
      const data = (await res.json()) as T;
      cache.set(key, { data, at: Date.now() });
    } catch (e) {
      const prev = cache.get(key) as Entry<T> | undefined;
      // A failed refresh must not erase a good answer the user is reading — keep
      // the data, surface the error beside it.
      cache.set(key, { data: prev?.data, at: prev?.at ?? 0, error: (e as Error).message });
    } finally {
      const cur = cache.get(key) as Entry<T> | undefined;
      if (cur) delete cur.inflight;
      emit(key);
    }
  })();

  cache.set(key, { ...entry, inflight: run });
  return run;
}

export interface CachedFetch<T> {
  data: T | undefined;
  error: string;
  /** True ONLY while there is nothing to show. A background refresh never sets it —
   *  it would unmount the panel the user is working in. */
  loading: boolean;
  /** True while a refresh runs over data that is already on screen. */
  refreshing: boolean;
  /** Refetch now, ignoring the TTL. Quiet: the current data stays rendered. */
  refresh: () => Promise<void>;
}

/**
 * Fetch `url` through the shared cache. `key` defaults to the url; pass one
 * explicitly when two callers should share an entry.
 *
 * `enabled: false` parks the hook without fetching — how a collapsed/never-opened
 * row avoids paying for data nobody asked to see.
 */
export function useCachedFetch<T>(
  url: string | null,
  opts: { key?: string; ttlMs?: number; enabled?: boolean } = {},
): CachedFetch<T> {
  const { ttlMs = DEFAULT_TTL_MS, enabled = true } = opts;
  const key = opts.key ?? url ?? "";
  const active = enabled && Boolean(url);
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);
  // Only the mounted-and-active hooks get told; an unmounted one must not setState.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const off = subscribe(key, () => {
      if (mounted.current) rerender();
    });
    const entry = cache.get(key) as Entry<T> | undefined;
    const fresh = entry?.data !== undefined && Date.now() - entry.at < ttlMs;
    if (!fresh) void revalidate<T>(key, url as string);
    return off;
  }, [key, url, active, ttlMs, rerender]);

  const entry = active ? ((cache.get(key) as Entry<T> | undefined) ?? undefined) : undefined;
  const refresh = useCallback(async () => {
    if (!url) return;
    // Drop only the timestamp, never the data — the panel keeps rendering.
    const cur = cache.get(key) as Entry<T> | undefined;
    if (cur) cache.set(key, { ...cur, at: 0 });
    await revalidate<T>(key, url);
  }, [key, url]);

  return {
    data: entry?.data,
    error: entry?.error ?? "",
    loading: active && entry?.data === undefined && !entry?.error,
    refreshing: Boolean(entry?.inflight) && entry?.data !== undefined,
    refresh,
  };
}

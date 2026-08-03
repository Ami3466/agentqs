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
  /** Where the answer came from, so an invalidation can refetch it for a reader
   *  that is on screen right now. */
  url?: string;
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
  const targets = keys.length === 0 ? [...cache.keys()] : keys;
  for (const key of targets) drop(key);
}

/** Invalidate one key. A key nobody is reading is simply deleted — the next mount
 *  fetches it. A key with a MOUNTED reader is different: that hook's fetch effect
 *  already ran, so deleting the entry would leave the panel showing a skeleton
 *  forever (it re-renders, sees no data, and nothing re-asks). Those refetch here
 *  instead, keeping the old answer on screen while the new one lands — the house
 *  rule that a post-action refresh is quiet. */
function drop(key: string): void {
  const entry = cache.get(key);
  const watched = (listeners.get(key)?.size ?? 0) > 0;
  if (watched && entry?.url && entry.data !== undefined) {
    cache.set(key, { data: entry.data, at: 0, url: entry.url });
    emit(key);
    void revalidate(key, entry.url);
    return;
  }
  cache.delete(key);
  emit(key);
}

/** Write a value straight into the cache — for a response that already carries the
 *  fresh state, so the UI updates without a second round trip. */
export function primeCache<T>(key: string, data: T): void {
  const prev = cache.get(key);
  cache.set(key, { data, at: Date.now(), url: prev?.url });
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
      cache.set(key, { data, at: Date.now(), url });
    } catch (e) {
      const prev = cache.get(key) as Entry<T> | undefined;
      // A failed refresh must not erase a good answer the user is reading — keep
      // the data, surface the error beside it.
      cache.set(key, { data: prev?.data, at: prev?.at ?? 0, error: (e as Error).message, url });
    } finally {
      const cur = cache.get(key) as Entry<T> | undefined;
      if (cur) delete cur.inflight;
      emit(key);
    }
  })();

  cache.set(key, { ...entry, url, inflight: run });
  return run;
}

/**
 * One-shot read through the shared cache, for a panel that owns its own state and
 * can't use the hook. Same three guarantees as `useCachedFetch`: an in-flight
 * request is SHARED rather than duplicated (which is what stops a panel's own load
 * from racing the background warmer for the same url), the answer lands in the
 * cache for the next reader, and a fresh entry is returned without a round trip.
 *
 * Throws on failure, so callers keep their existing error handling.
 */
export async function fetchCached<T>(url: string, opts: { ttlMs?: number; force?: boolean } = {}): Promise<T> {
  const { ttlMs = DEFAULT_TTL_MS, force = false } = opts;
  const entry = cache.get(url) as Entry<T> | undefined;
  if (!force && entry?.data !== undefined && Date.now() - entry.at < ttlMs) return entry.data;
  if (force && entry && !entry.inflight) cache.set(url, { ...entry, at: 0 });
  await revalidate<T>(url, url);
  const next = cache.get(url) as Entry<T> | undefined;
  if (next?.data === undefined) throw new Error(next?.error || "Request failed.");
  return next.data;
}

/**
 * Fill the cache for views the user has NOT opened yet, so the first visit to a
 * tab is as instant as the second.
 *
 * Two rules make this a help and not a new problem. It runs STRICTLY ONE AT A
 * TIME: the server holds the record in SQLite and better-sqlite3 is synchronous,
 * so parallel warm-up requests would queue behind each other anyway — and worse,
 * would delay the request the user is actually waiting for. And it never touches
 * an entry that is already fresh or already in flight, so a warmed tab the user
 * then opens costs nothing twice.
 *
 * Returns a cancel function; the warmer stops at the next gap when the app
 * unmounts.
 */
export function warmCache(urls: string[], opts: { ttlMs?: number } = {}): () => void {
  const { ttlMs = DEFAULT_TTL_MS } = opts;
  let cancelled = false;
  void (async () => {
    for (const url of urls) {
      if (cancelled) return;
      const entry = cache.get(url) as Entry<unknown> | undefined;
      if (entry?.inflight) continue;
      if (entry?.data !== undefined && Date.now() - entry.at < ttlMs) continue;
      await revalidate(url, url).catch(() => undefined);
    }
  })();
  return () => {
    cancelled = true;
  };
}

/** Run `fn` when the browser is idle, or soon after paint where that API is
 *  missing (Safari). Warm-up must never compete with the render the user sees. */
export function whenIdle(fn: () => void, timeout = 2_000): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (h: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const handle = w.requestIdleCallback(fn, { timeout });
    return () => w.cancelIdleCallback?.(handle);
  }
  const t = window.setTimeout(fn, 300);
  return () => window.clearTimeout(t);
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

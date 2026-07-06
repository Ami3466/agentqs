/**
 * Sync-engine core — pure and browser-safe (NO fs/path here, so the Data-tab
 * client can import these helpers directly). The fs-backed source composition
 * lives in ./source-registry (server-only).
 *
 * Two source kinds behave differently on a schedule:
 *   - api    → can auto-sync. When its interval has elapsed it is DUE, and the
 *              Data tab runs it on open (lazy-sync-on-open).
 *   - manual → can't auto-sync (a file drop, an export you paste). When fresh
 *              data hasn't arrived within its interval it is STALE, and we badge
 *              it as a nudge to refresh.
 */

export type SourceKind = "api" | "manual";
export type Interval = "off" | "hourly" | "daily" | "weekly";

/** Interval options for the per-source dropdown. `off` = no schedule. */
export const INTERVALS: { value: Interval; label: string }[] = [
  { value: "off", label: "Manual" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

const WINDOW_MS: Record<Exclude<Interval, "off">, number> = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
};

/** Milliseconds for a scheduled interval, or null when off. */
export function intervalMs(i: Interval): number | null {
  return i === "off" ? null : WINDOW_MS[i];
}

export function isValidInterval(x: unknown): x is Interval {
  return x === "off" || x === "hourly" || x === "daily" || x === "weekly";
}

/** Milliseconds since `lastSync`, or null when never synced / unparseable. */
function elapsed(lastSync: string | null): number | null {
  if (!lastSync) return null;
  const t = new Date(lastSync).getTime();
  return Number.isFinite(t) ? Date.now() - t : null;
}

/**
 * An API source is DUE for lazy-sync-on-open when its schedule has elapsed —
 * or it is scheduled but has never synced (sync it now to seed it).
 */
export function isDue(lastSync: string | null, interval: Interval): boolean {
  const win = intervalMs(interval);
  if (win == null) return false;
  const e = elapsed(lastSync);
  if (e == null) return true; // scheduled, never synced → due
  return e >= win;
}

/**
 * A MANUAL source is STALE when it has data but none has arrived within its
 * interval. Never "stale" before it has any data (that's just "not connected").
 */
export function isStale(lastSync: string | null, interval: Interval): boolean {
  const win = intervalMs(interval);
  if (win == null) return false;
  const e = elapsed(lastSync);
  if (e == null) return false; // no data yet → not stale
  return e >= win;
}

/** Compact relative-time label. Centralized so every panel reads the same. */
export function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "never";
  const s = ms / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** One row in the Data-tab sources list. */
export interface SourceView {
  id: string;
  name: string;
  kind: SourceKind;
  detail: string;
  connected: boolean;
  interval: Interval;
  lastSync: string | null;
  stale: boolean; // manual + connected + overdue
  due: boolean; // api + connected + syncable + overdue → auto-sync on open
  syncEndpoint: string | null; // POST target for api auto-sync
  live: boolean; // has a working importer (false = stub / not-yet-live placeholder)
  automation?: boolean; // a browser-automation recipe (Playwright-driven, no API)
  automationStatus?: "ok" | "error" | null; // last replay outcome (automation rows)
  automationError?: string | null; // last replay error, if any
}

/**
 * Sync-engine core — pure and browser-safe (NO fs/path here, so the Pipeline-tab
 * client can import these helpers directly). The fs-backed source composition
 * lives in ./source-registry (server-only).
 *
 * Two source kinds behave differently on a schedule:
 *   - api    → can auto-sync. When its interval has elapsed it is DUE, and the
 *              Pipeline tab runs it on open (lazy-sync-on-open).
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

/** What this source actually landed in the record — the answer to "did it sync?".
 *  Counted from the cache (daily + events), so it is derived, never claimed. */
export interface SourceCoverage {
  events: number;
  days: number;
  from: string | null;
  to: string | null;
}

/**
 * HOW this row came to hold data. `connected` alone cannot say it: a dropped CSV
 * and an authorized API account are wildly different things, and rendering both as
 * "Connected" is a lie the user pays for ("it says connected — connected to WHAT?").
 *
 *   credential  — a stored key/grant. THE only thing that counts as connected:
 *                 it has an account, it can sync, it is due on a schedule.
 *   local-file  — a file importer that re-reads a file on THIS machine (Chrome
 *                 history, Apple Health). No account, no key; the web server can't
 *                 reach your disk, so it re-runs from the CLI/MCP/daemon.
 *   imported    — rows landed from a drop, an archive or an agent. Nothing syncs
 *                 it; it is history sitting in the record, not a live connection.
 *   automation  — a recorded browser recipe that replays on a schedule.
 */
export type SourceProvenance = "credential" | "local-file" | "imported" | "automation";

/** One row in the Pipeline-tab sources list. */
export interface SourceView {
  id: string;
  name: string;
  kind: SourceKind;
  detail: string;
  /** ⇔ a stored credential. Data in the record NEVER flips this — see `provenance`
   *  for how a row that is NOT connected still came to hold data. */
  connected: boolean;
  /** How the data got here. Drives the row's badge, so "Connected" can only ever
   *  mean "a key is stored and this thing can sync". */
  provenance?: SourceProvenance;
  interval: Interval;
  lastSync: string | null;
  stale: boolean; // manual + connected + overdue
  due: boolean; // api + connected + syncable + overdue → auto-sync on open
  syncEndpoint: string | null; // POST target for api auto-sync
  live: boolean; // has a working importer (false = stub / not-yet-live placeholder)
  automation?: boolean; // a browser-automation recipe (Playwright-driven, no API)
  automationStatus?: "ok" | "error" | null; // last replay outcome (automation rows)
  automationError?: string | null; // last replay error, if any
  plugin?: boolean; // a Tier-1 plugin source — supports extra accounts ("<id>-2" instances)
  /** An aggregate of several record sources (e.g. a Takeout archive) — its id is
   *  not a `daily.source` value, so no single-source Journal filter exists for it. */
  bundle?: boolean;
  /** Sources that are ONE connection with one key, shown as one card with a product
   *  tree instead of N strangers in the list ("google" → Calendar, Gmail → Sent).
   *  Matches the plugin's `oauth.providerKey`. */
  provider?: string;
  /** A live-capture channel (Slack, Telegram): data arrives PUSHED to our webhook,
   *  so there is nothing to schedule and nothing to sync — it is connected by a bot
   *  token and it fills the inbox. Connect it in Settings → Channels. */
  channel?: boolean;
  /** Provenance of the working credential: "saved" = the user connected it,
   *  "env" = environment variable, "discovered" = auto-detected from the
   *  source's local desktop app (the user never connected it — surface that). */
  credentialOrigin?: "env" | "saved" | "discovered" | null;
  /** Rows exist in the record. Orthogonal to `connected`: imported data must
   *  never present a source as connected, and a connected source may be empty. */
  hasData?: boolean;
  /** Days/events landed + the date range they span. Drives the row's "what
   *  synced" line, so a connected-but-empty source cannot look like a healthy one. */
  coverage?: SourceCoverage;
  /** WHICH account this credential belongs to (the WHOOP login's email, a
   *  handle) — two accounts of the same service are otherwise indistinguishable. */
  account?: string | null;
  /** A local desktop app's token is detectable but the user has NOT opted in —
   *  the UI offers "Use detected app" instead of silently syncing with it. */
  detectedApp?: boolean;
  /** Most recent sync attempt from the run ledger (sync-runs.ts) — failures
   *  included, so a broken automation cannot render identically to a healthy one. */
  lastRunOk?: boolean | null;
  lastRunError?: string | null;
  /** The source's background sync job (sync-jobs.ts): queued/running carries the
   *  live phase + percent for the progress bar; ok/error is the last outcome.
   *  Server state, so the bar survives page refreshes. */
  job?: SourceJobView | null;
}

/** Browser-safe slice of a sync job (full shape lives in sync-jobs.ts). */
export interface SourceJobView {
  status: "queued" | "running" | "ok" | "error";
  phase: string;
  pct: number;
  startedAt: string;
  updatedAt?: string;
  finishedAt?: string;
  error?: string;
  days?: number;
  dailyRows?: number;
}

/** A job the UI should poll + show a bar for. */
export function jobActive(job: SourceJobView | null | undefined): boolean {
  return job?.status === "queued" || job?.status === "running";
}

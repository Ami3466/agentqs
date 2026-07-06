import { readConfig, type AppConfig } from "../config";
import { mergeDailyCsv, type DailyMergeResult } from "../record";
import { recordDir } from "../paths";

/**
 * Record-contract importer plugins — the shared interface the single-credential
 * Tier-1 API sources live behind (RescueTime, Google Calendar, Spotify). Same
 * shape GitHub follows, generalized (WHOOP is bespoke — unofficial app login):
 *
 *   credential → fetch a window → normalize into a wide daily table
 *   ({header:[date, ...metrics], rows}) → merge into record/daily/<id>.csv → rebuild.
 *
 * The write is the generic, idempotent `mergeDailyCsv` (blanks never clobber; same
 * inputs → byte-identical file). The network layer is injectable (`fetchImpl`) so
 * the fetch → normalize → merge pipeline runs offline against a fixture — the same
 * trick that lets GitHub's ships-when run with no network.
 */

export type FetchLike = typeof fetch;

/** Wide daily table: header[0] = "date", the rest are metric columns. */
export interface DailyTable {
  header: string[];
  rows: string[][];
}

export interface ImporterContext {
  credential?: string;
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  fetchImpl?: FetchLike;
}

export interface ImporterResult {
  table: DailyTable;
  meta?: Record<string, unknown>;
}

export interface ImporterPlugin {
  id: string; // source stem → record/daily/<id>.csv
  name: string; // display name
  detail: string; // one-line description for the Data tab
  /** api sources are auto-syncable; a not-yet-wired adapter would be `false`. */
  live: boolean;
  /** Whether a credential is required to sync (all Tier-1 APIs need one). */
  requiresCredential: boolean;
  credentialLabel: string; // "RescueTime API key" | "OAuth access token"
  credentialPlaceholder: string; // input placeholder
  envKey?: string; // env var the credential can come from
  /** The metric column the Data-tab sparkline / headline number reads. */
  primaryMetric: string;
  unit?: string; // shown after the headline number (e.g. "meetings")
  /** Fetch a window and normalize it into the wide daily table. */
  fetch(ctx: ImporterContext): Promise<ImporterResult>;
}

/** Credential precedence: explicit arg → env var → saved config (sourceCreds[id]). */
export function resolveCredential(
  plugin: ImporterPlugin,
  explicit?: string,
  cfg: AppConfig | null = readConfig(),
): string | undefined {
  if (explicit && explicit.trim()) return explicit.trim();
  if (plugin.envKey && process.env[plugin.envKey]) return process.env[plugin.envKey];
  return cfg?.sourceCreds?.[plugin.id]?.trim() || undefined;
}

export interface PluginImportSummary extends DailyMergeResult {
  id: string;
  name: string;
  from: string;
  to: string;
  daysWithData: number; // distinct dates the incoming window wrote
  meta?: Record<string, unknown>;
}

/**
 * Run one plugin end to end: fetch → normalize → merge into record/daily/<id>.csv.
 * Rebuilding the SQLite cache is the caller's job (route / CLI), exactly like the
 * GitHub importer.
 */
export async function importPlugin(
  plugin: ImporterPlugin,
  ctx: ImporterContext,
  dir: string = recordDir(),
): Promise<PluginImportSummary> {
  if (plugin.requiresCredential && !ctx.fetchImpl && !ctx.credential) {
    throw new Error(`${plugin.name} needs a ${plugin.credentialLabel}.`);
  }
  const result = await plugin.fetch(ctx);
  const merge = mergeDailyCsv(dir, plugin.id, result.table);
  return {
    ...merge,
    id: plugin.id,
    name: plugin.name,
    from: ctx.from,
    to: ctx.to,
    daysWithData: merge.dates.length,
    meta: result.meta,
  };
}

// ---- Shared fetch helpers -------------------------------------------------

/** A trailing window of `days` days ending today (both bounds inclusive, UTC). */
export function windowDays(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime());
  from.setUTCDate(from.getUTCDate() - (Math.max(1, days) - 1));
  return { from: iso(from), to: iso(to) };
}

export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function inWindow(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

/** GET a URL and parse JSON, surfacing a short error body like the GitHub client. */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).trim().slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}${body ? ` — ${body}` : ""}`);
  }
  return res.json();
}

/** Round to 2 decimals and strip a trailing ".0"/".00" so CSV stays tidy. */
export function num(n: number): string {
  if (!Number.isFinite(n)) return "";
  const r = Math.round(n * 100) / 100;
  return String(r);
}

/**
 * Build a fetch stand-in that always returns `body` as JSON — offline fixtures for
 * the single-request plugins. `fetchImpl` in ImporterContext accepts this.
 */
export function fixtureFetch(body: unknown): FetchLike {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as FetchLike;
}

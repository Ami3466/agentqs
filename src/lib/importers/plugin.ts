import fs from "fs";
import { readConfig, type AppConfig } from "../config";
import {
  appendEvents,
  mergeDailyCsv,
  removeEventsBySource,
  type AppendEventInput,
  type DailyMergeResult,
} from "../record";
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

/** A per-item record for the journal timeline. `source` defaults to the instance id
 *  so a multi-account instance ("granola-2") keeps its own events. */
export type ImporterEvent = Omit<AppendEventInput, "source"> & { source?: string };

export interface ImporterResult {
  table: DailyTable;
  /**
   * Long-form text the source wants embedded + full-text searchable, keyed by the
   * suffix of its own daily file — `{ texts: … }` → `record/daily/<id>_texts.csv`.
   * Only daily *text* cells reach the search index (events do not), so a source
   * whose value is prose (meeting notes) lands it here, by the `date,chars,text`
   * convention the journal importers already use.
   */
  extraTables?: Record<string, DailyTable>;
  /** Per-item records for the journal timeline. `appendEvents` dedups by id, and
   *  a `mutableEvents` plugin replaces its window first (see ImporterPlugin). */
  events?: ImporterEvent[];
  meta?: Record<string, unknown>;
}

/** How to obtain the credential — the connect form, `agentqs source guide` and
 *  docs all render THIS, so a source is never a bare paste box with no path to
 *  a key. `url` is where the user starts (dashboard / token page). */
export interface CredentialHelp {
  url: string;
  steps: string[];
}

/** Provider endpoints for the standard OAuth2 authorization-code + refresh
 *  dance. Set on sources whose tokens EXPIRE — pasting an access token can
 *  never survive auto-sync there, so connect runs the dance instead: the user
 *  registers an app (redirect URI shown in the form), pastes client id +
 *  secret, authorizes, and syncs mint fresh tokens from the refresh token. */
export interface OAuthProviderConfig {
  authUrl: string; // provider authorize endpoint
  tokenUrl: string; // code + refresh exchange endpoint
  scope: string;
  /** Where client id+secret travel on token calls: HTTP Basic vs form body. */
  tokenAuth: "basic" | "body";
  extraAuthParams?: Record<string, string>; // e.g. Google's access_type=offline
}

export interface ImporterPlugin {
  id: string; // source stem → record/daily/<id>.csv
  name: string; // display name
  detail: string; // one-line description for the Pipeline tab
  /** api sources are auto-syncable; a not-yet-wired adapter would be `false`. */
  live: boolean;
  /** Whether a credential is required to sync (all Tier-1 APIs need one). */
  requiresCredential: boolean;
  credentialLabel: string; // "RescueTime API key" | "OAuth access token"
  credentialPlaceholder: string; // input placeholder
  /** How to get the credential (steps + start URL) — required for every
   *  credentialed source; the guide test fails a bare paste box. */
  credentialHelp?: CredentialHelp;
  /** OAuth2 authorization-code app config — only for expiring-token providers. */
  oauth?: OAuthProviderConfig;
  envKey?: string; // env var the credential can come from
  /** The metric column the Pipeline-tab sparkline / headline number reads. */
  primaryMetric: string;
  unit?: string; // shown after the headline number (e.g. "meetings")
  /**
   * The source's per-item records are re-derived on every sync, not immutable
   * history — a Granola meeting gets a fresh AI summary after it ends. When set,
   * a sync REPLACES this source's events across the fetched window (delete in
   * [from,to] → append the fresh set) instead of dedup-appending, so a re-sync
   * reflects the current content. Leave unset for append-only event sources.
   */
  mutableEvents?: boolean;
  /** Last-resort credential lookup for a source whose own desktop app already
   *  holds a login on this machine (Granola). Base account only, like `envKey`,
   *  so extra accounts never silently inherit the desktop login. */
  discoverCredential?(): string | undefined;
  /** Fetch a window and normalize it into the wide daily table. */
  fetch(ctx: ImporterContext): Promise<ImporterResult>;
}

/** Credential precedence: explicit arg → env var → saved config (sourceCreds[key])
 *  → the source's own desktop app, if it exposes one (`discoverCredential`).
 *  `credKey` is the multi-account instance id ("spotify-2"); the env and desktop
 *  fallbacks only apply to the base account so extra accounts never silently
 *  share one login. */
export function resolveCredential(
  plugin: ImporterPlugin,
  explicit?: string,
  cfg: AppConfig | null = readConfig(),
  credKey: string = plugin.id,
): string | undefined {
  return resolveCredentialWithOrigin(plugin, explicit, cfg, credKey).credential;
}

/** Where a credential comes from. "discovered" = auto-detected from the source's
 *  local desktop app — the user never pasted anything, and the UI must say so
 *  instead of presenting the source as if the user connected it. */
export type CredentialOrigin = "explicit" | "env" | "saved" | "discovered";

export function resolveCredentialWithOrigin(
  plugin: ImporterPlugin,
  explicit?: string,
  cfg: AppConfig | null = readConfig(),
  credKey: string = plugin.id,
): { credential?: string; origin: CredentialOrigin | null } {
  if (explicit && explicit.trim()) return { credential: explicit.trim(), origin: "explicit" };
  // A completed OAuth grant IS a stored credential (the user authorized it in
  // the connect form), so it satisfies the connection rule exactly like a
  // pasted key. Sync paths mint a FRESH access token via oauth.ts; the stored
  // one here only answers presence/connected checks.
  const grant = cfg?.sourceOAuth?.[credKey];
  if (grant?.refreshToken || grant?.accessToken) {
    return { credential: grant.accessToken || grant.refreshToken, origin: "saved" };
  }
  const isBase = credKey === plugin.id;
  if (isBase && plugin.envKey && process.env[plugin.envKey]) {
    return { credential: process.env[plugin.envKey], origin: "env" };
  }
  const saved = cfg?.sourceCreds?.[credKey]?.trim();
  if (saved) return { credential: saved, origin: "saved" };
  if (isBase && plugin.discoverCredential) {
    try {
      const discovered = plugin.discoverCredential()?.trim();
      if (discovered) return { credential: discovered, origin: "discovered" };
    } catch {
      /* a desktop app that isn't installed/signed in is not an error */
    }
  }
  return { origin: null };
}

/**
 * The connection model — the one hard rule: CONNECTED ⇔ A STORED CREDENTIAL
 * (user-saved or env). Nothing else can flip it — not landed data, not a
 * discoverable desktop-app login, not any CLI/MCP/API call without a key.
 *   hasData     — rows exist in the record (imports count; says NOTHING about auth)
 *   detectedApp — a local desktop app's login is discoverable; a UI hint ONLY.
 *                 Connecting it means IMPORTING that token as a saved credential
 *                 (visible, revocable) — never using it silently.
 */
export interface ConnectionState {
  hasData: boolean;
  credentialOrigin: CredentialOrigin | null;
  detectedApp: boolean; // discoverable local-app token exists (hint, not auth)
  connected: boolean;
}

export function connectionState(
  plugin: ImporterPlugin,
  cfg: AppConfig | null,
  instanceId: string = plugin.id,
  dailyFile?: string,
): ConnectionState {
  const { origin } = resolveCredentialWithOrigin(plugin, undefined, cfg, instanceId);
  const connected = origin === "saved" || origin === "env";
  let hasData = false;
  if (dailyFile) {
    try {
      const raw = fs.readFileSync(dailyFile, "utf8");
      hasData = raw.trim().split("\n").length > 1;
    } catch {
      /* no file — no data */
    }
  }
  return { hasData, credentialOrigin: origin, detectedApp: origin === "discovered", connected };
}

/** Credential for actually RUNNING a sync: explicit arg, env, or saved config.
 *  A discovered desktop-app token NEVER syncs — it must first be imported as a
 *  saved credential through an explicit connect. */
export function resolveSyncCredential(
  plugin: ImporterPlugin,
  explicit?: string,
  cfg: AppConfig | null = readConfig(),
  credKey: string = plugin.id,
): string | undefined {
  const { credential, origin } = resolveCredentialWithOrigin(plugin, explicit, cfg, credKey);
  return origin === "discovered" ? undefined : credential;
}

export interface PluginImportSummary extends DailyMergeResult {
  id: string;
  name: string;
  from: string;
  to: string;
  daysWithData: number; // distinct dates the incoming window wrote
  eventsAdded: number; // new journal events (0 for a daily-metrics-only source)
  extraSources: string[]; // extra daily files written, e.g. ["granola_texts"]
  meta?: Record<string, unknown>;
}

/**
 * Run one plugin end to end: fetch → normalize → merge into record/daily/<fileId>.csv,
 * plus any `extraTables` (→ record/daily/<fileId>_<suffix>.csv) and `events`
 * (→ record/events.jsonl, deduped by id). Keeping the writes here — not in
 * `fetch()` — leaves every plugin a pure fetch → normalize function, so the same
 * code path runs offline against a fixture (`fixtureFetch`) into a temp record dir.
 * `fileId` defaults to the plugin id; a multi-account instance passes its own id
 * ("spotify-2") so each account keeps its own daily file + journal columns.
 * Rebuilding the SQLite cache is the caller's job (route / CLI), exactly like the
 * GitHub importer.
 */
export async function importPlugin(
  plugin: ImporterPlugin,
  ctx: ImporterContext,
  dir: string = recordDir(),
  fileId: string = plugin.id,
): Promise<PluginImportSummary> {
  if (plugin.requiresCredential && !ctx.fetchImpl && !ctx.credential) {
    throw new Error(`${plugin.name} needs a ${plugin.credentialLabel}.`);
  }
  const result = await plugin.fetch(ctx);
  const merge = mergeDailyCsv(dir, fileId, result.table);

  const extraSources: string[] = [];
  for (const [suffix, table] of Object.entries(result.extraTables ?? {})) {
    if (!table.rows.length) continue;
    const extraId = `${fileId}_${suffix}`;
    mergeDailyCsv(dir, extraId, table);
    extraSources.push(extraId);
  }

  const events = (result.events ?? []).map((e) => ({ ...e, source: e.source ?? fileId }));
  // A mutable-events source (Granola) re-derives its records each sync, so replace
  // its window before appending — otherwise the id dedup would keep the stale copy
  // and a re-summarized meeting would never update on the timeline.
  if (plugin.mutableEvents) {
    removeEventsBySource(fileId, { recordDir: dir, from: ctx.from, to: ctx.to });
  }
  const eventsAdded = events.length ? appendEvents(events, { recordDir: dir }).added : 0;

  return {
    ...merge,
    id: fileId,
    name: plugin.name,
    from: ctx.from,
    to: ctx.to,
    daysWithData: merge.dates.length,
    eventsAdded,
    extraSources,
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

/** POST JSON to a URL and parse the JSON reply — same error shape as getJson.
 *  Used by the few API sources whose list endpoint is a POST (e.g. Notion search). */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    let text = "";
    try {
      text = (await res.text()).trim().slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}${text ? ` — ${text}` : ""}`);
  }
  return res.json();
}

/** Unix seconds for a YYYY-MM-DD day boundary (UTC). endOfDay → 23:59:59. */
export function unixSec(date: string, endOfDay = false): number {
  const t = Date.parse(`${date}T${endOfDay ? "23:59:59" : "00:00:00"}Z`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/** Split a "a:b" combined credential (e.g. Last.fm key:user, Trakt id:token). */
export function splitCredential(cred: string | undefined): [string, string] {
  const raw = (cred ?? "").trim();
  const i = raw.indexOf(":");
  if (i < 0) return [raw, ""];
  return [raw.slice(0, i).trim(), raw.slice(i + 1).trim()];
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

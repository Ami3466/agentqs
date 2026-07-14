import fs from "fs";
import { readConfig, type AppConfig } from "../config";
import {
  appendEvents,
  mergeDailyCsv,
  removeEventsBySource,
  type AppendEventInput,
  type DailyMergeResult,
  type EventItem,
  type MergePolicy,
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
  /** Token-call body encoding — Trakt only accepts JSON. Default form. */
  tokenBody?: "form" | "json";
  /** Extra token-call params — Withings needs action=requesttoken. */
  tokenExtraParams?: Record<string, string>;
  /** Non-standard token reply envelope: "withings" = {status, body:{tokens}},
   *  status !== 0 is an error even on HTTP 200. Default: standard OAuth2 JSON. */
  tokenUnwrap?: "withings";
  /** What syncs use as the credential — Trakt's API wants the app client id
   *  alongside the token, in the plugin's "<client_id>:<token>" format. */
  grantCredential?: "token" | "clientId:token";
  /**
   * Plugins that SHARE ONE GRANT. Google Calendar and Gmail are not two
   * connections to two services, they are one Google account with one key and two
   * products ticked, so both carry `providerKey: "google"` and both read/write
   * `sourceOAuth.google`. Ticking Gmail widens that grant's scope; it never asks
   * for a second credential.
   *
   * Sharing a key is NOT merging surfaces: `gdrive_backup` speaks the same Google
   * OAuth and deliberately does NOT share this key — it is a backup target with a
   * drive.file scope, it lands nothing in the record, and the pipeline is data
   * coming IN. Same dance, different animal.
   *
   * Only the BASE instance shares. A second account ("gcal-2") is a different
   * Google account, so it keeps its own grant under its own id.
   */
  providerKey?: string;
  /** The scope to ASK for, when it depends on what the user checked (Google: the
   *  union over the ticked products). Falls back to the static `scope`. */
  scopeFor?: (cfg: AppConfig | null) => string;
}

/**
 * Where a plugin's OAuth grant lives in `config.sourceOAuth`.
 *
 * Normally its own id. For a shared provider (Google) the BASE instance reads the
 * provider's one grant instead, so Calendar and Gmail are literally the same key.
 * An extra account keeps its own — a second Google account is a second key.
 */
export function oauthGrantKey(plugin: ImporterPlugin, instanceId: string = plugin.id): string {
  if (instanceId !== plugin.id) return instanceId; // extra account → its own grant
  return plugin.oauth?.providerKey ?? plugin.id;
}

export interface ImporterPlugin {
  id: string; // source stem → record/daily/<id>.csv
  name: string; // display name
  detail: string; // one-line description for the Pipeline tab
  /** api sources are auto-syncable; a not-yet-wired adapter would be `false`. */
  live: boolean;
  /**
   * NOT a data source — an EXPORT destination (Google Drive backup) that rides
   * this contract ONLY for its credential machinery: the OAuth dance, the token
   * refresh, `source authorize`, `source test`. The pipeline is data coming IN;
   * a backup is data going OUT, so a backup target NEVER appears in the sources
   * list / Pipeline tab, never writes to the record, and schedules itself under
   * `config.backup.*` instead of `sourceIntervals`. Its face is Settings → Data
   * (`agentqs backup`). A future Google Drive that IMPORTS files would be a
   * separate, ordinary source plugin.
   */
  backupTarget?: boolean;
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
  /** The metric column the Pipeline-tab sparkline / headline number reads.
   *  A `backupTarget` lands nothing in the record, so it has none. */
  primaryMetric?: string;
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
  /** Cheap credential proof for `source test` — a plugin whose real work has a
   *  side effect (a `backupTarget` uploads an archive) MUST set one, so a test
   *  never runs that side effect. Returns the human detail line. */
  probe?(ctx: ImporterContext): Promise<string>;
  /**
   * A HARD CAP on how far one run may reach back, in days — set ONLY when the API
   * itself cannot do better (Gmail counts a day at a time, so a run is bounded).
   *
   * Leave it UNSET and the first import DISCOVERS where your history begins: it
   * walks backwards until the source runs dry (`backfillPlugin` in cli-core). Any
   * fixed number here is a guess about someone else's life — a 10-year default
   * would have quietly clipped 67 days off a calendar that started 2015-09-18, and
   * nobody would ever have known what was missing. Don't guess. Ask the source.
   */
  backfillDays?: number;
  /**
   * How this source's numbers meet the ones already in the record. Default `replace`:
   * the source saw the day whole, so its answer is the answer.
   *
   * Set `max` when the API can only ever hand back a RECENT SLICE and the plugin
   * recomputes a day's total from it — Spotify's last-50 plays, Deezer's last-200,
   * a recency-ordered feed with no date range. Such a source's count for a day can
   * only shrink as its buffer slides past, so replacing on every sync made every day
   * decay toward zero, and ate an imported lifetime export the moment a sync touched
   * one of its days. A shorter look is not news. (Counts only — never a gauge.)
   */
  /**
   * ONE CHEAP QUESTION: does this window hold ANY data at all?
   *
   * The first import walks every year back to the floor, because a gap in a life is
   * not the end of it (see backfillPlugin). For most sources that walk is free — one
   * request a year. For a source where FETCHING a year is expensive (Gmail counts a
   * day at a time: 730 requests) it would not be, so such a source answers this
   * instead, and a quiet decade costs ten questions rather than seven thousand.
   *
   * Only implement it where the fetch is expensive. A source without one just fetches:
   * for those the fetch IS the probe. (Not to be confused with `probe` above, which
   * proves a CREDENTIAL for `source test`.)
   */
  hasAnyData?: (ctx: ImporterContext) => Promise<boolean>;

  mergePolicy?: MergePolicy;
  /**
   * Why this source cannot hand over its full history — shown instead of letting a
   * hard API ceiling read as a broken importer. Spotify's recently-played endpoint
   * returns the last 50 plays and takes no date range at all: no window we send can
   * widen it, and the fix is their account export, not our importer.
   */
  historyNote?: string;
  /** Fetch a window and normalize it into the wide daily table. */
  fetch(ctx: ImporterContext): Promise<ImporterResult>;
}

/** A backfill asks about one year at a time. It NEVER gives up early: it used to stop
 *  after two empty chunks, which mistook a quiet stretch in a life (a job change, a
 *  broken strap, an app you came back to) for the end of one — and everything before
 *  the gap became unreachable by any command, silently, forever. */
export const BACKFILL_CHUNK_DAYS = 365;

/** The walk's absolute stop. Not a guess about any person's history — simply older
 *  than the services themselves (Gmail 2004, Google Calendar 2006, Spotify 2008),
 *  so no real account can begin before it. */
export const BACKFILL_FLOOR = "2000-01-01";

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
  // The shared provider grant first (Google: Calendar and Gmail are one key), then
  // the plugin's own id — which is where a grant minted before the provider key
  // existed still lives, so an already-connected Calendar keeps working untouched.
  const grantKey = oauthGrantKey(plugin, credKey);
  const grant = cfg?.sourceOAuth?.[grantKey] ?? cfg?.sourceOAuth?.[credKey];
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
 * The credential a user pasted, ignoring any OAuth grant.
 *
 * Precedence normally puts the grant first, which is right — until the grant DIES. Then
 * it was a trap: revoke the app at Spotify, the sync fails "reconnect", the connect form
 * offers "or paste a short-lived access token", you paste one, `source test` passes, the
 * form says connected… and every sync still fails, because the sync resolver checked the
 * dead grant first and never reached the token you had just saved. Every surface said
 * connected while the source was permanently broken. This is the rescue path.
 */
export function resolveCredentialWithoutGrant(
  plugin: ImporterPlugin,
  cfg: AppConfig | null,
  credKey: string = plugin.id,
): string | undefined {
  const isBase = credKey === plugin.id;
  if (isBase && plugin.envKey && process.env[plugin.envKey]) return process.env[plugin.envKey];
  return cfg?.sourceCreds?.[credKey]?.trim() || undefined;
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
  /** Exactly what changed in the record — lets the caller patch the SQLite cache
   *  for this sync instead of rebuilding it from the whole record (see
   *  record.refreshSyncCache). */
  appendedEvents: EventItem[];
  eventsReplaced?: { source: string; from: string; to: string };
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
  const merge = mergeDailyCsv(dir, fileId, result.table, { policy: plugin.mergePolicy });

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
  const eventsReplaced = plugin.mutableEvents
    ? { source: fileId, from: ctx.from, to: ctx.to }
    : undefined;
  if (eventsReplaced) {
    removeEventsBySource(fileId, { recordDir: dir, from: ctx.from, to: ctx.to });
  }
  const appended = events.length ? appendEvents(events, { recordDir: dir }) : null;
  const eventsAdded = appended?.added ?? 0;
  const appendedEvents = appended?.items ?? [];

  return {
    ...merge,
    id: fileId,
    name: plugin.name,
    from: ctx.from,
    to: ctx.to,
    daysWithData: merge.dates.length,
    eventsAdded,
    extraSources,
    appendedEvents,
    eventsReplaced,
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

/** undici throws a bare `TypeError: fetch failed` for EVERY transport failure —
 *  DNS not up yet in a cold container, a dropped socket, a refused connection —
 *  and hides the real reason in `.cause`. Unwrapped, it reaches the user as
 *  "Spotify recently-played → fetch failed", which reads like a bad credential
 *  and isn't one. */
function networkCause(e: unknown): string | null {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur instanceof Error; i++) {
    const code = (cur as NodeJS.ErrnoException).code;
    parts.push(code ? `${code} ${cur.message}` : cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  const text = parts.join(" ← ");
  return /fetch failed|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|UND_ERR|terminated/i.test(text)
    ? text
    : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Statuses that mean "ask me again", not "no": the API is rate-limiting us (429)
 *  or briefly unwell (5xx). A history walk makes thousands of calls, so it WILL
 *  meet one — and aborting a half-hour backfill over a blip the server itself told
 *  us to wait out would read as "the source is broken". Any other 4xx is a real
 *  answer (bad credential, bad request) and must surface at once. */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/** How long to wait before retrying — the server's own `Retry-After` if it sent
 *  one (capped, so a hostile header can't park a sync for an hour), else backoff. */
function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers?.get?.("retry-after");
  const secs = header ? Number(header) : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
  return 500 * 2 ** attempt;
}

/** One HTTP call, with the transport handling every importer needs: a network
 *  failure or a rate-limit is RETRIED (the first sync right after an OAuth connect
 *  hits a container whose DNS may still be warming up — one blip must not fail the
 *  connect), and if it still fails the thrown message names the host and the
 *  real cause. Non-network errors (a fixture's "unexpected URL") pass through
 *  untouched, so tests still fail loudly. */
export async function netFetch(
  url: string,
  init: Parameters<FetchLike>[1],
  fetchImpl: FetchLike,
  attempts = 3,
): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, init);
      if (RETRY_STATUS.has(res.status) && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, retryAfterMs(res, i)));
        continue;
      }
      return res;
    } catch (e) {
      last = e;
      if (!networkCause(e)) break;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
  }
  const cause = networkCause(last);
  if (cause) throw new Error(`could not reach ${hostOf(url)} (${cause}) — network failure, not a bad credential`);
  throw last;
}

/** One page of a paginated API: the items, and how to ask for the next page.
 *  `next` is whatever that API's cursor happens to be — a page number, an offset,
 *  an opaque token, a `max_id`. Falsy means there is no more. */
export interface Page<T> {
  items: T[];
  next?: string | number | null;
}

/**
 * FOLLOW A PAGINATED API TO ITS END.
 *
 * The single most expensive bug in this codebase: thirteen of eighteen importers
 * asked for one page and treated it as the whole answer. Nothing was broken, nothing
 * errored, nothing was empty — the record just quietly held a fraction of a life.
 * Last.fm returned 200 of a year's ~10,000 scrobbles; Strava returned the newest 200
 * activities of each year, so every January through August simply did not exist;
 * Calendar stopped at 2,500 events and the rest of that year's meetings never
 * happened. Each one reported `ok`.
 *
 * There is no clever fix for that, only a boring one every source must use. So: this.
 *
 * A short page (or no cursor) ends the walk — that is the API saying "that's all".
 * Running out of PAGES does not: hitting the ceiling while the API still offers a
 * next cursor THROWS, because the one thing we must never do is stop early and call
 * it success. A loud failure sends someone to narrow the window; a quiet one edits
 * their history.
 */
export async function pageAll<T>(
  label: string,
  fetchPage: (cursor: string | number | undefined, page: number) => Promise<Page<T>>,
  maxPages = MAX_PAGES,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | number | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const { items, next } = await fetchPage(cursor, page);
    out.push(...items);
    if (!next || items.length === 0) return out; // the API says that is all
    cursor = next;
  }
  throw new Error(
    `${label}: the API still had more after ${maxPages} pages (${out.length} items). ` +
      "Refusing to land a partial history as if it were whole — re-run with a narrower window (--days).",
  );
}

/** A runaway guard, NOT a window: at 200 pages even a 200-per-page API has served
 *  40,000 items for one chunk. Reaching it throws (see pageAll) — it never truncates. */
export const MAX_PAGES = 200;

/**
 * Cut [from, to] into sub-windows of at most `maxDays`, for an API that REFUSES a
 * longer range (Todoist and Toggl both cap a request at roughly three months).
 *
 * This is not a window and not a cap: the caller still asks for every day it was
 * asked for, just in mouthfuls the API will accept. Todoist's own file said "the
 * window is capped by Todoist at ~3 months per request" — and then sent it the whole
 * 365-day backfill chunk anyway, which the API either rejects or silently clamps. A
 * ceiling you know about and ignore is the same as one you never looked for.
 */
export function windowChunks(from: string, to: string, maxDays: number): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  let cur = Date.parse(`${from}T00:00:00Z`);
  if (!Number.isFinite(cur) || !Number.isFinite(end) || cur > end) return [{ from, to }];
  while (cur <= end) {
    const stop = Math.min(cur + (maxDays - 1) * 86_400_000, end);
    out.push({
      from: new Date(cur).toISOString().slice(0, 10),
      to: new Date(stop).toISOString().slice(0, 10),
    });
    cur = stop + 86_400_000;
  }
  return out;
}

/**
 * Map over items with at most `limit` calls in flight. An importer that must ask
 * the API once PER DAY (Gmail counts a day at a time) does years of history in
 * thousands of round-trips: serially that is hours of latency and nothing else,
 * which is precisely why Gmail was capped at 400 days and a lifetime stayed out
 * of reach. Order is preserved; the first rejection wins.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** GET a URL and parse JSON, surfacing a short error body like the GitHub client. */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const res = await netFetch(url, { headers }, fetchImpl);
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).trim().slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}${body ? ` — ${body}` : ""}`);
  }
  // A 200 with an EMPTY BODY is a real answer, not a crash. Gmail does exactly this:
  // ask for a day with no mail while a `fields` mask is set and it returns 200 with
  // nothing at all — res.json() then throws "Unexpected end of JSON input" and takes
  // the whole sync down, on a quiet Tuesday, which reads as "Gmail is broken".
  // An empty body means an empty result; say so.
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${res.status} returned a body that is not JSON — ${text.trim().slice(0, 120)}`);
  }
}

/** POST JSON to a URL and parse the JSON reply — same error shape as getJson.
 *  Used by the few API sources whose list endpoint is a POST (e.g. Notion search). */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const res = await netFetch(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
    },
    fetchImpl,
  );
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

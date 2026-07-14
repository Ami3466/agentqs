import fs from "fs";
import path from "path";
import { mergeDailyCsv } from "../record";
import type { AppConfig } from "../config";
import { num, type DailyTable, type FetchLike } from "./plugin";

/**
 * WHOOP — the differentiator, connected the UNOFFICIAL way.
 *
 * Not the official public API (daily summary only). This drives the same
 * reverse-engineered mobile-app auth the WHOOP app itself uses: you hand it your
 * email + password, it exchanges them for a bearer token, then pulls the app's
 * private endpoints for per-cycle metrics and the PER-MINUTE heart-rate stream.
 *
 * WHOOP moved this whole surface off api-7.whoop.com (now deleted from DNS) onto
 * api.prod.whoop.com/auth-service. Same username+password login, new host — the
 * exact endpoints the WHOOP web/mobile app calls today (verified against the
 * maintained `whoop-data` client):
 *
 *   POST /auth-service/v2/whoop/sign-in            {username,password} → access+refresh
 *   GET  /auth-service/v2/user                     → { user: { id } }
 *   GET  /core-details-bff/v0/cycles/details?id=…  → recovery, HRV, resting HR, strain, sleep
 *   GET  /metrics-service/v1/metrics/user/{id}?step=60&name=heart_rate → PER-MINUTE HR
 *
 * The per-cycle metrics roll up into record/daily/whoop.csv (the daily table the
 * agent reasons over); the per-minute heart-rate stream is written verbatim to
 * record/whoop/hr/<date>.csv — a granularity no journaling app captures. The
 * email + password are stored (config 0600) and re-used to mint a fresh bearer
 * whenever the cached one is stale, so the scheduled pull never silently dies.
 *
 * The whole pipeline (auth → fetch → normalize → merge → rebuild) is injectable
 * via `fetchImpl`, so it runs offline against a fixture — the same trick GitHub
 * uses to make its ships-when test network-free.
 */

const API_BASE = "https://api.prod.whoop.com";
const AUTH_URL = `${API_BASE}/auth-service/v2/whoop/sign-in`;
const USER_URL = `${API_BASE}/auth-service/v2/user`;
const API_VERSION = "7"; // every authed data call carries apiVersion=7, like the app
/** Per-minute heart rate is heavy (~1440 rows/day); default to a recent window. */
const DEFAULT_HR_DAYS = 14;
const HR_STEP_SECONDS = 60; // 60 = per-minute (6 = per-6s, the app's finest)
/** All-time backfill: how far back the walk may go. WHOOP shipped to consumers in
 *  2015, so nothing predates this. */
const ALL_TIME_FLOOR = "2015-01-01";
/** The walk steps back in windows this wide, and gives up after this many in a row
 *  come back empty (~1 year of silence) — long enough to stride over a break from
 *  the strap, short enough not to grind back to 2015 for a 2024 account. */
const BACKFILL_WINDOW_DAYS = 180;

/** Stored WHOOP credentials — kept in config.json (mode 0600, never committed).
 *  The password is retained so a scheduled pull can re-auth once a refresh token
 *  expires; tokens are cached to avoid logging in on every sync. */
export interface WhoopCreds {
  email: string;
  password?: string;
  refreshToken?: string;
  accessToken?: string;
  userId?: number;
  tokenExpiresAt?: string; // ISO
}

/** The base WHOOP account keeps id "whoop"; extras are "whoop-2", "whoop-3", …
 *  each with their own login, daily file and per-minute stream. */
export const WHOOP_BASE_ID = "whoop";
export function isWhoopInstance(id: string): boolean {
  return id === WHOOP_BASE_ID || /^whoop-\d+$/.test(id);
}

/** Read the stored login for a WHOOP account. The base lives in `whoopCreds`
 *  (back-compat); extras live under `whoopCredsByInstance[id]`. */
export function whoopCredsFor(cfg: AppConfig | null, instanceId: string = WHOOP_BASE_ID): WhoopCreds | undefined {
  if (!cfg) return undefined;
  if (instanceId === WHOOP_BASE_ID) return cfg.whoopCreds ?? cfg.whoopCredsByInstance?.[WHOOP_BASE_ID];
  return cfg.whoopCredsByInstance?.[instanceId];
}

/** Persist the login for a WHOOP account, in the slot that matches its id. */
export function setWhoopCreds(cfg: AppConfig, instanceId: string, creds: WhoopCreds): void {
  if (instanceId === WHOOP_BASE_ID) {
    cfg.whoopCreds = creds;
    return;
  }
  cfg.whoopCredsByInstance = { ...(cfg.whoopCredsByInstance ?? {}), [instanceId]: creds };
}

/** Forget a WHOOP account's login (disconnect / remove). */
export function clearWhoopCreds(cfg: AppConfig, instanceId: string): void {
  if (instanceId === WHOOP_BASE_ID) {
    delete cfg.whoopCreds;
    if (cfg.whoopCredsByInstance) delete cfg.whoopCredsByInstance[WHOOP_BASE_ID];
    return;
  }
  if (cfg.whoopCredsByInstance) delete cfg.whoopCredsByInstance[instanceId];
}

/** True when the stored login can (re)authenticate — email + password or a token. */
export function whoopHasCredential(creds: WhoopCreds | undefined): boolean {
  return Boolean(creds?.email && (creds.password || creds.refreshToken));
}

/** A live, usable auth session (what fetch calls need). */
export interface WhoopSession {
  accessToken: string;
  refreshToken: string;
  userId: number;
  expiresAt: string; // ISO
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  user?: { id?: number };
}

// ---- auth (the unofficial app login) --------------------------------------

/** GET the profile to resolve the numeric user id — sign-in may not include it,
 *  so it's fetched separately (exactly what the WHOOP app does after login). */
async function resolveUserId(token: string, fromBody: number | undefined, fetchImpl: FetchLike): Promise<number> {
  if (fromBody != null) return fromBody;
  const raw = (await getAuthed(USER_URL, token, fetchImpl)) as { user?: { id?: number }; id?: number };
  const id = raw?.user?.id ?? raw?.id;
  if (id == null) throw new Error("WHOOP profile returned no user id — the app auth may have changed.");
  return Number(id);
}

/**
 * Sign in with email + password at the app's live auth endpoint
 * (api.prod.whoop.com/auth-service/v2/whoop/sign-in), returning the bearer
 * session. This is the SAME username+password login the WHOOP app uses; it
 * simply moved off the deleted api-7 host. A network failure names itself (never
 * "wrong password"); a 401/403 is the credential.
 */
async function signIn(username: string, password: string, fetchImpl: FetchLike): Promise<WhoopSession> {
  let res: Response;
  try {
    res = await fetchImpl(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch (e) {
    throw new Error(
      `WHOOP login → could not reach ${new URL(AUTH_URL).host} (${(e as Error).message}) — a network/DNS failure, not your password.`,
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).trim().slice(0, 160);
    } catch {
      /* ignore */
    }
    const hint = res.status === 401 || res.status === 403 ? " — wrong email or password?" : "";
    throw new Error(`WHOOP login → ${res.status}${hint}${detail ? ` — ${detail}` : ""}`);
  }
  const j = (await res.json()) as TokenResponse & { accessToken?: string; refreshToken?: string };
  const access = j.access_token ?? j.accessToken;
  const refresh = j.refresh_token ?? j.refreshToken ?? "";
  if (!access) throw new Error("WHOOP login returned no access token — the app auth may have changed.");
  const userId = await resolveUserId(access, j.user?.id ?? undefined, fetchImpl);
  const ttl = Number.isFinite(j.expires_in) ? (j.expires_in as number) : 2700; // ~45m default
  return {
    accessToken: access,
    refreshToken: refresh,
    userId,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  };
}

/** Exchange email + password for a bearer session (the app's username+password login). */
export function whoopLogin(email: string, password: string, fetchImpl: FetchLike = fetch): Promise<WhoopSession> {
  return signIn(email, password, fetchImpl);
}

/**
 * Resolve a usable session from stored creds:
 *   cached token still valid → reuse (no network) · else sign in with email+password.
 * There is no separate refresh endpoint on the auth-service; like the WHOOP app,
 * a stale token is replaced by a fresh sign-in. Returns the session plus the
 * creds to persist (with the rotated token).
 */
export async function ensureSession(
  creds: WhoopCreds,
  fetchImpl: FetchLike = fetch,
): Promise<{ session: WhoopSession; creds: WhoopCreds }> {
  const validCache =
    creds.accessToken &&
    creds.userId != null &&
    creds.tokenExpiresAt &&
    new Date(creds.tokenExpiresAt).getTime() - Date.now() > 120_000;
  if (validCache) {
    return {
      session: {
        accessToken: creds.accessToken!,
        refreshToken: creds.refreshToken ?? "",
        userId: creds.userId!,
        expiresAt: creds.tokenExpiresAt!,
      },
      creds,
    };
  }
  if (!creds.email || !creds.password) {
    throw new Error("WHOOP needs your email + password to (re)connect.");
  }
  const session = await signIn(creds.email, creds.password, fetchImpl);
  return { session, creds: mergeTokens(creds, session) };
}

/** Fold a fresh session's tokens back into the stored creds. */
export function mergeTokens(creds: WhoopCreds, session: WhoopSession): WhoopCreds {
  return {
    ...creds,
    refreshToken: session.refreshToken,
    accessToken: session.accessToken,
    userId: session.userId,
    tokenExpiresAt: session.expiresAt,
  };
}

// ---- data fetch (the app's private endpoints) -----------------------------

async function getAuthed(url: string, token: string, fetchImpl: FetchLike): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).trim().slice(0, 160);
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  return res.json();
}

function dayBounds(from: string, to: string): { start: string; end: string } {
  return { start: `${from}T00:00:00.000Z`, end: `${to}T23:59:59.999Z` };
}

/**
 * One record from the cycles-details BFF feed. Recovery/HRV/resting-HR sit on a
 * nested `recovery` object; strain + day HR + kilojoules are on the nested
 * `cycle`; sleep is per event under `sleeps`. `cycle.days` is a stringified range —
 * "['2026-06-01T…','2026-06-02T…')" — whose first element is the cycle's date.
 *
 * WHOOP moved recovery off the record root (it used to be a flat `score` /
 * `hrv_rmssd_milli` / `resting_heart_rate`) and now reports HRV in SECONDS
 * (`hrv_rmssd: 0.0646` = 64.6 ms). Reading the old flat fields silently yielded
 * empty cells, so recovery/HRV/resting HR vanished from the daily table while
 * strain and sleep — read from the nested objects — kept landing. Both shapes are
 * accepted so a fixture recorded against either payload still parses.
 */
export interface WhoopCycle {
  /** Current shape: recovery lives here. */
  recovery?: {
    recovery_score?: number; // 0–100
    hrv_rmssd?: number; // SECONDS (×1000 → ms)
    resting_heart_rate?: number;
  };
  /** Legacy flat shape (pre-2026 payloads). */
  score?: number;
  hrv_rmssd_milli?: number; // HRV, already in milliseconds
  resting_heart_rate?: number;
  cycle?: {
    days?: string;
    scaled_strain?: number;
    day_avg_heart_rate?: number;
    day_max_heart_rate?: number;
    day_kilojoules?: number;
  };
  sleeps?: { score?: number; quality_duration?: number }[];
}

/** First calendar date out of the cycle's stringified `days` range. */
function cycleDate(days: string | undefined): string {
  if (!days) return "";
  return days.replace(/^\[/, "").split(",")[0].replace(/['"]/g, "").trim().slice(0, 10);
}

/** WHOOP caps a cycles-details page; walk the window in ≤25-day chunks (each well
 *  under one page) so a 90-day sync never silently drops the oldest days. */
function* chunkWindow(from: string, to: string, days = 25): Generator<{ from: string; to: string }> {
  let cur = from;
  while (cur <= to) {
    const end = new Date(`${cur}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + days - 1);
    const chunkTo = end.toISOString().slice(0, 10);
    yield { from: cur, to: chunkTo < to ? chunkTo : to };
    const next = new Date(`${chunkTo}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cur = next.toISOString().slice(0, 10);
  }
}

/** Pull recovery / strain / sleep cycles for the window (the app's cycles-details
 *  BFF feed on api.prod.whoop.com), paginated so nothing is dropped. */
export async function fetchCycles(
  userId: number,
  token: string,
  from: string,
  to: string,
  fetchImpl: FetchLike = fetch,
): Promise<WhoopCycle[]> {
  const all: WhoopCycle[] = [];
  for (const win of chunkWindow(from, to)) {
    const { start, end } = dayBounds(win.from, win.to);
    const url = new URL(`${API_BASE}/core-details-bff/v0/cycles/details`);
    url.searchParams.set("id", String(userId));
    url.searchParams.set("startTime", start);
    url.searchParams.set("endTime", end);
    url.searchParams.set("limit", "26");
    url.searchParams.set("apiVersion", API_VERSION);
    let raw: unknown;
    try {
      raw = await getAuthed(url.toString(), token, fetchImpl);
    } catch (e) {
      throw new Error(`WHOOP cycles → ${(e as Error).message}`);
    }
    // The BFF returns either a bare array or { records: [...] } / { cycles: [...] }.
    const page = Array.isArray(raw)
      ? (raw as WhoopCycle[])
      : ((raw as { records?: WhoopCycle[]; cycles?: WhoopCycle[] }).records ??
         (raw as { cycles?: WhoopCycle[] }).cycles ??
         []);
    all.push(...page);
  }
  return all;
}

/**
 * EVERY cycle the account has ever recorded. WHOOP exposes no "account created"
 * date, so the start is discovered: step back from `to` in windows and stop once
 * the floor is hit. It does NOT stop at a quiet stretch — a gap is not an ending.
 *
 * Emptiness is judged on IN-RANGE cycles only. WHOOP answers a window it has no
 * data for with its newest cycles anyway (dated outside it), so counting the raw
 * response would walk back to 2015 on every account.
 *
 * This is what a FIRST import runs: pulling "the last 90 days" of a lifetime of
 * data is not an import, and for an account that stopped recording a year ago it
 * lands nothing at all.
 */
export async function fetchAllCycles(
  userId: number,
  token: string,
  to: string,
  fetchImpl: FetchLike = fetch,
  floor: string = ALL_TIME_FLOOR,
): Promise<WhoopCycle[]> {
  const out: WhoopCycle[] = [];
  const seen = new Set<string>(); // a cycle can repeat across window edges

  // Start the walk at the account's NEWEST cycle, not at today. A strap that
  // stopped a year ago would otherwise burn through the empty-window budget before
  // reaching any data and conclude the account is empty. WHOOP answers even a
  // window it has nothing for with its newest cycles, so one probe locates them.
  const probe = await fetchCycles(userId, token, shiftDate(to, -(BACKFILL_WINDOW_DAYS - 1)), to, fetchImpl);
  const newest = latestCycleDate(probe);
  let cursor = newest && newest < to ? newest : to;
  // TO THE FLOOR, with no early exit. This used to give up after two empty 180-day
  // windows — i.e. after ONE QUIET YEAR — and its own comment called that "long enough
  // to stride over a break from the strap". It is not. An athlete who stopped wearing
  // it for fourteen months (an injury, a switch to an Oura, a lost charger) came back,
  // connected, and the walk stopped dead at the gap: every year of WHOOP data BEFORE
  // the break was silently absent, the earliest day in the record read as the start of
  // the account, and the sync reported ok. You cannot tell a gap from an ending by
  // looking at the gap. One window per 180 days back to the floor is a few dozen cheap
  // requests — a rounding error against losing half of someone's history.
  while (cursor >= floor) {
    const from = maxDate(shiftDate(cursor, -(BACKFILL_WINDOW_DAYS - 1)), floor);
    const page = await fetchCycles(userId, token, from, cursor, fetchImpl);
    for (const c of page) {
      const day = cycleDate(c.cycle?.days);
      if (!day || day < from || day > cursor) continue; // out-of-range filler
      if (seen.has(day)) continue;
      seen.add(day);
      out.push(c);
    }
    cursor = shiftDate(from, -1);
  }
  return out;
}

/** The later of two ISO dates. */
function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

export interface HrSample {
  time: number; // epoch ms
  bpm: number;
}

/**
 * Pull the PER-MINUTE heart-rate stream (step=60s) — the differentiator. The
 * metrics endpoint rejects any request spanning more than 192 hours (8 days),
 * so the window is walked in ≤7-day chunks and concatenated; a 14-day (or larger)
 * HR backfill simply becomes several calls.
 */
export async function fetchHeartRate(
  userId: number,
  token: string,
  from: string,
  to: string,
  fetchImpl: FetchLike = fetch,
  stepSeconds: number = HR_STEP_SECONDS,
): Promise<HrSample[]> {
  const out: HrSample[] = [];
  for (const win of chunkWindow(from, to, 7)) {
    const { start, end } = dayBounds(win.from, win.to);
    const url = new URL(`${API_BASE}/metrics-service/v1/metrics/user/${userId}`);
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("step", String(stepSeconds));
    url.searchParams.set("name", "heart_rate");
    url.searchParams.set("apiVersion", API_VERSION);
    let raw: unknown;
    try {
      raw = await getAuthed(url.toString(), token, fetchImpl);
    } catch (e) {
      throw new Error(`WHOOP heart rate → ${(e as Error).message}`);
    }
    const values = (raw as { values?: { time?: number; data?: number }[] })?.values ?? [];
    for (const v of values) {
      if (v?.time == null || v?.data == null) continue;
      const bpm = Number(v.data);
      if (!Number.isFinite(bpm) || bpm <= 0) continue; // WHOOP marks gaps as 0
      out.push({ time: Number(v.time), bpm });
    }
  }
  return out;
}

// ---- normalize ------------------------------------------------------------

interface DailyCycle {
  recovery: string;
  hrv: string;
  resting_hr: string;
  strain: string;
  sleep_hours: string;
  sleep_perf: string;
}

/** Bucket cycle records into one summary per calendar day. Field names follow the
 *  cycles-details BFF payload: recovery/HRV/resting-HR on the nested `recovery`
 *  object (flat root fields are the legacy fallback), strain on `cycle`, sleep
 *  under `sleeps` (the longest event is the night's sleep). */
export function normalizeCycles(cycles: WhoopCycle[], from: string, to: string): Map<string, DailyCycle> {
  const byDay = new Map<string, DailyCycle>();
  for (const c of cycles) {
    const cyc = c.cycle ?? {};
    const day = cycleDate(cyc.days);
    if (!day || day < from || day > to) continue;
    // The main sleep is the longest event of the cycle (naps are shorter).
    const sleep = (c.sleeps ?? [])
      .slice()
      .sort((a, b) => (b.quality_duration ?? 0) - (a.quality_duration ?? 0))[0] ?? {};
    const rec = c.recovery ?? {};
    // HRV arrives in seconds on the nested object and in ms on the legacy root —
    // the daily column is milliseconds either way.
    const hrvMs = rec.hrv_rmssd != null ? rec.hrv_rmssd * 1000 : c.hrv_rmssd_milli;
    const recoveryScore = rec.recovery_score ?? c.score;
    const restingHr = rec.resting_heart_rate ?? c.resting_heart_rate;
    byDay.set(day, {
      recovery: recoveryScore != null ? num(recoveryScore) : "",
      hrv: hrvMs != null ? num(hrvMs) : "",
      resting_hr: restingHr != null ? num(restingHr) : "",
      strain: cyc.scaled_strain != null ? num(cyc.scaled_strain) : "",
      sleep_hours: sleep.quality_duration != null ? num(sleep.quality_duration / 3_600_000) : "",
      sleep_perf: sleep.score != null ? num(sleep.score) : "",
    });
  }
  return byDay;
}

interface DailyHr {
  hr_avg: string;
  hr_max: string;
}

/** Group per-minute samples by date; return the file rows + daily avg/max rollup. */
export function bucketHeartRate(samples: HrSample[]): {
  files: Map<string, string[][]>; // date → [[iso, bpm], ...]
  daily: Map<string, DailyHr>;
} {
  const byDay = new Map<string, HrSample[]>();
  for (const s of samples) {
    const day = new Date(s.time).toISOString().slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(s);
    byDay.set(day, list);
  }
  const files = new Map<string, string[][]>();
  const daily = new Map<string, DailyHr>();
  for (const [day, list] of byDay) {
    list.sort((a, b) => a.time - b.time);
    files.set(day, list.map((s) => [new Date(s.time).toISOString(), String(s.bpm)]));
    const sum = list.reduce((acc, s) => acc + s.bpm, 0);
    const max = list.reduce((acc, s) => Math.max(acc, s.bpm), 0);
    daily.set(day, { hr_avg: num(sum / list.length), hr_max: num(max) });
  }
  return { files, daily };
}

// ---- write ----------------------------------------------------------------

const DAILY_HEADER = [
  "date",
  "recovery",
  "hrv",
  "resting_hr",
  "strain",
  "sleep_hours",
  "sleep_perf",
  "hr_avg",
  "hr_max",
];

function buildDailyTable(
  cycles: Map<string, DailyCycle>,
  hr: Map<string, DailyHr>,
): DailyTable {
  const dates = [...new Set([...cycles.keys(), ...hr.keys()])].sort();
  const rows = dates.map((d) => {
    const c = cycles.get(d);
    const h = hr.get(d);
    return [
      d,
      c?.recovery ?? "",
      c?.hrv ?? "",
      c?.resting_hr ?? "",
      c?.strain ?? "",
      c?.sleep_hours ?? "",
      c?.sleep_perf ?? "",
      h?.hr_avg ?? "",
      h?.hr_max ?? "",
    ];
  });
  return { header: DAILY_HEADER, rows };
}

/** Directory the per-minute heart-rate files live in (inside the git record).
 *  One dir per account: record/whoop/hr for the base, record/whoop-2/hr, … */
export function whoopHrDir(recordDir: string, instanceId: string = WHOOP_BASE_ID): string {
  return path.join(recordDir, instanceId, "hr");
}

/** Write one per-minute CSV per day; overwrite (idempotent). Returns minute count. */
function writeHeartRateFiles(recordDir: string, files: Map<string, string[][]>, instanceId: string): number {
  const dir = whoopHrDir(recordDir, instanceId);
  if (files.size === 0) return 0;
  fs.mkdirSync(dir, { recursive: true });
  let minutes = 0;
  for (const [day, rows] of files) {
    const csv = ["time,bpm", ...rows.map((r) => r.join(","))].join("\n") + "\n";
    fs.writeFileSync(path.join(dir, `${day}.csv`), csv, "utf8");
    minutes += rows.length;
  }
  return minutes;
}

// ---- high-level import ----------------------------------------------------

export interface ImportWhoopSummary {
  creds: WhoopCreds; // updated tokens to persist
  userId: number;
  from: string;
  to: string;
  hrFrom: string;
  hrTo: string;
  daysWithData: number;
  metrics: string[];
  cells: number;
  minutes: number; // per-minute HR samples captured
  hrDays: number; // distinct days with a per-minute file
  file: string;
  /** The account's newest cycle, when its data ends BEFORE the window that was
   *  asked for (a strap that stopped recording). The pull re-anchors to it, and
   *  the caller reports it — a dormant account must never sync "ok" with nothing. */
  latestCycle?: string;
  /** True when the requested window held nothing and the pull re-anchored to
   *  `latestCycle`. */
  reanchored?: boolean;
}

/** The newest calendar date present in a cycles response. */
export function latestCycleDate(cycles: WhoopCycle[]): string | null {
  const days = cycles.map((c) => cycleDate(c.cycle?.days)).filter((d): d is string => Boolean(d));
  return days.length ? days.sort().at(-1)! : null;
}

/** Shift an ISO date by n days (negative = back). */
function shiftDate(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days spanned by [from..to], inclusive. */
function spanDays(from: string, to: string): number {
  const ms = new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime();
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

/** Trailing window [from..to] narrowed to the last `days` for the heavy HR pull. */
function hrWindow(from: string, to: string, days: number): { hrFrom: string; hrTo: string } {
  const end = new Date(`${to}T00:00:00Z`);
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - (Math.max(1, days) - 1));
  const hrFrom = start.toISOString().slice(0, 10);
  return { hrFrom: hrFrom < from ? from : hrFrom, hrTo: to };
}

/**
 * Full unofficial pull: auth → cycles + per-minute HR → merge daily/<id>.csv +
 * write record/<id>/hr/<date>.csv. `instanceId` (default "whoop") is the account —
 * a second athlete syncs as "whoop-2" into its own files. Rebuilding the SQLite
 * cache is the caller's job (route / CLI), exactly like the other importers.
 */
export async function importWhoop(opts: {
  creds: WhoopCreds;
  from: string;
  to: string;
  recordDir: string;
  instanceId?: string;
  hrDays?: number;
  /** Take the account's ENTIRE history, ignoring `from` (what a first import does).
   *  The per-minute HR stream stays capped at `hrDays` — years of it is gigabytes. */
  allTime?: boolean;
  fetchImpl?: FetchLike;
}): Promise<ImportWhoopSummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const instanceId = opts.instanceId ?? WHOOP_BASE_ID;
  const { session, creds } = await ensureSession(opts.creds, fetchImpl);

  let from = opts.from;
  let to = opts.to;
  let cycles: WhoopCycle[];
  let dailyCycles: Map<string, DailyCycle>;
  let reanchored = false;

  if (opts.allTime) {
    // The FIRST import of an account takes everything it has ever recorded —
    // "the last 90 days" of a lifetime of data is not an import.
    cycles = await fetchAllCycles(session.userId, session.accessToken, to, fetchImpl);
    const earliest = cycles.map((c) => cycleDate(c.cycle?.days)).filter(Boolean).sort()[0];
    from = earliest || from;
    dailyCycles = normalizeCycles(cycles, from, to);
  } else {
    cycles = await fetchCycles(session.userId, session.accessToken, from, to, fetchImpl);
    dailyCycles = normalizeCycles(cycles, from, to);

    // A window anchored to TODAY finds nothing on an account whose strap stopped
    // recording months ago — it imported zero days and still reported "ok", which
    // reads as "WHOOP gives no data". WHOOP hands back its newest cycles even when
    // the asked-for window is empty, so use them: re-anchor the SAME span to end on
    // the account's real last day. A daily-worn account never takes this path.
    const newest = latestCycleDate(cycles);
    if (dailyCycles.size === 0 && newest && newest < from) {
      const span = spanDays(from, to);
      from = shiftDate(newest, -(span - 1));
      to = newest;
      cycles = await fetchCycles(session.userId, session.accessToken, from, to, fetchImpl);
      dailyCycles = normalizeCycles(cycles, from, to);
      reanchored = true;
    }
  }
  const latestCycle = latestCycleDate(cycles) ?? undefined;

  // The per-minute stream is heavy (~1440 rows/day), so it stays capped at hrDays —
  // but it must hang off the last day that HAS data, not off today, or a dormant
  // account pulls an empty minute window while its cycles land fine.
  const lastDataDay = [...dailyCycles.keys()].sort().at(-1) ?? to;
  const { hrFrom, hrTo } = hrWindow(from, lastDataDay, opts.hrDays ?? DEFAULT_HR_DAYS);
  const samples = await fetchHeartRate(session.userId, session.accessToken, hrFrom, hrTo, fetchImpl);
  const { files, daily: dailyHr } = bucketHeartRate(samples);
  const minutes = writeHeartRateFiles(opts.recordDir, files, instanceId);

  const table = buildDailyTable(dailyCycles, dailyHr);
  const merge = mergeDailyCsv(opts.recordDir, instanceId, table);

  return {
    creds,
    userId: session.userId,
    from,
    to,
    hrFrom,
    hrTo,
    daysWithData: merge.dates.length,
    metrics: merge.metrics,
    cells: merge.cells,
    minutes,
    hrDays: files.size,
    file: merge.file,
    latestCycle,
    reanchored,
  };
}

// ---- offline fixture (auth + cycles + HR in one routed stand-in) ----------

/**
 * A fetch stand-in that answers all four live endpoints (sign-in, user, cycles
 * details, heart_rate) from in-memory data — so the whole auth → pull → merge
 * pipeline runs with no network. `onCall` (optional) records each URL for
 * assertions. The sign-in body carries the user id so no extra profile call is
 * needed (the real endpoint may or may not include it).
 */
export function whoopFixtureFetch(data: {
  userId?: number;
  cycles?: WhoopCycle[];
  heartRate?: { time: number; data: number }[];
  onCall?: (url: string) => void;
}): FetchLike {
  const userId = data.userId ?? 1234567;
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    data.onCall?.(url);
    let body: unknown;
    if (url.includes("/whoop/sign-in")) {
      body = {
        access_token: `tok-${Date.now()}`,
        refresh_token: "refresh-abc",
        user: { id: userId },
      };
    } else if (url.includes("/auth-service/v2/user")) {
      body = { user: { id: userId } };
    } else if (url.includes("/metrics-service/") || url.includes("/metrics/user")) {
      body = { values: data.heartRate ?? [] };
    } else if (url.includes("/cycles/details") || url.includes("/cycles")) {
      body = data.cycles ?? [];
    } else {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as FetchLike;
}

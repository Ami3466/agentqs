import fs from "fs";
import path from "path";
import { mergeDailyCsv } from "../record";
import { num, type DailyTable, type FetchLike } from "./plugin";

/**
 * WHOOP — the differentiator, connected the UNOFFICIAL way.
 *
 * Not the official public API (daily summary only). This drives the same
 * reverse-engineered mobile-app auth the WHOOP app itself uses: you hand it your
 * email + password, it exchanges them for a bearer token at
 *
 *   POST https://api-7.whoop.com/oauth/token   (grant_type=password → access + refresh)
 *
 * then pulls the app's private endpoints:
 *
 *   GET  /users/{id}/cycles                     → recovery, HRV, resting HR, strain, sleep
 *   GET  /users/{id}/metrics/heart_rate?step=60 → PER-MINUTE heart rate
 *
 * The per-cycle metrics roll up into record/daily/whoop.csv (the daily table the
 * agent reasons over); the per-minute heart-rate stream is written verbatim to
 * record/whoop/hr/<date>.csv — a granularity no journaling app captures. Tokens
 * are cached + refreshed; the email + password are re-used only to re-auth when a
 * refresh token expires, so the scheduled pull never silently dies.
 *
 * The whole pipeline (auth → fetch → normalize → merge → rebuild) is injectable
 * via `fetchImpl`, so it runs offline against a fixture — the same trick GitHub
 * uses to make its ships-when test network-free.
 */

const AUTH_URL = "https://api-7.whoop.com/oauth/token";
const API_BASE = "https://api-7.whoop.com";
/** Per-minute heart rate is heavy (~1440 rows/day); default to a recent window. */
const DEFAULT_HR_DAYS = 14;
const HR_STEP_SECONDS = 60; // 60 = per-minute (6 = per-6s, the app's finest)

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

/** WHOOP retired the unofficial app-login door (July 2026): api-7.whoop.com was
 *  deleted from DNS, the api.prod.whoop.com replacement answers "api-server path
 *  is disabled", and their Auth0 login sits behind a Cloudflare browser
 *  challenge. A network/404 failure here is THAT, not the user's password —
 *  say so, and point at the connect that works. */
/** When the login host can't be reached, say THAT — never "wrong password". The
 *  distinction matters: a 401 is your credentials, an unreachable host is not,
 *  and the two must never be reported as the same thing. */
const RETIRED_HINT =
  "could not reach api-7.whoop.com (the host does not resolve from this machine) — this is a network/DNS failure, NOT your password. " +
  "If it resolves for you elsewhere, the login itself is unchanged; the official WHOOP API row (OAuth) is the other way in.";

async function postToken(body: Record<string, unknown>, fetchImpl: FetchLike): Promise<WhoopSession> {
  let res: Response;
  try {
    res = await fetchImpl(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // DNS/connection failure on a deleted host — the endpoint is gone, not flaky.
    throw new Error(`WHOOP login → ${RETIRED_HINT}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).trim().slice(0, 160);
    } catch {
      /* ignore */
    }
    if (res.status === 404) throw new Error(`WHOOP login → ${RETIRED_HINT}`);
    const hint =
      res.status === 401 || res.status === 403 ? " (wrong email or password?)" : "";
    throw new Error(`WHOOP login → ${res.status}${hint}${detail ? ` — ${detail}` : ""}`);
  }
  const j = (await res.json()) as TokenResponse;
  if (!j.access_token || !j.refresh_token || j.user?.id == null) {
    throw new Error("WHOOP login returned no token — the app auth may have changed.");
  }
  const ttl = Number.isFinite(j.expires_in) ? (j.expires_in as number) : 3600;
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    userId: j.user.id,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  };
}

/** Exchange email + password for a bearer token (the app's password grant). */
export function whoopLogin(email: string, password: string, fetchImpl: FetchLike = fetch): Promise<WhoopSession> {
  return postToken(
    { grant_type: "password", issueRefresh: true, username: email, password },
    fetchImpl,
  );
}

/** Exchange a refresh token for a fresh session (no password needed). */
export function whoopRefresh(refreshToken: string, fetchImpl: FetchLike = fetch): Promise<WhoopSession> {
  return postToken(
    { grant_type: "refresh_token", refresh_token: refreshToken, issueRefresh: true, scope: "offline" },
    fetchImpl,
  );
}

/**
 * Resolve a usable session from stored creds, minting/refreshing as needed:
 *   cached token still valid → reuse (no network) · else refresh · else re-login.
 * Returns the session plus the creds to persist (with the rotated tokens).
 */
export async function ensureSession(
  creds: WhoopCreds,
  fetchImpl: FetchLike = fetch,
): Promise<{ session: WhoopSession; creds: WhoopCreds }> {
  const validCache =
    creds.accessToken &&
    creds.refreshToken &&
    creds.userId != null &&
    creds.tokenExpiresAt &&
    new Date(creds.tokenExpiresAt).getTime() - Date.now() > 120_000;
  if (validCache) {
    return {
      session: {
        accessToken: creds.accessToken!,
        refreshToken: creds.refreshToken!,
        userId: creds.userId!,
        expiresAt: creds.tokenExpiresAt!,
      },
      creds,
    };
  }

  let session: WhoopSession | null = null;
  if (creds.refreshToken) {
    try {
      session = await whoopRefresh(creds.refreshToken, fetchImpl);
    } catch {
      session = null; // refresh expired → fall back to email + password
    }
  }
  if (!session) {
    if (!creds.email || !creds.password) {
      throw new Error("WHOOP needs your email + password to (re)connect.");
    }
    session = await whoopLogin(creds.email, creds.password, fetchImpl);
  }
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

export interface WhoopCycle {
  days?: string[];
  during?: { lower?: string; upper?: string };
  recovery?: { score?: number; heartRateVariabilityRmssd?: number; restingHeartRate?: number };
  strain?: { score?: number; averageHeartRate?: number; maxHeartRate?: number };
  sleep?: { score?: number; qualityDuration?: number };
}

/** Pull recovery / strain / sleep cycles for the window (the app's /cycles feed). */
export async function fetchCycles(
  userId: number,
  token: string,
  from: string,
  to: string,
  fetchImpl: FetchLike = fetch,
): Promise<WhoopCycle[]> {
  const { start, end } = dayBounds(from, to);
  const url = new URL(`${API_BASE}/users/${userId}/cycles`);
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  url.searchParams.set("limit", "100");
  let raw: unknown;
  try {
    raw = await getAuthed(url.toString(), token, fetchImpl);
  } catch (e) {
    throw new Error(`WHOOP cycles → ${(e as Error).message}`);
  }
  // The app returns either a bare array or { records: [...] } / { cycles: [...] }.
  if (Array.isArray(raw)) return raw as WhoopCycle[];
  const obj = raw as { records?: WhoopCycle[]; cycles?: WhoopCycle[] };
  return obj.records ?? obj.cycles ?? [];
}

export interface HrSample {
  time: number; // epoch ms
  bpm: number;
}

/** Pull the PER-MINUTE heart-rate stream (step=60s) — the differentiator. */
export async function fetchHeartRate(
  userId: number,
  token: string,
  from: string,
  to: string,
  fetchImpl: FetchLike = fetch,
  stepSeconds: number = HR_STEP_SECONDS,
): Promise<HrSample[]> {
  const { start, end } = dayBounds(from, to);
  const url = new URL(`${API_BASE}/users/${userId}/metrics/heart_rate`);
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  url.searchParams.set("order", "t");
  url.searchParams.set("step", String(stepSeconds));
  let raw: unknown;
  try {
    raw = await getAuthed(url.toString(), token, fetchImpl);
  } catch (e) {
    throw new Error(`WHOOP heart rate → ${(e as Error).message}`);
  }
  const values = (raw as { values?: { time?: number; data?: number }[] })?.values ?? [];
  const out: HrSample[] = [];
  for (const v of values) {
    if (v?.time == null || v?.data == null) continue;
    const bpm = Number(v.data);
    if (!Number.isFinite(bpm) || bpm <= 0) continue; // WHOOP marks gaps as 0
    out.push({ time: Number(v.time), bpm });
  }
  return out;
}

// ---- normalize ------------------------------------------------------------

/** WHOOP stores rmssd in SECONDS in the app payload; surface it as ms (20–100). */
function hrvMs(rmssd?: number): string {
  if (rmssd == null || !Number.isFinite(rmssd)) return "";
  const ms = rmssd < 3 ? rmssd * 1000 : rmssd; // <3 → seconds, else already ms
  return num(ms);
}

interface DailyCycle {
  recovery: string;
  hrv: string;
  resting_hr: string;
  strain: string;
  sleep_hours: string;
  sleep_perf: string;
}

/** Bucket cycles into one summary per calendar day. */
export function normalizeCycles(cycles: WhoopCycle[], from: string, to: string): Map<string, DailyCycle> {
  const byDay = new Map<string, DailyCycle>();
  for (const c of cycles) {
    const day = (c.days?.[0] ?? c.during?.lower ?? "").slice(0, 10);
    if (!day || day < from || day > to) continue;
    const r = c.recovery ?? {};
    const s = c.strain ?? {};
    const sl = c.sleep ?? {};
    byDay.set(day, {
      recovery: r.score != null ? num(r.score) : "",
      hrv: hrvMs(r.heartRateVariabilityRmssd),
      resting_hr: r.restingHeartRate != null ? num(r.restingHeartRate) : "",
      strain: s.score != null ? num(s.score) : "",
      sleep_hours: sl.qualityDuration != null ? num(sl.qualityDuration / 3_600_000) : "",
      sleep_perf: sl.score != null ? num(sl.score) : "",
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

/** Directory the per-minute heart-rate files live in (inside the git record). */
export function whoopHrDir(recordDir: string): string {
  return path.join(recordDir, "whoop", "hr");
}

/** Write one per-minute CSV per day; overwrite (idempotent). Returns minute count. */
function writeHeartRateFiles(recordDir: string, files: Map<string, string[][]>): number {
  const dir = whoopHrDir(recordDir);
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
 * Full unofficial pull: auth → cycles + per-minute HR → merge daily/whoop.csv +
 * write record/whoop/hr/<date>.csv. Rebuilding the SQLite cache is the caller's
 * job (route / CLI), exactly like the other importers.
 */
export async function importWhoop(opts: {
  creds: WhoopCreds;
  from: string;
  to: string;
  recordDir: string;
  hrDays?: number;
  fetchImpl?: FetchLike;
}): Promise<ImportWhoopSummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { session, creds } = await ensureSession(opts.creds, fetchImpl);

  const cycles = await fetchCycles(session.userId, session.accessToken, opts.from, opts.to, fetchImpl);
  const dailyCycles = normalizeCycles(cycles, opts.from, opts.to);

  const { hrFrom, hrTo } = hrWindow(opts.from, opts.to, opts.hrDays ?? DEFAULT_HR_DAYS);
  const samples = await fetchHeartRate(session.userId, session.accessToken, hrFrom, hrTo, fetchImpl);
  const { files, daily: dailyHr } = bucketHeartRate(samples);
  const minutes = writeHeartRateFiles(opts.recordDir, files);

  const table = buildDailyTable(dailyCycles, dailyHr);
  const merge = mergeDailyCsv(opts.recordDir, "whoop", table);

  return {
    creds,
    userId: session.userId,
    from: opts.from,
    to: opts.to,
    hrFrom,
    hrTo,
    daysWithData: merge.dates.length,
    metrics: merge.metrics,
    cells: merge.cells,
    minutes,
    hrDays: files.size,
    file: merge.file,
  };
}

// ---- offline fixture (auth + cycles + HR in one routed stand-in) ----------

/**
 * A fetch stand-in that answers all three unofficial endpoints (token, cycles,
 * heart_rate) from in-memory data — so the whole auth → pull → merge pipeline
 * runs with no network. `onCall` (optional) records each URL for assertions.
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
    if (url.includes("/oauth/token")) {
      body = {
        access_token: `tok-${Date.now()}`,
        refresh_token: "refresh-abc",
        expires_in: 3600,
        token_type: "bearer",
        user: { id: userId },
      };
    } else if (url.includes("/metrics/heart_rate")) {
      body = { values: data.heartRate ?? [] };
    } else if (url.includes("/cycles")) {
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

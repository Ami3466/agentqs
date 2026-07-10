import {
  getJson,
  inWindow,
  num,
  type DailyTable,
  type FetchLike,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * WHOOP — the OFFICIAL developer API (api.prod.whoop.com), OAuth 2 bearer token.
 * Three v2 collection endpoints cover the daily story:
 *
 *   GET /developer/v2/cycle           → strain + day average/max heart rate
 *   GET /developer/v2/recovery        → recovery %, HRV (ms), resting HR
 *   GET /developer/v2/activity/sleep  → sleep hours + performance %
 *
 * Collections are paginated (limit ≤ 25, next_token), so each endpoint is
 * drained across the window. Columns mirror the unofficial importer
 * (record/daily/whoop.csv) so the two connects agree on metric names and the
 * duplicate-column scan can merge them. The official API stops at daily
 * summaries — per-minute heart rate only exists on the unofficial app login
 * (importers/whoop.ts), which stays its own bespoke source.
 */

const API = "https://api.prod.whoop.com/developer/v2";
const PAGE_LIMIT = 25; // the API's maximum page size
const MAX_PAGES = 40; // 1000 records ≈ years of daily data — a runaway guard

interface WhoopApiCycle {
  id?: number;
  start?: string; // ISO — the physiological day starts on wake
  score?: { strain?: number; average_heart_rate?: number; max_heart_rate?: number };
}
interface WhoopApiRecovery {
  cycle_id?: number;
  created_at?: string;
  score?: { recovery_score?: number; resting_heart_rate?: number; hrv_rmssd_milli?: number };
}
interface WhoopApiSleep {
  end?: string; // ISO — keyed to the wake day, like the app
  nap?: boolean;
  score?: {
    sleep_performance_percentage?: number;
    stage_summary?: {
      total_light_sleep_time_milli?: number;
      total_slow_wave_sleep_time_milli?: number;
      total_rem_sleep_time_milli?: number;
    };
  };
}
interface Page<T> {
  records?: T[];
  next_token?: string | null;
}

/** Drain one paginated collection endpoint across the window. */
async function drain<T>(
  endpoint: string,
  token: string,
  from: string,
  to: string,
  fetchImpl: FetchLike,
): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${API}${endpoint}`);
    url.searchParams.set("start", `${from}T00:00:00.000Z`);
    url.searchParams.set("end", `${to}T23:59:59.999Z`);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (nextToken) url.searchParams.set("nextToken", nextToken);
    const raw = (await getJson(
      url.toString(),
      { Authorization: `Bearer ${token}`, Accept: "application/json" },
      fetchImpl,
    )) as Page<T>;
    out.push(...(raw?.records ?? []));
    nextToken = raw?.next_token ?? undefined;
    if (!nextToken) break;
  }
  return out;
}

const HEADER = [
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

export function normalizeWhoopApi(
  cycles: WhoopApiCycle[],
  recoveries: WhoopApiRecovery[],
  sleeps: WhoopApiSleep[],
  from: string,
  to: string,
): DailyTable {
  const days = new Map<string, Record<string, string>>();
  const day = (iso?: string) => (iso ?? "").slice(0, 10);
  const cell = (d: string) => {
    let r = days.get(d);
    if (!r) {
      r = {};
      days.set(d, r);
    }
    return r;
  };

  const cycleDay = new Map<number, string>(); // recovery is keyed by cycle, not dated
  for (const c of cycles) {
    const d = day(c.start);
    if (c.id != null && d) cycleDay.set(c.id, d);
    if (!d || !inWindow(d, from, to)) continue;
    const s = c.score ?? {};
    const r = cell(d);
    if (s.strain != null) r.strain = num(s.strain);
    if (s.average_heart_rate != null) r.hr_avg = num(s.average_heart_rate);
    if (s.max_heart_rate != null) r.hr_max = num(s.max_heart_rate);
  }
  for (const rec of recoveries) {
    const d = (rec.cycle_id != null ? cycleDay.get(rec.cycle_id) : undefined) ?? day(rec.created_at);
    if (!d || !inWindow(d, from, to)) continue;
    const s = rec.score ?? {};
    const r = cell(d);
    if (s.recovery_score != null) r.recovery = num(s.recovery_score);
    if (s.hrv_rmssd_milli != null) r.hrv = num(s.hrv_rmssd_milli);
    if (s.resting_heart_rate != null) r.resting_hr = num(s.resting_heart_rate);
  }
  for (const sl of sleeps) {
    if (sl.nap) continue; // naps would double-count the night
    const d = day(sl.end);
    if (!d || !inWindow(d, from, to)) continue;
    const sc = sl.score ?? {};
    const st = sc.stage_summary ?? {};
    const ms =
      (st.total_light_sleep_time_milli ?? 0) +
      (st.total_slow_wave_sleep_time_milli ?? 0) +
      (st.total_rem_sleep_time_milli ?? 0);
    const r = cell(d);
    if (ms > 0) r.sleep_hours = num(ms / 3_600_000);
    if (sc.sleep_performance_percentage != null) r.sleep_perf = num(sc.sleep_performance_percentage);
  }

  const rows = [...days.keys()].sort().map((d) => {
    const r = days.get(d)!;
    return HEADER.map((h, i) => (i === 0 ? d : (r[h] ?? "")));
  });
  return { header: HEADER, rows };
}

export const whoopApiPlugin: ImporterPlugin = {
  id: "whoop-api",
  name: "WHOOP",
  detail: "recovery, strain & sleep (official API)",
  live: true,
  requiresCredential: true,
  credentialLabel: "OAuth access token",
  credentialPlaceholder: "WHOOP OAuth access token",
  credentialHelp: {
    url: "https://developer-dashboard.whoop.com",
    steps: [
      "Create an app in the WHOOP developer dashboard with scopes read:cycles, read:recovery, read:sleep and offline.",
      "Add the Redirect URI shown here to the app.",
      "Paste the Client ID and Client Secret into the fields here and press Authorize.",
    ],
  },
  oauth: {
    authUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
    tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
    // offline → WHOOP issues a refresh token, so scheduled syncs outlive the 1h access token.
    scope: "read:cycles read:recovery read:sleep offline",
    tokenAuth: "body",
  },
  envKey: "WHOOP_API_TOKEN",
  primaryMetric: "recovery",
  unit: "recovery",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const token = ctx.credential ?? "";
    let cycles: WhoopApiCycle[], recoveries: WhoopApiRecovery[], sleeps: WhoopApiSleep[];
    try {
      [cycles, recoveries, sleeps] = await Promise.all([
        drain<WhoopApiCycle>("/cycle", token, ctx.from, ctx.to, fetchImpl),
        drain<WhoopApiRecovery>("/recovery", token, ctx.from, ctx.to, fetchImpl),
        drain<WhoopApiSleep>("/activity/sleep", token, ctx.from, ctx.to, fetchImpl),
      ]);
    } catch (e) {
      throw new Error(`WHOOP API → ${(e as Error).message}`);
    }
    return {
      table: normalizeWhoopApi(cycles, recoveries, sleeps, ctx.from, ctx.to),
      meta: { cycles: cycles.length, recoveries: recoveries.length, sleeps: sleeps.length },
    };
  },
};

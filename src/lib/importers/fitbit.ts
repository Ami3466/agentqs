import {
  getJson,
  inWindow,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Fitbit — steps per day. Uses the Activity Time Series (steps) endpoint, which
 * returns one value per day for the whole window in a single request:
 *
 *   GET https://api.fitbit.com/1/user/-/activities/steps/date/<from>/<to>.json
 *
 * Auth is an OAuth 2 bearer access token (paste one — same slot Spotify/Calendar
 * use). "-" is the authorised user.
 */

interface FitbitDay {
  dateTime?: string; // YYYY-MM-DD
  value?: string; // step count as a string
}
interface FitbitResp {
  "activities-steps"?: FitbitDay[];
}

const BASE = "https://api.fitbit.com/1/user/-/activities/steps/date";

export function normalizeFitbit(days: FitbitDay[], from: string, to: string): DailyTable {
  const header = ["date", "steps"];
  const rows: string[][] = [];
  for (const d of days) {
    const date = (d.dateTime ?? "").slice(0, 10);
    if (!date || !inWindow(date, from, to)) continue;
    const steps = Number(d.value);
    rows.push([date, Number.isFinite(steps) ? String(Math.round(steps)) : ""]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { header, rows };
}

export const fitbitPlugin: ImporterPlugin = {
  id: "fitbit",
  name: "Fitbit",
  detail: "steps per day",
  live: true,
  requiresCredential: true,
  credentialLabel: "OAuth access token",
  credentialPlaceholder: "Fitbit OAuth access token",
  envKey: "FITBIT_TOKEN",
  primaryMetric: "steps",
  unit: "steps",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const url = `${BASE}/${ctx.from}/${ctx.to}.json`;
    let raw: unknown;
    try {
      raw = await getJson(
        url,
        { Authorization: `Bearer ${ctx.credential ?? ""}`, Accept: "application/json" },
        fetchImpl,
      );
    } catch (e) {
      throw new Error(`Fitbit steps → ${(e as Error).message}`);
    }
    const days = (raw as FitbitResp)?.["activities-steps"] ?? [];
    return { table: normalizeFitbit(days, ctx.from, ctx.to), meta: { pulledDays: days.length } };
  },
};

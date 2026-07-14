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

/**
 * Fitbit's time series is DENSE and ZERO-FILLED: ask for a range and it answers with a
 * row for every day in it, `0` for the days it knows nothing about — including every
 * day before the account existed.
 *
 * We wrote those zeros. Two things followed. The record asserted you walked 0 steps a
 * day in 2003, which is not a measurement, it is an absence wearing a number, and it
 * dragged every all-time average toward zero. And the backfill walk judges "this year
 * held nothing" by whether a chunk landed rows — so a wall of invented zeros looked
 * like data forever, the walk never terminated, and it ground all the way to the floor
 * writing fiction the whole way down.
 *
 * A zero-step day is not a thing Fitbit ever observed. It is Fitbit saying "no". So a
 * day with no steps lands no row. (Gmail says the same thing about a day with no mail,
 * and for the same two reasons.)
 */
export function normalizeFitbit(days: FitbitDay[], from: string, to: string): DailyTable {
  const header = ["date", "steps"];
  const rows: string[][] = [];
  for (const d of days) {
    const date = (d.dateTime ?? "").slice(0, 10);
    if (!date || !inWindow(date, from, to)) continue;
    const steps = Number(d.value);
    if (!Number.isFinite(steps) || steps <= 0) continue; // a zero-fill is not a measurement
    rows.push([date, String(Math.round(steps))]);
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
  credentialHelp: {
    url: "https://dev.fitbit.com/apps",
    steps: [
      "Register an app at dev.fitbit.com (OAuth 2.0 Application Type: Personal).",
      "Set the Redirect URL to the one shown here.",
      "Paste the Client ID and Client Secret into the fields here and press Authorize.",
    ],
  },
  oauth: {
    authUrl: "https://www.fitbit.com/oauth2/authorize",
    tokenUrl: "https://api.fitbit.com/oauth2/token",
    scope: "activity",
    tokenAuth: "basic",
  },
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

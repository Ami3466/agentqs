import {
  getJson,
  pageAll,
  inWindow,
  num,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Oura — daily readiness. Uses the v2 Daily Readiness endpoint, which returns one
 * already-scored object per day:
 *
 *   GET https://api.ouraring.com/v2/usercollection/daily_readiness
 *       ?start_date=<from>&end_date=<to>
 *
 * Auth is a Personal Access Token (bearer) — no OAuth dance, paste one from
 * cloud.ouraring.com. We keep the readiness score plus the body-temperature
 * deviation (early-illness signal).
 */

interface OuraDay {
  day?: string; // YYYY-MM-DD
  score?: number;
  temperature_deviation?: number;
}
interface OuraResp {
  data?: OuraDay[];
  /** The rest of the days. Never read, so a long window lost its tail. */
  next_token?: string;
}

const API = "https://api.ouraring.com/v2/usercollection/daily_readiness";

export function normalizeOura(days: OuraDay[], from: string, to: string): DailyTable {
  const header = ["date", "readiness_score", "temp_deviation"];
  const rows: string[][] = [];
  for (const d of days) {
    const date = (d.day ?? "").slice(0, 10);
    if (!date || !inWindow(date, from, to)) continue;
    rows.push([
      date,
      d.score != null ? num(d.score) : "",
      d.temperature_deviation != null ? num(d.temperature_deviation) : "",
    ]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { header, rows };
}

export const ouraPlugin: ImporterPlugin = {
  id: "oura",
  name: "Oura",
  detail: "readiness score & temperature",
  live: true,
  requiresCredential: true,
  credentialLabel: "Oura personal access token",
  credentialPlaceholder: "your Oura PAT",
  credentialHelp: {
    url: "https://cloud.ouraring.com/personal-access-tokens",
    steps: [
      "Sign in to Oura on the web and open Personal Access Tokens.",
      "Create a token and paste it here — it does not expire.",
    ],
  },
  envKey: "OURA_TOKEN",
  primaryMetric: "readiness_score",
  unit: "readiness",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    // Oura pages with next_token. A 365-day chunk exceeds one page, and reading only
    // the first landed a fraction of the year while the chunk still looked healthy.
    let days: OuraDay[];
    try {
      days = await pageAll<OuraDay>("Oura daily readiness", async (cursor) => {
        const url = new URL(API);
        url.searchParams.set("start_date", ctx.from);
        url.searchParams.set("end_date", ctx.to);
        if (cursor) url.searchParams.set("next_token", String(cursor));
        const raw = (await getJson(
          url.toString(),
          { Authorization: `Bearer ${ctx.credential ?? ""}`, Accept: "application/json" },
          fetchImpl,
        )) as OuraResp;
        return { items: raw?.data ?? [], next: raw?.next_token ?? null };
      });
    } catch (e) {
      throw new Error(`Oura daily readiness → ${(e as Error).message}`);
    }
    return { table: normalizeOura(days, ctx.from, ctx.to), meta: { pulledDays: days.length } };
  },
};

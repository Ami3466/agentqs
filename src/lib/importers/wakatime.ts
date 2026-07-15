import {
  getJson,
  inWindow,
  num,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * WakaTime — how long you actually spent coding, per day. Uses the Summaries
 * endpoint, which returns one already-bucketed object per day:
 *
 *   GET https://wakatime.com/api/v1/users/current/summaries?start=<from>&end=<to>
 *
 * Auth is your API key, sent Basic-encoded (base64 of the key itself, no colon) —
 * paste one from wakatime.com/settings/api-key, no OAuth. WakaTime already buckets
 * each summary by the day you lived in YOUR account timezone (`range.date` is a
 * calendar date, not a timestamp), so it needs no localDay conversion — same as
 * Strava's start_date_local.
 */

interface WakaGrandTotal {
  total_seconds?: number;
}
interface WakaSummary {
  range?: { date?: string }; // YYYY-MM-DD, already the account's local day
  grand_total?: WakaGrandTotal;
}
interface WakaResp {
  data?: WakaSummary[];
}

const API = "https://wakatime.com/api/v1/users/current/summaries";

export function normalizeWakatime(days: WakaSummary[], from: string, to: string): DailyTable {
  const header = ["date", "coding_minutes"];
  const rows: string[][] = [];
  for (const d of days) {
    const date = (d.range?.date ?? "").slice(0, 10);
    const secs = d.grand_total?.total_seconds;
    if (!date || !inWindow(date, from, to) || typeof secs !== "number") continue;
    rows.push([date, num(secs / 60)]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { header, rows };
}

export const wakatimePlugin: ImporterPlugin = {
  id: "wakatime",
  name: "WakaTime",
  detail: "coding time per day",
  live: true,
  requiresCredential: true,
  credentialLabel: "WakaTime API key",
  credentialPlaceholder: "waka_… (your API key)",
  credentialHelp: {
    url: "https://wakatime.com/settings/api-key",
    steps: [
      "Sign in to WakaTime and open Settings → API Key.",
      "Copy the key and paste it here — it does not expire.",
    ],
  },
  envKey: "WAKATIME_KEY",
  primaryMetric: "coding_minutes",
  unit: "min coding",
  // The free plan keeps only the last ~14 days; a paid plan keeps its full history.
  // No window we send can reach past your plan's retention — an honest note, never a
  // broken importer.
  historyNote:
    "WakaTime's free plan keeps only about the last two weeks of history (a paid plan keeps it all). agentqs asks for whatever your plan will serve and keeps each day it sees, so your record grows past that window over time.",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const url = new URL(API);
    url.searchParams.set("start", ctx.from);
    url.searchParams.set("end", ctx.to);
    const auth = Buffer.from(ctx.credential ?? "").toString("base64");
    let raw: WakaResp;
    try {
      raw = (await getJson(
        url.toString(),
        { Authorization: `Basic ${auth}`, Accept: "application/json" },
        fetchImpl,
      )) as WakaResp;
    } catch (e) {
      throw new Error(`WakaTime summaries → ${(e as Error).message}`);
    }
    const table = normalizeWakatime(raw?.data ?? [], ctx.from, ctx.to);
    return { table, meta: { pulledDays: table.rows.length } };
  },
};

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
 * RescueTime — where your hours actually go. Uses the Daily Summary Feed, which
 * returns one already-aggregated object per day, so no bucketing is needed:
 *
 *   GET https://www.rescuetime.com/anapi/daily_summary_feed?key=<API key>
 *
 * Auth is a simple API key (query param), like GitHub's PAT — no OAuth. We keep
 * the productivity pulse plus productive / distracting / total hours per day.
 */

interface RtDay {
  date?: string; // YYYY-MM-DD
  productivity_pulse?: number;
  total_hours?: number;
  all_productive_hours?: number;
  all_distracting_hours?: number;
}

const API = "https://www.rescuetime.com/anapi/daily_summary_feed";

export function normalizeRescueTime(days: RtDay[], from: string, to: string): DailyTable {
  const header = ["date", "productivity_pulse", "productive_hours", "distracting_hours", "total_hours"];
  const rows: string[][] = [];
  for (const d of days) {
    const date = (d.date ?? "").slice(0, 10);
    if (!date || !inWindow(date, from, to)) continue;
    rows.push([
      date,
      d.productivity_pulse != null ? num(d.productivity_pulse) : "",
      d.all_productive_hours != null ? num(d.all_productive_hours) : "",
      d.all_distracting_hours != null ? num(d.all_distracting_hours) : "",
      d.total_hours != null ? num(d.total_hours) : "",
    ]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { header, rows };
}

export const rescuetimePlugin: ImporterPlugin = {
  id: "rescuetime",
  name: "RescueTime",
  detail: "focus — productivity pulse & hours",
  live: true,
  requiresCredential: true,
  credentialLabel: "RescueTime API key",
  credentialPlaceholder: "your RescueTime API key",
  envKey: "RESCUETIME_KEY",
  primaryMetric: "productivity_pulse",
  unit: "avg pulse",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const url = new URL(API);
    if (ctx.credential) url.searchParams.set("key", ctx.credential);
    url.searchParams.set("format", "json");
    let raw: unknown;
    try {
      raw = await getJson(url.toString(), { Accept: "application/json" }, fetchImpl);
    } catch (e) {
      throw new Error(`RescueTime daily feed → ${(e as Error).message}`);
    }
    const days = Array.isArray(raw) ? (raw as RtDay[]) : [];
    return { table: normalizeRescueTime(days, ctx.from, ctx.to), meta: { pulledDays: days.length } };
  },
};

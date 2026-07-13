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
 * RescueTime — where your hours actually go. Two endpoints, same API key:
 *
 *   GET https://www.rescuetime.com/anapi/data?perspective=interval&resolution_time=day
 *       &restrict_kind=productivity&restrict_begin=<from>&restrict_end=<to>
 *       → seconds per productivity level (-2..2) per day, INCLUDING today —
 *         this is what makes "sync now" land today's hours.
 *   GET https://www.rescuetime.com/anapi/daily_summary_feed
 *       → one aggregated object per COMPLETED day (never today), the only
 *         place the productivity pulse lives. ~2 weeks of history.
 *
 * Hours come from the data API (fresh, windowed), the pulse from the summary
 * feed where a completed day has one. Blanks never clobber on merge, so
 * today's row lands hours-only and the pulse fills in on tomorrow's sync.
 * Auth is a simple API key (query param), like GitHub's PAT — no OAuth.
 */

interface RtDay {
  date?: string; // YYYY-MM-DD
  productivity_pulse?: number;
  total_hours?: number;
  all_productive_hours?: number;
  all_distracting_hours?: number;
}

/** anapi/data reply: rows of [dayISO, seconds, people, productivity(-2..2)]. */
interface RtIntervalFeed {
  rows?: unknown[][];
}

const SUMMARY_API = "https://www.rescuetime.com/anapi/daily_summary_feed";
const DATA_API = "https://www.rescuetime.com/anapi/data";

/** Accept the live array or the combined offline fixture ({summary, interval}). */
function pickSummary(raw: unknown): RtDay[] {
  if (Array.isArray(raw)) return raw as RtDay[];
  const summary = (raw as { summary?: unknown })?.summary;
  return Array.isArray(summary) ? (summary as RtDay[]) : [];
}

function pickInterval(raw: unknown): RtIntervalFeed {
  const o = raw as { rows?: unknown[][]; interval?: RtIntervalFeed } | null;
  if (o && Array.isArray(o.rows)) return o;
  if (o?.interval && Array.isArray(o.interval.rows)) return o.interval;
  return {};
}

interface DayHours {
  productive: number;
  distracting: number;
  total: number;
}

/** Sum the data API's per-level seconds into productive/distracting/total hours. */
export function bucketIntervalRows(feed: RtIntervalFeed, from: string, to: string): Map<string, DayHours> {
  const days = new Map<string, DayHours>();
  for (const row of feed.rows ?? []) {
    const date = String(row[0] ?? "").slice(0, 10);
    const seconds = Number(row[1]);
    const level = Number(row[3]);
    if (!date || !inWindow(date, from, to) || !Number.isFinite(seconds) || !Number.isFinite(level)) continue;
    const d = days.get(date) ?? { productive: 0, distracting: 0, total: 0 };
    if (level > 0) d.productive += seconds;
    if (level < 0) d.distracting += seconds;
    d.total += seconds;
    days.set(date, d);
  }
  return days;
}

export function normalizeRescueTime(
  summaryDays: RtDay[],
  interval: RtIntervalFeed,
  from: string,
  to: string,
): DailyTable {
  const header = ["date", "productivity_pulse", "productive_hours", "distracting_hours", "total_hours"];
  const hours = bucketIntervalRows(interval, from, to);
  const pulse = new Map<string, number>();
  const summaryHours = new Map<string, DayHours>();
  for (const d of summaryDays) {
    const date = (d.date ?? "").slice(0, 10);
    if (!date || !inWindow(date, from, to)) continue;
    if (d.productivity_pulse != null) pulse.set(date, d.productivity_pulse);
    // Feed hours only backfill dates the data API didn't cover (already hours).
    if (!hours.has(date) && (d.all_productive_hours != null || d.total_hours != null)) {
      summaryHours.set(date, {
        productive: (d.all_productive_hours ?? 0) * 3600,
        distracting: (d.all_distracting_hours ?? 0) * 3600,
        total: (d.total_hours ?? 0) * 3600,
      });
    }
  }
  const dates = [...new Set([...hours.keys(), ...summaryHours.keys(), ...pulse.keys()])].sort();
  const rows: string[][] = [];
  for (const date of dates) {
    const h = hours.get(date) ?? summaryHours.get(date);
    const p = pulse.get(date);
    rows.push([
      date,
      p != null ? num(p) : "",
      h ? num(h.productive / 3600) : "",
      h ? num(h.distracting / 3600) : "",
      h ? num(h.total / 3600) : "",
    ]);
  }
  return { header, rows };
}

export const rescuetimePlugin: ImporterPlugin = {
  id: "rescuetime",
  name: "RescueTime",
  detail: "focus — productivity pulse & hours",
  live: true,
  // RescueTime's API serves a ROLLING ~2-week window and ignores restrict_begin
  // entirely: asked for January 2025 it answers with rows dated a fortnight ago
  // (verified live). No window we send reaches further back, so a backfill cannot
  // help — what it CAN do is keep every day it hands us before that day ages out,
  // which is why the record ends up holding more history than the API will serve.
  historyNote:
    "RescueTime's API only exposes about the last two weeks (a free plan keeps no more), and it ignores any earlier date you ask for. agentqs keeps each day it sees, so your record grows past that window over time — but nothing can backfill the days before you connected.",
  requiresCredential: true,
  credentialLabel: "RescueTime API key",
  credentialPlaceholder: "your RescueTime API key",
  credentialHelp: {
    url: "https://www.rescuetime.com/anapi/manage",
    steps: [
      "Sign in and open API & Integrations → \"Manage your API keys\".",
      "Create a key (any label) and paste it here — it does not expire.",
    ],
  },
  envKey: "RESCUETIME_KEY",
  primaryMetric: "productivity_pulse",
  unit: "avg pulse",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const dataUrl = new URL(DATA_API);
    if (ctx.credential) dataUrl.searchParams.set("key", ctx.credential);
    dataUrl.searchParams.set("format", "json");
    dataUrl.searchParams.set("perspective", "interval");
    dataUrl.searchParams.set("resolution_time", "day");
    dataUrl.searchParams.set("restrict_kind", "productivity");
    dataUrl.searchParams.set("restrict_begin", ctx.from);
    dataUrl.searchParams.set("restrict_end", ctx.to);
    let intervalRaw: unknown;
    try {
      intervalRaw = await getJson(dataUrl.toString(), { Accept: "application/json" }, fetchImpl);
    } catch (e) {
      throw new Error(`RescueTime data API → ${(e as Error).message}`);
    }

    const summaryUrl = new URL(SUMMARY_API);
    if (ctx.credential) summaryUrl.searchParams.set("key", ctx.credential);
    summaryUrl.searchParams.set("format", "json");
    let summaryRaw: unknown;
    try {
      summaryRaw = await getJson(summaryUrl.toString(), { Accept: "application/json" }, fetchImpl);
    } catch (e) {
      throw new Error(`RescueTime daily feed → ${(e as Error).message}`);
    }

    const summary = pickSummary(summaryRaw);
    const interval = pickInterval(intervalRaw);
    const table = normalizeRescueTime(summary, interval, ctx.from, ctx.to);
    return { table, meta: { pulledDays: table.rows.length, intervalRows: interval.rows?.length ?? 0 } };
  },
};

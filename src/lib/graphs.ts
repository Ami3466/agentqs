import fs from "fs";
import { openReadonly } from "./db";
import { cacheStamp } from "./cache-stamp";
import { dbPath } from "./paths";

export type GraphViewType = "correlation" | "timeline" | "candles";
export type GraphRangePreset = "30" | "60" | "90" | "custom" | "all";

/**
 * One plottable line, stored SPARSELY: `d` holds indices into the shared `dates`
 * array and `v` the value at each. Graphs are numbers over time and nothing else,
 * so that is all that travels.
 *
 * The Graphs tab used to read the full journal payload — every cell wrapped as
 * `{"text":"","num":N}`, plus per-day memo/session/event arrays it never looked
 * at. On a lifetime record that is 15 MB per visit, which is heavy enough that
 * Chrome refuses to file the response (`net::ERR_CACHE_WRITE_FAILURE`) and the
 * fetch REJECTS. The same numbers in this shape are a fraction of the size, and
 * the day counts the tab draws are summed in SQL instead of by walking thousands
 * of day objects in the browser.
 */
export interface GraphSeries {
  key: string; // "metric:<source>.<metric>" | "count:<what>"
  label: string;
  /** Indices into GraphSeriesData.dates. Omitted when the series covers EVERY
   *  date — a count series has a value (often 0) on every day the record has, and
   *  spelling out 0,1,2,3,… beside it would cost more than the values do. */
  d?: number[];
  v: number[];
}

export interface GraphSeriesData {
  dates: string[]; // ascending, only days that carry a number
  series: GraphSeries[];
  totalDays: number;
}

const EMPTY_SERIES: GraphSeriesData = { dates: [], series: [], totalDays: 0 };

const memo = new Map<string, { stamp: string; at: number; data: GraphSeriesData }>();
const MEMO_MAX_AGE_MS = 60_000;

/** Every numeric daily series plus the per-day counts the tab offers, straight
 *  from the cache. Memoized on the cache fingerprint like the other read views. */
export function readGraphSeries(opts: { file?: string; today?: string } = {}): GraphSeriesData {
  const file = opts.file ?? dbPath();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  if (!fs.existsSync(file)) return EMPTY_SERIES;
  const key = `${file}|${today}`;
  const stamp = cacheStamp(file);
  const hit = memo.get(key);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < MEMO_MAX_AGE_MS) return hit.data;
  const data = computeGraphSeries(file, today);
  memo.set(key, { stamp, at: Date.now(), data });
  if (memo.size > 4) memo.delete(memo.keys().next().value as string);
  return data;
}

function computeGraphSeries(file: string, today: string): GraphSeriesData {
  let db;
  try {
    db = openReadonly(file);
  } catch {
    return EMPTY_SERIES;
  }
  try {
    // Only NUMERIC cells can be plotted, so the non-numeric ones never leave SQLite.
    const rows = db
      .prepare(
        `SELECT date, source, metric, value_num AS num
           FROM daily
          WHERE date <= ? AND value_num IS NOT NULL
          ORDER BY date`,
      )
      .all(today) as Array<{ date: string; source: string; metric: string; num: number }>;

    // Per-day counts, summed in SQL. These count EVERY daily cell (text included),
    // which is what "data points per day" has always meant on this tab.
    const cellCounts = db
      .prepare("SELECT date, COUNT(*) AS n, source FROM daily WHERE date <= ? GROUP BY date, source")
      .all(today) as Array<{ date: string; n: number; source: string }>;
    const memoCounts = db
      .prepare(
        `SELECT substr(ts, 1, 10) AS date, COUNT(*) AS n
           FROM raw_inbox
          WHERE status != 'discarded' AND kind != 'notification' AND substr(ts, 1, 10) <= ?
          GROUP BY date`,
      )
      .all(today) as Array<{ date: string; n: number }>;
    const sessionCounts = db
      .prepare(
        `SELECT COALESCE(date, substr(started_at, 1, 10)) AS date, COUNT(*) AS n
           FROM sessions WHERE COALESCE(date, substr(started_at, 1, 10)) <= ? GROUP BY date`,
      )
      .all(today) as Array<{ date: string; n: number }>;
    // Days that carry ONLY events (a day of browsing that landed no daily cell)
    // still belong on the axis: the count series answered 0 for them before, and a
    // day the record knows about must read as "nothing", not as a gap.
    let eventDates: Array<{ date: string }> = [];
    try {
      eventDates = db
        .prepare("SELECT DISTINCT date FROM events WHERE date <= ?")
        .all(today) as Array<{ date: string }>;
    } catch {
      /* pre-events cache — the axis is just the daily one */
    }

    // One shared, ascending date axis; every series indexes into it.
    const dates: string[] = [];
    const dateIdx = new Map<string, number>();
    const indexOf = (date: string): number => {
      let i = dateIdx.get(date);
      if (i === undefined) {
        i = dates.length;
        dates.push(date);
        dateIdx.set(date, i);
      }
      return i;
    };
    for (const r of rows) indexOf(r.date);
    for (const r of cellCounts) indexOf(r.date);
    for (const r of memoCounts) if (r.date) indexOf(r.date);
    for (const r of sessionCounts) if (r.date) indexOf(r.date);
    for (const r of eventDates) if (r.date) indexOf(r.date);
    // `dates` was filled in query order (daily first), so sort it and remap.
    dates.sort();
    dateIdx.clear();
    dates.forEach((d, i) => dateIdx.set(d, i));

    // Metric series: sparse, because a metric only exists on the days it was recorded.
    const series: GraphSeries[] = [];
    const byKey = new Map<string, GraphSeries>();
    for (const r of rows) {
      const key = `metric:${r.source}.${r.metric}`;
      let s = byKey.get(key);
      if (!s) {
        s = { key, label: `${r.source} · ${r.metric}`, d: [], v: [] };
        byKey.set(key, s);
        series.push(s);
      }
      s.d!.push(dateIdx.get(r.date)!);
      s.v.push(r.num);
    }

    // Counts: total cells per day, per-source cells per day, memos, sessions, and
    // the sum the tab calls "all activity". Dense over `dates` — a count of ZERO is
    // a real answer ("nothing that day"), so dropping those days would turn a flat
    // line into a hole in the chart.
    const perDayCells = new Map<string, number>();
    const perSourcePerDay = new Map<string, Map<string, number>>();
    for (const r of cellCounts) {
      perDayCells.set(r.date, (perDayCells.get(r.date) ?? 0) + r.n);
      let m = perSourcePerDay.get(r.source);
      if (!m) {
        m = new Map();
        perSourcePerDay.set(r.source, m);
      }
      m.set(r.date, (m.get(r.date) ?? 0) + r.n);
    }
    const perDayMemos = new Map(memoCounts.filter((r) => r.date).map((r) => [r.date, r.n]));
    const perDaySessions = new Map(sessionCounts.filter((r) => r.date).map((r) => [r.date, r.n]));

    const dense = (key: string, label: string, at: (date: string) => number) =>
      series.push({ key, label, v: dates.map(at) });

    dense("count:data-points", "Count · data points per day", (d) => perDayCells.get(d) ?? 0);
    dense("count:logs", "Count · logs per day", (d) => perDayMemos.get(d) ?? 0);
    dense("count:sessions", "Count · sessions per day", (d) => perDaySessions.get(d) ?? 0);
    dense(
      "count:activity",
      "Count · all activity per day",
      (d) => (perDayCells.get(d) ?? 0) + (perDayMemos.get(d) ?? 0) + (perDaySessions.get(d) ?? 0),
    );
    for (const source of [...perSourcePerDay.keys()].sort()) {
      const m = perSourcePerDay.get(source)!;
      dense(`count:source:${source}`, `Count · ${source} points per day`, (d) => m.get(d) ?? 0);
    }

    const totalDays = (
      db.prepare("SELECT COUNT(DISTINCT date) AS n FROM daily WHERE date <= ?").get(today) as { n: number }
    ).n;
    return { dates, series, totalDays };
  } catch {
    return EMPTY_SERIES; // stale/older schema
  } finally {
    db.close();
  }
}

export interface SavedGraph {
  id: string;
  name: string;
  xKey: string;
  yKey: string;
  view: GraphViewType;
  range: GraphRangePreset;
  startDate?: string;
  endDate?: string;
}

function cleanKey(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, 160) : "";
}

function cleanDate(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

export function sanitizeSavedGraphs(input: unknown): SavedGraph[] {
  if (!Array.isArray(input)) return [];
  const out: SavedGraph[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    const id = cleanKey(v.id);
    const name = cleanKey(v.name);
    const xKey = cleanKey(v.xKey);
    const yKey = cleanKey(v.yKey);
    const view =
      v.view === "timeline" ? "timeline" : v.view === "candles" ? "candles" : v.view === "correlation" ? "correlation" : "";
    const range =
      v.range === "30" || v.range === "60" || v.range === "90" || v.range === "custom" || v.range === "all"
        ? v.range
        : "30";
    if (!id || seen.has(id) || !name || !xKey || !view) continue;
    if (view === "correlation" && !yKey) continue;
    seen.add(id);
    out.push({
      id,
      name: name.slice(0, 80),
      xKey,
      yKey,
      view,
      range,
      startDate: range === "custom" ? cleanDate(v.startDate) : undefined,
      endDate: range === "custom" ? cleanDate(v.endDate) : undefined,
    });
  }
  return out.slice(0, 40);
}

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

const memo = new Map<string, { stamp: string; at: number; data: GraphSeriesData; size: number }>();
const catalogMemo = new Map<string, { stamp: string; at: number; data: GraphSeriesData }>();
const MEMO_MAX_AGE_MS = 60_000;
const MEMO_MAX_ENTRIES = 2;
/** Cache budget in bytes for the FULL-series memo only (approximate — see
 *  estimateGraphSeriesBytes). catalogMemo holds a few KB and keeps its own
 *  small entry cap below — no budget needed there. */
const MEMO_BUDGET_BYTES = 48 * 1024 * 1024;
/** Running total of `size` across every entry in `memo`, kept in lockstep with
 *  every insert/evict/replace below — do not let this drift. */
let memoBytes = 0;

/**
 * Cheap, ORDER-OF-MAGNITUDE estimate of a GraphSeriesData's live heap
 * footprint. Not a measurement — walks array lengths instead of serializing.
 * Constants are guesses (V8 array/number overhead), not measured facts.
 */
function estimateGraphSeriesBytes(data: GraphSeriesData): number {
  const BYTES_PER_DATE = 24; // one date string ("YYYY-MM-DD") + array slot
  const BYTES_PER_SERIES_BASE = 150; // GraphSeries object shell + key string
  const BYTES_PER_POINT = 150; // one v[] number: array slot + V8 per-small-array/
  // per-series overhead at this cardinality (hundreds of thousands of points across
  // hundreds of series) — measured live cost runs well above the raw 8-byte double
  const BYTES_PER_INDEX = 8; // one d[] index, when present

  let bytes = data.dates.length * BYTES_PER_DATE;
  for (const s of data.series) {
    bytes += BYTES_PER_SERIES_BASE + s.label.length * 2;
    bytes += s.v.length * BYTES_PER_POINT;
    if (s.d) bytes += s.d.length * BYTES_PER_INDEX;
  }
  return bytes;
}

/** Every numeric daily series plus the per-day counts the tab offers, straight
 *  from the cache. Memoized on the cache fingerprint like the other read views. */
export function readGraphSeries(
  opts: { file?: string; today?: string; keys?: string[]; catalogOnly?: boolean } = {},
): GraphSeriesData {
  const file = opts.file ?? dbPath();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  if (!fs.existsSync(file)) return EMPTY_SERIES;
  const key = `${file}|${today}`;

  // The picker only needs KEYS and LABELS, never a number — so it has its own cheap
  // query path and its own memo entry. Routing it through computeGraphSeries would
  // load every numeric cell in the record just to throw the numbers away, which is
  // what made `catalog=1` cost as much as the full series fetch it exists to avoid.
  if (opts.catalogOnly) {
    const stamp = cacheStamp(file);
    const hit = catalogMemo.get(key);
    const data =
      hit && hit.stamp === stamp && Date.now() - hit.at < MEMO_MAX_AGE_MS ? hit.data : computeGraphCatalog(file, today);
    if (data !== hit?.data) {
      catalogMemo.set(key, { stamp, at: Date.now(), data });
      if (catalogMemo.size > 4) catalogMemo.delete(catalogMemo.keys().next().value as string);
    }
    return data;
  }

  const stamp = cacheStamp(file);
  const hit = memo.get(key);
  const data =
    hit && hit.stamp === stamp && Date.now() - hit.at < MEMO_MAX_AGE_MS ? hit.data : computeGraphSeries(file, today);
  if (data !== hit?.data) {
    if (hit) memoBytes -= hit.size;
    const size = estimateGraphSeriesBytes(data);
    if (size > MEMO_BUDGET_BYTES) {
      // Too big to cache alone — serve it, forget it.
      memo.delete(key);
    } else {
      memo.set(key, { stamp, at: Date.now(), data, size });
      memoBytes += size;
      while ((memo.size > MEMO_MAX_ENTRIES || memoBytes > MEMO_BUDGET_BYTES) && memo.size > 0) {
        const oldestKey = memo.keys().next().value as string;
        const oldest = memo.get(oldestKey)!;
        memoBytes -= oldest.size;
        memo.delete(oldestKey);
      }
    }
  }
  return projectSeries(data, opts);
}

/**
 * Narrow the full series set to what the caller will actually draw.
 *
 * A record with fifty sources has ~300 plottable lines and thousands of days; sending
 * all of them is 11MB to render two. `keys` returns the numbers for just the lines on
 * screen. The full set is computed once and memoized; this only decides how much of
 * it crosses the wire.
 */
function projectSeries(
  data: GraphSeriesData,
  opts: { keys?: string[] },
): GraphSeriesData {
  if (!opts.keys?.length) return data;
  const want = new Set(opts.keys);
  const series = data.series.filter((s) => want.has(s.key));
  if (!series.length) return { dates: [], series: [], totalDays: data.totalDays };
  // Keep only the dates the chosen series actually touch, and reindex onto them —
  // otherwise one sparse metric would drag the whole 4,000-day axis along with it.
  const used = new Set<number>();
  for (const s of series) {
    if (s.d) for (const i of s.d) used.add(i);
    else for (let i = 0; i < s.v.length; i++) used.add(i);
  }
  const keep = [...used].sort((a, b) => a - b);
  const remap = new Map(keep.map((oldIdx, newIdx) => [oldIdx, newIdx]));
  return {
    dates: keep.map((i) => data.dates[i]),
    totalDays: data.totalDays,
    series: series.map((s) => ({
      key: s.key,
      label: s.label,
      d: (s.d ?? s.v.map((_, i) => i)).map((i) => remap.get(i)!),
      v: [...s.v],
    })),
  };
}

/** Keys and labels only — no numbers, no per-day scan. The picker needs to know
 *  every plottable line exists; it does not need a single value until the user
 *  actually adds one to a chart. `daily_metric_catalog` (source, metric, date,
 *  value_num) makes the DISTINCT source/metric scan index-only, so this is a
 *  handful of small aggregates instead of the full-series computation. */
function computeGraphCatalog(file: string, today: string): GraphSeriesData {
  let db;
  try {
    db = openReadonly(file);
  } catch {
    return EMPTY_SERIES;
  }
  try {
    const metrics = db
      .prepare(
        `SELECT DISTINCT source, metric FROM daily WHERE date <= ? AND value_num IS NOT NULL ORDER BY source, metric`,
      )
      .all(today) as Array<{ source: string; metric: string }>;
    const sources = db
      .prepare("SELECT DISTINCT source FROM daily WHERE date <= ? ORDER BY source")
      .all(today) as Array<{ source: string }>;
    const totalDays = (
      db.prepare("SELECT COUNT(DISTINCT date) AS n FROM daily WHERE date <= ?").get(today) as { n: number }
    ).n;

    const series: GraphSeries[] = [];
    for (const { source, metric } of metrics) {
      series.push({ key: `metric:${source}.${metric}`, label: `${source} · ${metric}`, v: [] });
    }
    series.push({ key: "count:data-points", label: "Count · data points per day", v: [] });
    series.push({ key: "count:logs", label: "Count · logs per day", v: [] });
    series.push({ key: "count:sessions", label: "Count · sessions per day", v: [] });
    series.push({ key: "count:activity", label: "Count · all activity per day", v: [] });
    for (const { source } of sources) {
      series.push({ key: `count:source:${source}`, label: `Count · ${source} points per day`, v: [] });
    }

    return { dates: [], series, totalDays };
  } catch {
    return EMPTY_SERIES; // stale/older schema
  } finally {
    db.close();
  }
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

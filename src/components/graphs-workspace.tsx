"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { JournalData } from "@/lib/journal";
import type { GraphRangePreset, GraphViewType, SavedGraph } from "@/lib/graphs";
import { Button, Card, Input, Select, SkeletonRows, cn } from "./ui";
import { peekCache, primeCache } from "@/lib/client-cache";
import { RangePicker } from "./range-picker";
import { Plus, Spinner, Trash } from "./icons";

interface SeriesDef {
  key: string;
  label: string;
  values: Map<string, number>;
}

type DraftGraph = Omit<SavedGraph, "id" | "name">;
type ChartRow = { date: string; x?: number; y?: number };

const RANGE_LABEL: Record<GraphRangePreset, string> = {
  "30": "Last 30 days",
  "60": "Last 60 days",
  "90": "Last 90 days",
  custom: "Date range",
  all: "All time",
};

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmt(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n)
    ? n.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : "";
}

function fmtDate(date: unknown): string {
  if (typeof date !== "string") return "";
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtAxisDate(date: unknown): string {
  if (typeof date === "number") return new Date(date).toLocaleDateString(undefined, { year: "numeric", month: "short" });
  if (typeof date !== "string") return "";
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, { year: "2-digit", month: "short" });
}

function fmtFullDate(date: unknown): string {
  if (typeof date === "number") return new Date(date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  if (typeof date !== "string") return "";
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const tooltipTheme = {
  contentStyle: {
    backgroundColor: "rgb(var(--card))",
    borderColor: "rgb(var(--border))",
    borderRadius: 8,
    color: "rgb(var(--card-fg))",
    boxShadow: "0 12px 30px rgb(0 0 0 / 0.18)",
  },
  labelStyle: {
    color: "rgb(var(--fg))",
    fontWeight: 600,
  },
  itemStyle: {
    color: "rgb(var(--card-fg))",
  },
} as const;

function defaultDraft(series: SeriesDef[]): DraftGraph {
  const preferred =
    series.find((s) => s.key === "metric:browser_history_scrape.events") ??
    series.find((s) => s.key === "metric:google_activity_scrape.events") ??
    series.find((s) => s.key === "metric:browser_history.visits") ??
    series.find((s) => s.key === "metric:google_myactivity.visits") ??
    series.find((s) => s.key === "metric:chrome.visits") ??
    series[0];
  return {
    xKey: preferred?.key ?? "",
    yKey: "",
    view: "timeline",
    // Default to a bounded window — "all" on a lifetime import draws years of
    // points into the preview before the user asked for them.
    range: preferred ? "90" : "30",
    startDate: preferred ? undefined : shiftDate(todayIso(), -29),
    endDate: todayIso(),
  };
}

function buildSeries(data: JournalData | null): SeriesDef[] {
  if (!data) return [];
  const series: SeriesDef[] = [];

  for (const metric of data.metrics) {
    const values = new Map<string, number>();
    for (const day of data.days) {
      const v = day.values[metric.key]?.num;
      if (typeof v === "number" && Number.isFinite(v)) values.set(day.date, v);
    }
    if (values.size) {
      series.push({ key: `metric:${metric.key}`, label: `${metric.source} · ${metric.metric}`, values });
    }
  }

  const addCount = (key: string, label: string, count: (day: JournalData["days"][number]) => number) => {
    const values = new Map<string, number>();
    for (const day of data.days) values.set(day.date, count(day));
    series.push({ key, label, values });
  };

  addCount("count:data-points", "Count · data points per day", (day) => Object.keys(day.values).length);
  addCount("count:logs", "Count · logs per day", (day) => day.memos.length);
  addCount("count:sessions", "Count · sessions per day", (day) => day.sessions.length);
  addCount(
    "count:activity",
    "Count · all activity per day",
    (day) => Object.keys(day.values).length + day.memos.length + day.sessions.length,
  );

  const sources = [...new Set(data.metrics.map((m) => m.source))].sort();
  for (const source of sources) {
    addCount(`count:source:${source}`, `Count · ${source} points per day`, (day) =>
      Object.keys(day.values).filter((key) => key.startsWith(`${source}.`)).length,
    );
  }

  return series;
}

function rangeDates(graph: Pick<SavedGraph, "range" | "startDate" | "endDate">, dates: string[]) {
  const maxDate = dates[dates.length - 1] ?? todayIso();
  if (graph.range === "all") return { start: "0000-01-01", end: "9999-12-31" };
  if (graph.range === "custom") {
    return {
      start: graph.startDate || "0000-01-01",
      end: graph.endDate || "9999-12-31",
    };
  }
  const days = Number(graph.range);
  return { start: shiftDate(maxDate, -(days - 1)), end: maxDate };
}

function chartRows(
  graph: DraftGraph | SavedGraph,
  series: SeriesDef[],
): { rows: ChartRow[]; x: SeriesDef | undefined; y: SeriesDef | undefined } {
  const x = series.find((s) => s.key === graph.xKey);
  // Data 2 is optional on every view: one pick = one series, two picks = both.
  const y = graph.yKey ? series.find((s) => s.key === graph.yKey) : undefined;
  if (!x) return { rows: [], x, y };

  if (graph.view === "timeline" || graph.view === "candles") {
    const dates = [...new Set([...x.values.keys(), ...(y ? [...y.values.keys()] : [])])].sort();
    const { start, end } = rangeDates(graph, dates);
    return {
      x,
      y,
      rows: dates.filter((d) => d >= start && d <= end).map((date) => ({ date, x: x.values.get(date), y: y?.values.get(date) })),
    };
  }

  // Scatter with one pick charts value vs time; presets anchor to its own days.
  if (!y) {
    const dates = [...x.values.keys()].sort();
    const { start, end } = rangeDates(graph, dates);
    return {
      x,
      y,
      rows: dates.filter((d) => d >= start && d <= end).map((date) => ({ date, x: x.values.get(date) as number })),
    };
  }

  // Scatter presets anchor to the last PAIRED day. Two series with different
  // end dates (a journal that stopped vs live browsing) would otherwise window
  // into a stretch where only one of them exists and plot nothing.
  const paired = [...x.values.keys()].filter((d) => y.values.get(d) != null).sort();
  const { start, end } = rangeDates(graph, paired);
  return {
    x,
    y,
    rows: paired
      .filter((d) => d >= start && d <= end)
      .map((date) => ({ date, x: x.values.get(date) as number, y: y.values.get(date) as number })),
  };
}

function correlation(rows: Array<{ x?: number; y?: number }>): number | null {
  const pts = rows.filter((r): r is { x: number; y: number } => r.x != null && r.y != null);
  if (pts.length < 2) return null;
  const mx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
  const my = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const p of pts) {
    const ox = p.x - mx;
    const oy = p.y - my;
    num += ox * oy;
    dx += ox * ox;
    dy += oy * oy;
  }
  const den = Math.sqrt(dx * dy);
  return den ? num / den : null;
}

interface Candle {
  date: string;
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  n: number;
}

function candleBucket(date: string, mode: "day" | "week" | "month"): string {
  if (mode === "day") return date;
  if (mode === "month") return date.slice(0, 7);
  // Local time like every other date helper here — UTC would shift week
  // boundaries by a day for anyone west of Greenwich.
  const d = new Date(`${date}T00:00:00`);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function candleLabel(bucket: string, mode: "day" | "week" | "month"): string {
  if (mode === "month") return `${bucket}-01`;
  return bucket;
}

function buildCandles(rows: ChartRow[]): { mode: "day" | "week" | "month"; candles: Candle[] } {
  const points = rows.filter((r): r is { date: string; x: number } => typeof r.x === "number" && Number.isFinite(r.x));
  const mode = points.length > 730 ? "month" : points.length > 120 ? "week" : "day";
  const buckets = new Map<string, number[]>();
  for (const p of points) {
    const key = candleBucket(p.date, mode);
    const arr = buckets.get(key) ?? [];
    arr.push(p.x);
    buckets.set(key, arr);
  }
  const candles = [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([bucket, values]) => ({
    date: candleLabel(bucket, mode),
    label: bucket,
    open: values[0],
    high: Math.max(...values),
    low: Math.min(...values),
    close: values[values.length - 1],
    n: values.length,
  }));
  return { mode, candles };
}

function CandleSvg({ rows, label }: { rows: ChartRow[]; label: string }) {
  const { mode, candles } = useMemo(() => buildCandles(rows), [rows]);
  const width = 1000;
  const height = 320;
  const margin = { top: 16, right: 24, bottom: 48, left: 86 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  if (!candles.length) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-fg">No numeric candles in this range.</div>;
  }
  const min = Math.min(...candles.map((c) => c.low));
  const max = Math.max(...candles.map((c) => c.high));
  const pad = Math.max((max - min) * 0.08, max === min ? Math.max(Math.abs(max) * 0.1, 1) : 0);
  const lo = min - pad;
  const hi = max + pad;
  const y = (v: number) => margin.top + ((hi - v) / (hi - lo || 1)) * plotH;
  const x = (i: number) => margin.left + (candles.length === 1 ? plotW / 2 : (i / (candles.length - 1)) * plotW);
  const candleW = Math.max(3, Math.min(18, (plotW / Math.max(candles.length, 1)) * 0.58));
  const yTicks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  const xTicks = candles.filter((_, i) => i === 0 || i === candles.length - 1 || i % Math.max(1, Math.ceil(candles.length / 6)) === 0);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full overflow-visible" role="img" aria-label={`${label} candlestick chart`}>
      <rect x={margin.left} y={margin.top} width={plotW} height={plotH} fill="transparent" />
      {yTicks.map((tick) => (
        <g key={tick}>
          <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} stroke="rgb(var(--border))" strokeDasharray="4 4" />
          <text x={margin.left - 10} y={y(tick) + 4} textAnchor="end" className="fill-muted-fg text-[11px]">
            {fmt(tick)}
          </text>
        </g>
      ))}
      {xTicks.map((tick) => (
        <text key={tick.label} x={x(candles.indexOf(tick))} y={height - 20} textAnchor="middle" className="fill-muted-fg text-[11px]">
          {fmtAxisDate(tick.date)}
        </text>
      ))}
      <text x={margin.left + plotW / 2} y={height - 4} textAnchor="middle" className="fill-muted-fg text-[12px] font-medium">
        Date ({mode} candles)
      </text>
      <text transform={`translate(18 ${margin.top + plotH / 2}) rotate(-90)`} textAnchor="middle" className="fill-muted-fg text-[12px] font-medium">
        {label}
      </text>
      {candles.map((c, i) => {
        const cx = x(i);
        const up = c.close >= c.open;
        const bodyTop = y(Math.max(c.open, c.close));
        const bodyBottom = y(Math.min(c.open, c.close));
        const bodyH = Math.max(2, bodyBottom - bodyTop);
        const color = up ? "rgb(22 163 74)" : "rgb(220 38 38)";
        return (
          <g key={c.label}>
            <title>
              {`${fmtFullDate(c.date)}\nopen ${fmt(c.open)}\nhigh ${fmt(c.high)}\nlow ${fmt(c.low)}\nclose ${fmt(c.close)}\n${c.n} day${c.n === 1 ? "" : "s"}`}
            </title>
            <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth={1.5} />
            <rect x={cx - candleW / 2} y={bodyTop} width={candleW} height={bodyH} rx={1} fill={color} opacity={0.82} />
          </g>
        );
      })}
    </svg>
  );
}

function SearchSelect({
  value,
  options,
  onChange,
  placeholder,
  allowEmpty,
  className,
}: {
  value: string;
  options: SeriesDef[];
  onChange: (value: string) => void;
  placeholder: string;
  allowEmpty?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.key === value);
  const filtered = options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 80);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative min-w-0", className)}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
        className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-bg px-2.5 text-left text-[13px] text-fg transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className={cn("truncate", selected ? "" : "text-muted-fg")}>{selected?.label ?? placeholder}</span>
        <span className="shrink-0 text-muted-fg">⌄</span>
      </button>
      {open ? (
        <div className="absolute left-0 top-9 z-30 w-[min(360px,90vw)] overflow-hidden rounded-lg border border-border bg-card shadow-lg">
          <div className="border-b border-border p-2">
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search data"
              className="h-8 text-[13px]"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {allowEmpty ? (
              <button
                type="button"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
                className="block w-full px-3 py-1.5 text-left text-[13px] text-muted-fg hover:bg-muted"
              >
                None
              </button>
            ) : null}
            {filtered.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => {
                  onChange(option.key);
                  setOpen(false);
                }}
                className={cn(
                  "block w-full truncate px-3 py-1.5 text-left text-[13px] hover:bg-muted",
                  option.key === value ? "bg-muted text-fg" : "text-card-fg",
                )}
              >
                {option.label}
              </button>
            ))}
            {!filtered.length ? <div className="px-3 py-3 text-[13px] text-muted-fg">No matches</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GraphCard({
  graph,
  series,
  onDelete,
  draft,
}: {
  graph: DraftGraph | SavedGraph;
  series: SeriesDef[];
  onDelete?: () => void;
  draft?: boolean;
}) {
  const { rows, x, y } = useMemo(() => chartRows(graph, series), [graph, series]);
  // Remount the chart when the picked series/range change — recharts keeps
  // stale marks when only `data` swaps under it.
  const chartKey = `${graph.view}:${graph.xKey}:${graph.yKey}:${graph.range}:${graph.startDate ?? ""}:${graph.endDate ?? ""}`;
  const r = graph.view === "correlation" ? correlation(rows) : null;
  const title =
    "name" in graph
      ? graph.name
      : graph.view === "candles"
        ? `${x?.label ?? "Series"} candles`
        : graph.view === "correlation"
          ? y
            ? `${x?.label ?? "Series"} vs ${y.label}`
            : `${x?.label ?? "Series"} over time`
          : y
            ? `${x?.label ?? "Series"} + ${y.label}`
            : `${x?.label ?? "Series"} timeline`;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-fg">{title}</h2>
          <p className="mt-1 text-xs text-muted-fg">
            {RANGE_LABEL[graph.range]} · {rows.length} point{rows.length === 1 ? "" : "s"}
            {r == null ? "" : ` · r ${r.toFixed(2)}`}
          </p>
        </div>
        {onDelete ? (
          <Button type="button" size="sm" variant="ghost" onClick={onDelete} aria-label="Delete graph" title="Delete graph">
            <Trash width={15} height={15} />
          </Button>
        ) : draft ? (
          <span className="rounded-full bg-muted px-2 py-1 text-[11px] font-medium text-muted-fg">Preview</span>
        ) : null}
      </div>

      <div className="h-[320px] px-3 py-4">
        {!x ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-fg">Choose data to graph.</div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-fg">No points in this time range.</div>
        ) : graph.view === "candles" ? (
          <CandleSvg rows={rows} label={x.label} />
        ) : graph.view === "timeline" ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart key={chartKey} data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="rgb(var(--border))" strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fill: "rgb(var(--muted-fg))", fontSize: 12 }}
                tickFormatter={fmtDate}
                tickMargin={8}
                minTickGap={18}
                interval="preserveStartEnd"
              />
              <YAxis yAxisId="left" tick={{ fill: "rgb(var(--muted-fg))", fontSize: 12 }} tickFormatter={fmt} width={46} />
              {y ? (
                // Second series gets its own axis — two metrics rarely share a scale,
                // and on one axis the smaller one flattens into a floor line.
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fill: "#2563eb", fontSize: 12 }}
                  tickFormatter={fmt}
                  width={46}
                />
              ) : null}
              <Tooltip
                {...tooltipTheme}
                // Keep both series in the tooltip even when one has no value on
                // the hovered day — dropping it reads as "the chart lost my data".
                filterNull={false}
                formatter={(value) => (typeof value === "number" ? fmt(value) : "–")}
                labelFormatter={(label) => fmtDate(label)}
              />
              <Legend />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="x"
                name={x.label}
                stroke="rgb(var(--accent))"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
              {y ? (
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="y"
                  name={y.label}
                  stroke="#2563eb"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              ) : null}
            </LineChart>
          </ResponsiveContainer>
        ) : y ? (
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart key={chartKey} margin={{ top: 8, right: 16, bottom: 12, left: 0 }}>
              <CartesianGrid stroke="rgb(var(--border))" strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="x"
                name={x.label}
                tick={{ fill: "rgb(var(--muted-fg))", fontSize: 12 }}
                tickFormatter={fmt}
              />
              <YAxis
                type="number"
                dataKey="y"
                name={y.label}
                tick={{ fill: "rgb(var(--muted-fg))", fontSize: 12 }}
                tickFormatter={fmt}
                width={46}
              />
              <Tooltip
                {...tooltipTheme}
                cursor={{ strokeDasharray: "3 3" }}
                formatter={(value) => (typeof value === "number" ? fmt(value) : "–")}
                labelFormatter={(_, payload) => fmtDate(payload?.[0]?.payload?.date)}
              />
              <Scatter name={`${x.label} vs ${y.label}`} data={rows} fill="rgb(var(--accent))" isAnimationActive={false} />
            </ScatterChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart key={chartKey} margin={{ top: 8, right: 16, bottom: 12, left: 0 }}>
              <CartesianGrid stroke="rgb(var(--border))" strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="t"
                name="Date"
                domain={["dataMin", "dataMax"]}
                tick={{ fill: "rgb(var(--muted-fg))", fontSize: 12 }}
                tickFormatter={fmtAxisDate}
                minTickGap={24}
              />
              <YAxis
                type="number"
                dataKey="x"
                name={x.label}
                tick={{ fill: "rgb(var(--muted-fg))", fontSize: 12 }}
                tickFormatter={fmt}
                width={46}
              />
              <Tooltip
                {...tooltipTheme}
                cursor={{ strokeDasharray: "3 3" }}
                formatter={(value, name) => (name === "Date" ? [fmtFullDate(value), "Date"] : [fmt(value), x.label])}
                labelFormatter={(_, payload) => fmtDate(payload?.[0]?.payload?.date)}
              />
              <Scatter
                name={`${x.label} over time`}
                data={rows.map((row) => ({ ...row, t: new Date(`${row.date}T00:00:00`).getTime() }))}
                fill="rgb(var(--accent))"
                isAnimationActive={false}
              />
            </ScatterChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

/** Numbers-only full history. Its own cache key — the same bytes are re-derived on
 *  every visit to Graphs otherwise, and on a lifetime record that is the single
 *  most expensive request the app makes. */
const GRAPHS_JOURNAL = "/api/journal?days=all&numeric=1";

export function GraphsWorkspace() {
  const [data, setData] = useState<JournalData | null>(() => peekCache<JournalData>(GRAPHS_JOURNAL) ?? null);
  const [graphs, setGraphs] = useState<SavedGraph[]>([]);
  const [loading, setLoading] = useState(() => peekCache<JournalData>(GRAPHS_JOURNAL) === undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [journal, saved] = await Promise.all([
        // Full history, numbers only — graphs never read the (huge) cell text.
        fetch(GRAPHS_JOURNAL).then((r) => (r.ok ? (r.json() as Promise<JournalData>) : null)),
        fetch("/api/graphs")
          .then((r) => (r.ok ? (r.json() as Promise<{ graphs: SavedGraph[] }>) : { graphs: [] }))
          .catch(() => ({ graphs: [] as SavedGraph[] })),
      ]);
      if (!alive) return;
      // Keep whatever is already drawn if the refresh came back empty.
      if (journal) {
        setData(journal);
        primeCache(GRAPHS_JOURNAL, journal);
      }
      setGraphs(saved.graphs ?? []);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const series = useMemo(() => buildSeries(data), [data]);
  const [draft, setDraft] = useState<DraftGraph>(() => defaultDraft([]));

  useEffect(() => {
    setDraft((prev) => {
      if (prev.xKey && series.some((s) => s.key === prev.xKey)) {
        if (!prev.yKey || series.some((s) => s.key === prev.yKey)) return prev;
      }
      return defaultDraft(series);
    });
  }, [series]);

  const persistGraphs = useCallback(async (next: SavedGraph[]) => {
    setGraphs(next);
    setSaving(true);
    try {
      const res = await fetch("/api/graphs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ graphs: next }),
      });
      if (res.ok) {
        const body = (await res.json()) as { graphs: SavedGraph[] };
        setGraphs(body.graphs ?? next);
      }
    } finally {
      setSaving(false);
    }
  }, []);

  const saveDraft = () => {
    const x = series.find((s) => s.key === draft.xKey);
    const y = series.find((s) => s.key === draft.yKey);
    if (!x) return;
    const graph: SavedGraph = {
      ...draft,
      // Candles chart a single series; every other view keeps whatever was picked.
      yKey: draft.view === "candles" ? "" : draft.yKey,
      id: uid(),
      name:
        draft.view === "candles"
          ? `${x.label} candles`
          : draft.view === "correlation"
            ? y
              ? `${x.label} vs ${y.label}`
              : `${x.label} over time`
            : y
              ? `${x.label} + ${y.label}`
              : `${x.label} timeline`,
    };
    void persistGraphs([graph, ...graphs]);
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <SkeletonRows rows={3} rowClassName="h-40" label="Loading your graphs" />
      </div>
    );
  }

  if (!series.length) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm font-medium text-fg">No graphable data yet.</p>
        <p className="mt-1 text-sm text-muted-fg">Import or add daily data, then come back to build timelines and correlations.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={draft.view}
            onChange={(e) => {
              const view = e.target.value as GraphViewType;
              // Candles chart one series; the other views keep both picks.
              setDraft((g) => ({ ...g, view, yKey: view === "candles" ? "" : g.yKey }));
            }}
            className="h-8 w-full text-[13px] sm:w-[136px]"
            aria-label="Graph type"
          >
            <option value="timeline">Lines</option>
            <option value="candles">Candles</option>
            <option value="correlation">Scatter</option>
          </Select>
          <SearchSelect
            value={draft.xKey}
            options={series}
            onChange={(value) => setDraft((g) => ({ ...g, xKey: value }))}
            placeholder="Data 1"
            className="w-full sm:w-[240px] lg:flex-1"
          />
          {draft.view !== "candles" ? (
            <SearchSelect
              value={draft.yKey}
              options={series}
              onChange={(value) => setDraft((g) => ({ ...g, yKey: value }))}
              placeholder="Data 2 (optional)"
              allowEmpty
              className="w-full sm:w-[240px] lg:flex-1"
            />
          ) : null}
          <RangePicker
            value={draft.range}
            onChange={(range) => setDraft((g) => ({ ...g, range }))}
            startDate={draft.startDate ?? ""}
            endDate={draft.endDate ?? ""}
            onStartDate={(v) => setDraft((g) => ({ ...g, startDate: v }))}
            onEndDate={(v) => setDraft((g) => ({ ...g, endDate: v }))}
          />
          <Button
            type="button"
            size="sm"
            onClick={saveDraft}
            disabled={saving || !draft.xKey}
            className="w-full sm:w-auto"
          >
            <Plus width={15} height={15} /> Save
          </Button>
        </div>
      </Card>

      <GraphCard graph={draft} series={series} draft />

      <div className={cn("grid gap-4", graphs.length > 1 ? "xl:grid-cols-2" : "")}>
        {graphs.map((graph) => (
          <GraphCard
            key={graph.id}
            graph={graph}
            series={series}
            onDelete={() => void persistGraphs(graphs.filter((g) => g.id !== graph.id))}
          />
        ))}
      </div>
    </div>
  );
}

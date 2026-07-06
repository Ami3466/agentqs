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
import { Button, Card, Input, Select, cn } from "./ui";
import { Plus, Spinner, Trash } from "./icons";

interface SeriesDef {
  key: string;
  label: string;
  values: Map<string, number>;
}

type DraftGraph = Omit<SavedGraph, "id" | "name">;

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

function defaultDraft(series: SeriesDef[]): DraftGraph {
  return {
    xKey: series[0]?.key ?? "",
    yKey: series[1]?.key ?? series[0]?.key ?? "",
    view: "correlation",
    range: "30",
    startDate: shiftDate(todayIso(), -29),
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

function chartRows(graph: DraftGraph | SavedGraph, series: SeriesDef[]) {
  const x = series.find((s) => s.key === graph.xKey);
  const y = series.find((s) => s.key === graph.yKey);
  if (!x) return { rows: [], x, y };
  const dates = [...new Set([...x.values.keys(), ...(y ? [...y.values.keys()] : [])])].sort();
  const { start, end } = rangeDates(graph, dates);
  const filtered = dates.filter((d) => d >= start && d <= end);

  if (graph.view === "timeline") {
    return {
      x,
      y,
      rows: filtered.map((date) => ({ date, x: x.values.get(date), y: y?.values.get(date) })),
    };
  }

  return {
    x,
    y,
    rows: filtered
      .map((date) => ({ date, x: x.values.get(date), y: y?.values.get(date) }))
      .filter((row): row is { date: string; x: number; y: number } => row.x != null && row.y != null),
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
  const r = graph.view === "correlation" ? correlation(rows) : null;
  const title =
    "name" in graph
      ? graph.name
      : graph.view === "timeline"
        ? `${x?.label ?? "Series"} timeline`
        : `${x?.label ?? "Series"} vs ${y?.label ?? "Series"}`;

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
        {!x || (graph.view === "correlation" && !y) ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-fg">Choose data to graph.</div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-fg">No points in this time range.</div>
        ) : graph.view === "timeline" ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="rgb(var(--border))" strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fill: "rgb(var(--muted-fg))", fontSize: 12 }} tickMargin={8} />
              <YAxis tick={{ fill: "rgb(var(--muted-fg))", fontSize: 12 }} tickFormatter={fmt} width={46} />
              <Tooltip
                formatter={(value, name) => [fmt(value), name === "x" ? x.label : y?.label]}
                labelFormatter={(label) => String(label)}
              />
              <Legend />
              <Line type="monotone" dataKey="x" name={x.label} stroke="rgb(var(--accent))" strokeWidth={2} dot={false} connectNulls />
              {y ? (
                <Line type="monotone" dataKey="y" name={y.label} stroke="#2563eb" strokeWidth={2} dot={false} connectNulls />
              ) : null}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 16, bottom: 12, left: 0 }}>
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
                name={y?.label}
                tick={{ fill: "rgb(var(--muted-fg))", fontSize: 12 }}
                tickFormatter={fmt}
                width={46}
              />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                formatter={(value, name) => [fmt(value), name === "x" ? x.label : y?.label]}
                labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ""}
              />
              <Scatter name={`${x.label} vs ${y?.label}`} data={rows} fill="rgb(var(--accent))" />
            </ScatterChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

export function GraphsWorkspace() {
  const [data, setData] = useState<JournalData | null>(null);
  const [graphs, setGraphs] = useState<SavedGraph[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [journal, saved] = await Promise.all([
        fetch("/api/journal").then((r) => (r.ok ? (r.json() as Promise<JournalData>) : null)),
        fetch("/api/graphs")
          .then((r) => (r.ok ? (r.json() as Promise<{ graphs: SavedGraph[] }>) : { graphs: [] }))
          .catch(() => ({ graphs: [] as SavedGraph[] })),
      ]);
      if (!alive) return;
      setData(journal);
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
      if (prev.xKey && series.some((s) => s.key === prev.xKey)) return prev;
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
    if (!x || (draft.view === "correlation" && !y)) return;
    const graph: SavedGraph = {
      ...draft,
      id: uid(),
      name: draft.view === "timeline" ? `${x.label} timeline` : `${x.label} vs ${y?.label}`,
    };
    void persistGraphs([graph, ...graphs]);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card py-20 text-sm text-muted-fg">
        <Spinner width={16} height={16} /> Loading…
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
          <SearchSelect
            value={draft.xKey}
            options={series}
            onChange={(value) => setDraft((g) => ({ ...g, xKey: value }))}
            placeholder="First data"
            className="w-full sm:w-[240px] lg:flex-1"
          />
          <SearchSelect
            value={draft.yKey}
            options={series}
            onChange={(value) => setDraft((g) => ({ ...g, yKey: value }))}
            placeholder="Second data"
            allowEmpty={draft.view === "timeline"}
            className="w-full sm:w-[240px] lg:flex-1"
          />
          <Select
            value={draft.view}
            onChange={(e) => setDraft((g) => ({ ...g, view: e.target.value as GraphViewType }))}
            className="h-8 w-full text-[13px] sm:w-[132px]"
            aria-label="View type"
          >
            <option value="correlation">Points</option>
            <option value="timeline">Timeline</option>
          </Select>
          <Select
            value={draft.range}
            onChange={(e) => setDraft((g) => ({ ...g, range: e.target.value as GraphRangePreset }))}
            className="h-8 w-full text-[13px] sm:w-[142px]"
            aria-label="Time range"
          >
            <option value="30">Last 30</option>
            <option value="60">Last 60</option>
            <option value="90">Last 90</option>
            <option value="custom">Date range</option>
            <option value="all">All time</option>
          </Select>
          {draft.range === "custom" ? (
            <>
              <Input
                type="date"
                value={draft.startDate ?? ""}
                onChange={(e) => setDraft((g) => ({ ...g, startDate: e.target.value }))}
                className="h-8 w-full text-[13px] sm:w-[142px]"
                aria-label="Start date"
              />
              <Input
                type="date"
                value={draft.endDate ?? ""}
                onChange={(e) => setDraft((g) => ({ ...g, endDate: e.target.value }))}
                className="h-8 w-full text-[13px] sm:w-[142px]"
                aria-label="End date"
              />
            </>
          ) : null}
          <Button
            type="button"
            size="sm"
            onClick={saveDraft}
            disabled={saving || !draft.xKey || (draft.view === "correlation" && !draft.yKey)}
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

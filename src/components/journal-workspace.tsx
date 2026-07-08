"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { JournalTimeline } from "./journal-timeline";
import { JournalTable } from "./journal-table";
import { JournalSearch } from "./journal-search";
import { cn } from "./ui";
import { Spinner, X } from "./icons";
import type { JournalData, JournalView } from "@/lib/journal";

type Mode = "timeline" | "table";
const MODE_KEY = "agentqs_journal_mode";
const MODE_LABEL: Record<Mode, string> = { table: "Table", timeline: "Timeline" };

/** Type filter values: everything, one source's metrics, or just memos/sessions. */
type TypeFilter = "all" | "memos" | "sessions" | `src:${string}`;

/** Dev recompiles briefly 404 API routes (see next.config.mjs watchOptions note),
 * and one failed fetch used to leave the Journal on "Loading…" forever. Retry a
 * few times before declaring the load failed. */
async function fetchJournalRetrying(url: string, attempts = 3): Promise<JournalData | null> {
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500 * i));
    try {
      const res = await fetch(url);
      if (res.ok) return (await res.json()) as JournalData;
    } catch {
      /* retry */
    }
  }
  return null;
}

/**
 * Client shell for the Journal tab. Fetches the pivoted per-day record once and
 * hands it to either the narrative Timeline or the TanStack Table. Saved views
 * are loaded from / persisted to config (per user) via /api/journal/views.
 */
export function JournalWorkspace() {
  const [data, setData] = useState<JournalData | null>(null);
  const [views, setViews] = useState<JournalView[]>([]);
  const [mode, setMode] = useState<Mode>("table");
  const [loading, setLoading] = useState(true);
  // A lifetime record is thousands of days — load a recent window instantly and
  // fetch the full history only when asked.
  const [fullHistory, setFullHistory] = useState(false);
  const [loadingFull, setLoadingFull] = useState(false);

  // ---- filters (date range + data type) ----
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const filtersActive = typeFilter !== "all" || !!dateFrom || !!dateTo;

  const sources = useMemo(
    () => (data ? [...new Set(data.metrics.map((m) => m.source))].sort() : []),
    [data],
  );
  const hasMemos = useMemo(() => !!data?.days.some((d) => d.memos.length), [data]);
  const hasSessions = useMemo(() => !!data?.days.some((d) => d.sessions.length), [data]);

  /** Days narrowed by the filters. The Table keeps every cell (columns of other
   * sources are hidden via `sourceFilter`, so the saved layout stays intact);
   * the Timeline strips non-matching content so a day shows only what was asked. */
  const filtered = useMemo<JournalData | null>(() => {
    if (!data || !filtersActive) return data;
    let days = data.days.filter(
      (d) => (!dateFrom || d.date >= dateFrom) && (!dateTo || d.date <= dateTo),
    );
    if (typeFilter === "memos") {
      days = days.filter((d) => d.memos.length);
      if (mode === "timeline") days = days.map((d) => ({ ...d, values: {}, sessions: [] }));
    } else if (typeFilter === "sessions") {
      days = days.filter((d) => d.sessions.length);
      if (mode === "timeline") days = days.map((d) => ({ ...d, values: {}, memos: [] }));
    } else if (typeFilter.startsWith("src:")) {
      const src = typeFilter.slice(4);
      const keys = new Set(data.metrics.filter((m) => m.source === src).map((m) => m.key));
      days = days.filter((d) => Object.keys(d.values).some((k) => keys.has(k)));
      if (mode === "timeline") {
        days = days.map((d) => ({
          ...d,
          values: Object.fromEntries(Object.entries(d.values).filter(([k]) => keys.has(k))),
          memos: [],
          sessions: [],
        }));
      }
    }
    return { ...data, days };
  }, [data, filtersActive, dateFrom, dateTo, typeFilter, mode]);

  const clearFilters = () => {
    setTypeFilter("all");
    setDateFrom("");
    setDateTo("");
  };

  // restore last-used view mode
  useEffect(() => {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "table" || saved === "timeline") setMode(saved);
  }, []);

  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    const [d, v] = await Promise.all([
      fetchJournalRetrying("/api/journal?days=180"),
      fetch("/api/journal/views")
        .then((r) => (r.ok ? (r.json() as Promise<{ views: JournalView[] }>) : { views: [] }))
        .catch(() => ({ views: [] as JournalView[] })),
    ]);
    setData(d);
    setViews(v?.views ?? []);
    setLoadError(!d);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadFullHistory = useCallback(async () => {
    setLoadingFull(true);
    try {
      const d = await fetchJournalRetrying("/api/journal?days=all");
      if (d) {
        setData(d);
        setFullHistory(true);
      }
    } finally {
      setLoadingFull(false);
    }
  }, []);

  const setModePersist = (m: Mode) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
  };

  const persistViews = useCallback(async (next: JournalView[]) => {
    setViews(next); // optimistic
    try {
      const res = await fetch("/api/journal/views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ views: next }),
      });
      if (res.ok) {
        const body = (await res.json()) as { views: JournalView[] };
        if (Array.isArray(body.views)) setViews(body.views);
      }
    } catch {
      /* keep optimistic state */
    }
  }, []);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="text-sm text-muted-fg">
          {data
            ? `${data.totalDays.toLocaleString()} day${data.totalDays === 1 ? "" : "s"} · ${data.totalCells.toLocaleString()} data point${data.totalCells === 1 ? "" : "s"}` +
              (fullHistory || data.days.length >= data.totalDays ? "" : ` · showing last ${data.days.length.toLocaleString()}`)
            : " "}
        </p>
        <div className="flex rounded-lg border border-border bg-card p-0.5 text-sm">
          {(["table", "timeline"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setModePersist(m)}
              className={cn(
                "rounded-md px-3 py-1.5 font-medium transition-colors",
                mode === m ? "bg-muted text-fg" : "text-muted-fg hover:text-fg",
              )}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>

      <JournalSearch />

      {data ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
            className="h-8 rounded-lg border border-border bg-card px-2 text-[13px] text-fg focus-visible:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <option value="all">All data</option>
            {sources.map((s) => (
              <option key={s} value={`src:${s}`}>
                {s}
              </option>
            ))}
            {hasMemos ? <option value="memos">Memos</option> : null}
            {hasSessions ? <option value="sessions">Sessions</option> : null}
          </select>
          <input
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => setDateFrom(e.target.value)}
            aria-label="From date"
            className="h-8 rounded-lg border border-border bg-card px-2 text-[13px] text-fg focus-visible:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <span className="text-[13px] text-muted-fg">to</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => setDateTo(e.target.value)}
            aria-label="To date"
            className="h-8 rounded-lg border border-border bg-card px-2 text-[13px] text-fg focus-visible:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          {filtersActive ? (
            <>
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-card px-2.5 text-[13px] font-medium text-muted-fg transition-colors hover:bg-muted hover:text-fg"
              >
                <X width={12} height={12} />
                Clear
              </button>
              {filtered ? (
                <span className="text-[11px] text-muted-fg">
                  {filtered.days.length.toLocaleString()} day
                  {filtered.days.length === 1 ? "" : "s"} match
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card py-20 text-sm text-muted-fg">
          <Spinner width={16} height={16} /> Loading…
        </div>
      ) : loadError || !data || !filtered ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-16 text-center">
          <p className="text-sm text-muted-fg">
            Could not load the journal. The server may be restarting.
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-fg transition-colors hover:bg-muted"
          >
            Retry
          </button>
        </div>
      ) : mode === "timeline" ? (
        <JournalTimeline data={filtered} />
      ) : (
        <JournalTable
          data={filtered}
          views={views}
          onViewsChange={persistViews}
          onData={setData}
          sourceFilter={typeFilter.startsWith("src:") ? typeFilter.slice(4) : null}
          fullHistory={fullHistory || data.days.length >= data.totalDays}
          loadingFull={loadingFull}
          onLoadFullHistory={() => void loadFullHistory()}
        />
      )}
    </div>
  );
}

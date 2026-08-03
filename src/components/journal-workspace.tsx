"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { JournalTimeline } from "./journal-timeline";
import { JournalTable } from "./journal-table";
import { JournalSearch } from "./journal-search";
import { CoverageGrid } from "./coverage-grid";
import { RangePicker, rangeStart } from "./range-picker";
import { Button, Segmented, Select, SkeletonRows } from "./ui";
import { peekCache, primeCache } from "@/lib/client-cache";
import { Spinner, X } from "./icons";
import type { GraphRangePreset } from "@/lib/graphs";
import type { JournalData, JournalView } from "@/lib/journal";

/** Three readings of the same record: the grid of days, the narrative, and the
 *  source×year map of what exists at all (the same panel Pipeline shows). */
type Mode = "timeline" | "table" | "coverage";
const MODE_KEY = "agentqs_journal_mode";
const MODE_OPTIONS = [
  { value: "table", label: "Table" },
  { value: "timeline", label: "Timeline" },
  { value: "coverage", label: "Coverage" },
] as const;
const MODES = MODE_OPTIONS.map((o) => o.value) as readonly string[];

/** Type filter values: everything, one source's metrics, one metric column
 * (set by clicking a tag in the Timeline), or just memos/sessions. */
type TypeFilter = "all" | "memos" | "sessions" | `src:${string}` | `met:${string}`;

/** The two windows the Journal asks for. Also the cache keys, so the recent window
 *  and the full history are remembered separately instead of clobbering each
 *  other — a lifetime record is megabytes and must never be refetched per tab. */
const PAGE_DAYS = 180;
const JOURNAL_WINDOW = `/api/journal?days=${PAGE_DAYS}`;
/** One page older than `before`. "Load full history" used to be a single
 *  `days=all` request, which serializes the ENTIRE grid — 13MB on this record, 40MB
 *  on a million-cell one — to show fifty more rows. It now walks back a page at a
 *  time, so the wait is bounded and the table keeps rendering between pages. */
const journalPage = (before: string) => `/api/journal?days=${PAGE_DAYS}&before=${encodeURIComponent(before)}`;

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
  // Deep link from the Pipeline tab: /journal?source=<id> opens pre-filtered to
  // that source. useSearchParams (not window.location) so a client-side
  // navigation sees the NEW url on first render.
  const urlSource = useSearchParams().get("source");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(urlSource ? `src:${urlSource}` : "all");
  const [range, setRange] = useState<GraphRangePreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const dateFrom = rangeStart(range, customFrom);
  const dateTo = range === "custom" ? customTo : "";
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
    } else if (typeFilter.startsWith("met:")) {
      const key = typeFilter.slice(4);
      days = days.filter((d) => d.values[key] !== undefined);
      if (mode === "timeline") {
        days = days.map((d) => ({
          ...d,
          values: d.values[key] !== undefined ? { [key]: d.values[key] } : {},
          memos: [],
          sessions: [],
        }));
      }
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
    setRange("all");
    setCustomFrom("");
    setCustomTo("");
  };

  /** The metric behind an active `met:` filter (label for the type select). */
  const activeMetric = useMemo(
    () =>
      typeFilter.startsWith("met:")
        ? (data?.metrics.find((m) => m.key === typeFilter.slice(4)) ?? null)
        : null,
    [typeFilter, data],
  );

  // restore last-used view mode
  useEffect(() => {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved && MODES.includes(saved)) setMode(saved as Mode);
  }, []);

  // Mirror the source filter into the URL so a reload keeps it, Clear really
  // clears it, and the filtered view is shareable/bookmarkable.
  useEffect(() => {
    const url = new URL(window.location.href);
    const next = typeFilter.startsWith("src:") ? typeFilter.slice(4) : null;
    if ((url.searchParams.get("source") ?? null) === next) return;
    if (next) url.searchParams.set("source", next);
    else url.searchParams.delete("source");
    window.history.replaceState(null, "", url);
  }, [typeFilter]);

  // Follow LATER url changes too — a same-route navigation (the Journal tab
  // link, a history jump) drops or changes ?source while this stays mounted.
  useEffect(() => {
    setTypeFilter((cur) =>
      urlSource ? `src:${urlSource}` : cur.startsWith("src:") ? "all" : cur,
    );
  }, [urlSource]);

  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    // Always the first page. A deep-linked filter is still a whole-record question,
    // but answering it no longer means downloading the whole record up front: this
    // page renders immediately and `needsFull` pages the rest in behind it.
    const url = JOURNAL_WINDOW;
    // Cached from a previous visit → render it NOW and refresh underneath. Only a
    // cold start shows a loading state; switching tabs never does.
    const seed = peekCache<JournalData>(url);
    if (seed) setData(seed);
    setLoading(!seed);
    setLoadError(false);
    const [d, v] = await Promise.all([
      fetchJournalRetrying(url),
      fetch("/api/journal/views")
        .then((r) => (r.ok ? (r.json() as Promise<{ views: JournalView[] }>) : { views: [] }))
        .catch(() => ({ views: [] as JournalView[] })),
    ]);
    if (d) {
      setData(d);
      primeCache(url, d);
      setFullHistory(!d.hasMore);
    }
    setViews(v?.views ?? []);
    // A failed refresh over data already on screen is not an empty Journal.
    setLoadError(!d && !seed);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Walk back through the record a page at a time, appending as each lands, until
   *  there is nothing older. Bounded work per request instead of one giant one, and
   *  the rows already on screen stay interactive throughout. */
  const loadFullHistory = useCallback(async () => {
    setLoadingFull(true);
    try {
      for (let guard = 0; guard < 200; guard++) {
        // Read the cursor off the latest state rather than a captured copy, so
        // successive pages chain correctly.
        let cursor = "";
        setData((cur) => {
          cursor = cur?.oldest ?? "";
          return cur;
        });
        if (!cursor) break;
        const page = await fetchJournalRetrying(journalPage(cursor));
        if (!page) break;
        let done = false;
        setData((cur) => {
          if (!cur) return page;
          const seen = new Set(cur.days.map((d) => d.date));
          const merged = [...cur.days, ...page.days.filter((d) => !seen.has(d.date))];
          done = !page.hasMore;
          return { ...cur, days: merged, hasMore: page.hasMore, oldest: page.oldest ?? cur.oldest };
        });
        if (done) break;
      }
      setFullHistory(true);
    } finally {
      setLoadingFull(false);
    }
  }, []);

  /** A filter is a question about the WHOLE record — answering it from the
   * 180-day window silently lies (a source whose data is older shows as one
   * day). The first time any filter narrows the view, upgrade to full history.
   * One auto attempt only: a failed days=all fetch must NOT relaunch itself
   * forever (needsFull would stay true) — the table's manual button remains. */
  const fullAttempted = useRef(false);
  const windowed = !!data && !fullHistory && (data.hasMore || data.days.length < data.totalDays);
  const oldestLoaded = data?.days.length ? data.days[data.days.length - 1].date : "";
  const needsFull =
    windowed &&
    (typeFilter !== "all" ||
      (!!dateFrom && dateFrom < oldestLoaded) ||
      (!!dateTo && dateTo < oldestLoaded));
  useEffect(() => {
    if (needsFull && !loadingFull && !fullAttempted.current) {
      fullAttempted.current = true;
      void loadFullHistory();
    }
  }, [needsFull, loadingFull, loadFullHistory]);

  /** Quiet refetch (column scanner merges): refresh the data in place without
   * flipping `loading`, so the Table — and the scanner's result panel — stay
   * mounted. */
  const reload = useCallback(async () => {
    const d = await fetchJournalRetrying(JOURNAL_WINDOW);
    if (d) setData(d);
  }, [fullHistory]);

  const setModePersist = (m: Mode) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
  };

  /** A tag clicked in the Timeline: filter to it and jump to the Table, which
   * shows every day logged under that source/metric. */
  const drillToTable = (filter: TypeFilter) => {
    setTypeFilter(filter);
    setModePersist("table");
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
            ? `${data.totalDays.toLocaleString()} day${data.totalDays === 1 ? "" : "s"} · ${(data.totalCells + (data.totalEvents || 0)).toLocaleString()} data points` +
              ((data.totalEvents || 0) > 0 ? ` (${data.totalEvents.toLocaleString()} events · ${data.totalCells.toLocaleString()} daily)` : "") +
              (fullHistory || data.days.length >= data.totalDays ? "" : ` · showing last ${data.days.length.toLocaleString()}`)
            : " "}
        </p>
        <Segmented
          options={MODE_OPTIONS}
          value={mode}
          onChange={setModePersist}
          aria-label="View mode"
        />
      </div>

      {/* Coverage answers a whole-record question — a date range or type filter has
          nothing to narrow there, so the bar goes away instead of sitting dead. */}
      {data && mode !== "coverage" ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <JournalSearch />
          <Select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
            aria-label="Data type"
            className="h-8 w-[168px] text-[13px]"
          >
            <option value="all">All data</option>
            {sources.map((s) => (
              <option key={s} value={`src:${s}`}>
                {s}
              </option>
            ))}
            {/* Deep-linked source with no daily columns (e.g. events-only) —
                keep the select honest instead of snapping back to "All data". */}
            {typeFilter.startsWith("src:") && !sources.includes(typeFilter.slice(4)) ? (
              <option value={typeFilter}>{typeFilter.slice(4)}</option>
            ) : null}
            {hasMemos ? <option value="memos">Memos</option> : null}
            {hasSessions ? <option value="sessions">Sessions</option> : null}
            {typeFilter.startsWith("met:") ? (
              <option value={typeFilter}>
                {activeMetric
                  ? `${activeMetric.source} · ${activeMetric.metric}`
                  : typeFilter.slice(4)}
              </option>
            ) : null}
          </Select>
          <RangePicker
            value={range}
            onChange={setRange}
            startDate={customFrom}
            endDate={customTo}
            onStartDate={setCustomFrom}
            onEndDate={setCustomTo}
          />
          {filtersActive ? (
            <>
              <Button size="sm" variant="secondary" onClick={clearFilters}>
                <X width={12} height={12} />
                Clear
              </Button>
              {loadingFull ? (
                <span className="flex items-center gap-1 text-[11px] text-muted-fg">
                  <Spinner width={11} height={11} /> loading full history…
                </span>
              ) : filtered ? (
                <span className="text-[11px] text-muted-fg">
                  {filtered.days.length.toLocaleString()} day
                  {filtered.days.length === 1 ? "" : "s"} match
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {/* Ahead of the journal's own load gate: coverage reads /api/coverage, so it
          renders while the megabyte-scale day payload is still on the wire. */}
      {mode === "coverage" ? (
        <CoverageGrid
          tall
          onSourceClick={(source) => drillToTable(`src:${source}`)}
          emptyHint="No data yet. Connect a source in Pipeline to fill this in."
        />
      ) : loading ? (
        <div className="rounded-xl border border-border bg-card p-4">
          <SkeletonRows rows={10} rowClassName="h-9" label="Loading your journal" />
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
        <JournalTimeline
          data={filtered}
          onMetricClick={(key) => drillToTable(`met:${key}`)}
          onSourceClick={(source) => drillToTable(`src:${source}`)}
        />
      ) : (
        <JournalTable
          data={filtered}
          views={views}
          onViewsChange={persistViews}
          onData={setData}
          onReload={() => void reload()}
          sourceFilter={typeFilter.startsWith("src:") ? typeFilter.slice(4) : null}
          metricFilter={typeFilter.startsWith("met:") ? typeFilter.slice(4) : null}
          fullHistory={fullHistory || data.days.length >= data.totalDays}
          loadingFull={loadingFull}
          onLoadFullHistory={() => void loadFullHistory()}
        />
      )}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnOrderState,
  type ColumnSizingState,
  type VisibilityState,
} from "@tanstack/react-table";
import type { JournalData, JournalDay, JournalView } from "@/lib/journal";
import { Button, cn } from "./ui";
import { invalidate } from "@/lib/client-cache";
import { Bookmark, GripVertical, Pencil, Plus, Spinner, X } from "./icons";
import { DataQualityPanel } from "./data-quality";

interface ColMeta {
  source?: string;
  metric?: string;
  numeric?: boolean;
}

type EditOp =
  | { op: "set"; source: string; metric: string; date: string; value: string }
  | { op: "deleteColumn"; source: string; metric: string }
  | { op: "deleteRow"; date: string };

/** Reserved view id holding the live Table layout, auto-saved so reorder/resize
 * persist across reloads without an explicit "Save view". Hidden from the
 * named-views tabs. */
const LOG_LAYOUT_ID = "__log_layout__";
const SEP = "\0"; // date + column key → one draft-edit key

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** A column key is `source.metric` (first dot splits); a bare name edits as
 * a manual metric so hand-added columns land in record/daily/manual.csv. */
function splitKey(key: string): { source: string; metric: string } {
  const dot = key.indexOf(".");
  return dot > 0
    ? { source: key.slice(0, dot), metric: key.slice(dot + 1) }
    : { source: "manual", metric: key };
}

/** Keep date first, drop ids that aren't a live metric, then append any metric
 *  not yet in the order. */
function reconcileOrder(
  order: string[],
  defaultOrder: string[],
  metricKeys: Set<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if ((id === "date" || metricKeys.has(id) || id.startsWith("custom:")) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  if (!seen.has("date")) {
    out.unshift("date");
    seen.add("date");
  }
  for (const id of defaultOrder) {
    if (!seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}

/** Close-on-outside-click + Escape, matching the Connect/API popover. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

export function JournalTable({
  data,
  views,
  onViewsChange,
  onData,
  onReload,
  sourceFilter = null,
  metricFilter = null,
  fullHistory = true,
  loadingFull = false,
  onLoadFullHistory,
}: {
  data: JournalData;
  views: JournalView[];
  onViewsChange: (next: JournalView[]) => void;
  /** Receives the fresh journal returned by /api/journal/edit after a Save. */
  onData: (next: JournalData) => void;
  /** Quiet refetch after the column scanner merged something (no loading flash). */
  onReload?: () => void;
  /** Show only this source's columns — a display overlay, NOT persisted, so the
   * saved layout/views survive filtering. */
  sourceFilter?: string | null;
  /** Show only this one metric column (a Timeline tag click). Same render-time
   * overlay; forces the column visible even if the saved layout hid it. */
  metricFilter?: string | null;
  /** false → only a recent window is loaded; the footer offers the full fetch. */
  fullHistory?: boolean;
  loadingFull?: boolean;
  onLoadFullHistory?: () => void;
}) {
  const metricKeys = useMemo(() => new Set(data.metrics.map((m) => m.key)), [data.metrics]);
  const metricsByKey = useMemo(
    () => new Map(data.metrics.map((m) => [m.key, m])),
    [data.metrics],
  );
  const defaultOrder = useMemo(
    () => ["date", ...data.metrics.map((m) => m.key)],
    [data.metrics],
  );

  // Hydrate initial layout from the reserved working view (once, no flash).
  const initial = useMemo(() => {
    const wv = views.find((v) => v.id === LOG_LAYOUT_ID);
    if (!wv) return { order: defaultOrder, visibility: {}, sizing: {} };
    return {
      order: reconcileOrder(wv.columnOrder, defaultOrder, metricKeys),
      visibility: wv.columnVisibility ?? {},
      sizing: wv.columnSizing ?? {},
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(initial.visibility);
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(initial.order);
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(initial.sizing);
  const [activeView, setActiveView] = useState<string | null>(null);

  // Keep the order valid if the underlying metric set changes (new source synced).
  useEffect(() => {
    setColumnOrder((prev) => {
      const next = reconcileOrder(prev.length ? prev : defaultOrder, defaultOrder, metricKeys);
      return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next;
    });
  }, [defaultOrder, metricKeys]);

  // ---- auto-persist the working layout (debounced) --------------------------
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const onViewsChangeRef = useRef(onViewsChange);
  onViewsChangeRef.current = onViewsChange;
  const skipPersist = useRef(true); // don't persist the initial mount

  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    const t = setTimeout(() => {
      const working: JournalView = {
        id: LOG_LAYOUT_ID,
        name: "Table layout",
        columnOrder,
        columnVisibility: columnVisibility as Record<string, boolean>,
        columnSizing,
      };
      const rest = viewsRef.current.filter((v) => v.id !== LOG_LAYOUT_ID);
      onViewsChangeRef.current([...rest, working]);
    }, 400);
    return () => clearTimeout(t);
  }, [columnOrder, columnVisibility, columnSizing]);

  // ---- edit mode -------------------------------------------------------------
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /** Draft cell values that differ from the record, keyed `${date}\0${key}`.
   * A ref (not state) so typing never re-renders the whole table; inputs are
   * uncontrolled and Save reads the map. */
  const cellEdits = useRef(new Map<string, string>());
  const [addedCols, setAddedCols] = useState<string[]>([]); // keys "source.metric"
  const [removedCols, setRemovedCols] = useState<Set<string>>(new Set());
  const [addedRows, setAddedRows] = useState<string[]>([]); // ISO dates
  const [removedRows, setRemovedRows] = useState<Set<string>>(new Set());

  const resetDraft = () => {
    cellEdits.current.clear();
    setAddedCols([]);
    setRemovedCols(new Set());
    setAddedRows([]);
    setRemovedRows(new Set());
    setEditError(null);
  };

  const startEdit = () => {
    resetDraft();
    setEditing(true);
  };

  const cancelEdit = () => {
    resetDraft();
    setEditing(false);
  };

  const deleteColumn = (key: string) => {
    if (addedCols.includes(key)) {
      setAddedCols((prev) => prev.filter((k) => k !== key));
      return;
    }
    setRemovedCols((prev) => new Set(prev).add(key));
  };

  const deleteRow = (date: string) => {
    if (addedRows.includes(date)) {
      setAddedRows((prev) => prev.filter((d) => d !== date));
      return;
    }
    setRemovedRows((prev) => new Set(prev).add(date));
  };

  const addColumn = (raw: string) => {
    const name = raw.trim().replace(/\s+/g, "_");
    if (!name) return;
    const key = name.includes(".") ? name : `manual.${name}`;
    if (metricKeys.has(key)) {
      setRemovedCols((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setColumnVisibility((prev) => ({ ...prev, [key]: true }));
      return;
    }
    setAddedCols((prev) => (prev.includes(key) ? prev : [...prev, key]));
  };

  const addRow = (date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    setRemovedRows((prev) => {
      const next = new Set(prev);
      next.delete(date);
      return next;
    });
    if (!data.days.some((d) => d.date === date)) {
      setAddedRows((prev) => (prev.includes(date) ? prev : [...prev, date]));
    }
  };

  async function saveEdits() {
    const existingDates = new Set(data.days.map((d) => d.date));
    const colOf = (key: string) => {
      const m = metricsByKey.get(key);
      return m ? { source: m.source, metric: m.metric } : splitKey(key);
    };

    const ops: EditOp[] = [];
    for (const [k, value] of cellEdits.current) {
      const i = k.indexOf(SEP);
      const date = k.slice(0, i);
      const key = k.slice(i + 1);
      if (removedCols.has(key) || removedRows.has(date)) continue;
      ops.push({ op: "set", date, value: value.trim(), ...colOf(key) });
    }
    for (const key of removedCols) {
      if (metricKeys.has(key)) ops.push({ op: "deleteColumn", ...colOf(key) });
    }
    for (const date of removedRows) {
      if (existingDates.has(date)) ops.push({ op: "deleteRow", date });
    }

    if (!ops.length) {
      cancelEdit();
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      const res = await fetch("/api/journal/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ edits: ops }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        journal?: JournalData;
      };
      if (!res.ok || !body.journal) {
        setEditError(body.error || "Saving failed.");
        return;
      }
      // An edit rewrote daily cells: every cached answer derived from them (the
      // coverage heatmap, the other journal window, the graphs) is now stale.
      invalidate();
      onData(body.journal);
      resetDraft();
      setEditing(false);
    } catch {
      setEditError("Could not reach the edit endpoint.");
    } finally {
      setSaving(false);
    }
  }

  // Rows: the record's days, plus draft rows, minus deleted ones (edit mode).
  const rows = useMemo(() => {
    if (!editing) return data.days;
    const extra: JournalDay[] = addedRows.map((date) => ({
      date,
      values: {},
      memos: [],
      sessions: [],
      events: [],
      eventCount: 0,
    }));
    return [...data.days, ...extra]
      .filter((d) => !removedRows.has(d.date))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [editing, data.days, addedRows, removedRows]);

  const columns = useMemo<ColumnDef<JournalDay>[]>(() => {
    const cols: ColumnDef<JournalDay>[] = [
      {
        id: "date",
        header: "Date",
        accessorFn: (d) => d.date,
        size: 128,
        minSize: 96,
        enableHiding: false,
        cell: (ctx) => {
          const date = ctx.getValue() as string;
          if (!editing) return <span className="font-mono text-[13px] text-fg">{date}</span>;
          return (
            <span className="group/row flex items-center gap-1">
              <button
                type="button"
                title="Delete row"
                onClick={() => deleteRow(date)}
                className="-ml-1 shrink-0 rounded p-0.5 text-muted-fg/40 hover:text-destructive"
              >
                <X width={12} height={12} />
              </button>
              <span className="font-mono text-[13px] text-fg">{date}</span>
            </span>
          );
        },
      },
    ];

    const cellFor = (key: string, numeric: boolean): ColumnDef<JournalDay>["cell"] =>
      function Cell(ctx) {
        const day = ctx.row.original;
        const v = day.values[key];
        if (!editing) {
          if (!v) return <span className="text-muted-fg/40">—</span>;
          return (
            <span className={cn("text-fg", numeric && "font-mono")}>
              {v.num != null ? v.num : v.text}
            </span>
          );
        }
        const k = `${day.date}${SEP}${key}`;
        const original = v?.text ?? "";
        return (
          <input
            defaultValue={cellEdits.current.get(k) ?? original}
            onChange={(e) => {
              const next = e.target.value;
              if (next.trim() === original.trim()) cellEdits.current.delete(k);
              else cellEdits.current.set(k, next);
            }}
            className={cn(
              "w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm text-fg",
              "focus:border-ring/60 focus:outline-none focus:ring-1 focus:ring-ring/40",
              numeric && "font-mono",
            )}
          />
        );
      };

    for (const m of data.metrics) {
      if (editing && removedCols.has(m.key)) continue;
      cols.push({
        id: m.key,
        header: m.metric,
        accessorFn: (d) => d.values[m.key]?.text ?? "",
        size: 120,
        minSize: 70,
        meta: { source: m.source, metric: m.metric, numeric: m.numeric } as ColMeta,
        cell: cellFor(m.key, m.numeric),
      });
    }
    if (editing) {
      for (const key of addedCols) {
        const { source, metric } = splitKey(key);
        cols.push({
          id: key,
          header: metric,
          accessorFn: (d) => d.values[key]?.text ?? "",
          size: 120,
          minSize: 70,
          meta: { source, metric } as ColMeta,
          cell: cellFor(key, false),
        });
      }
    }
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.metrics, editing, addedCols, removedCols]);

  // Compact by default: a lifetime record is thousands of days — render a page,
  // expand on demand. Edit mode always shows everything so no edited row hides.
  const COMPACT_ROWS = 30;
  const [showAllRows, setShowAllRows] = useState(false);
  const visibleRows = useMemo(
    () => (editing || showAllRows ? rows : rows.slice(0, COMPACT_ROWS)),
    [editing, showAllRows, rows],
  );

  // The source filter hides other columns at render time only; the persisted
  // `columnVisibility` state stays what the user chose.
  const effectiveVisibility = useMemo<VisibilityState>(() => {
    if (!sourceFilter && !metricFilter) return columnVisibility;
    const v: VisibilityState = { ...columnVisibility };
    if (metricFilter) {
      for (const m of data.metrics) v[m.key] = m.key === metricFilter;
    } else {
      for (const m of data.metrics) if (m.source !== sourceFilter) v[m.key] = false;
    }
    return v;
  }, [columnVisibility, sourceFilter, metricFilter, data.metrics]);

  const table = useReactTable({
    data: visibleRows,
    columns,
    state: { columnVisibility: effectiveVisibility, columnOrder, columnSizing },
    getRowId: (d) => d.date,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: "onChange",
    enableColumnResizing: true,
    getCoreRowModel: getCoreRowModel(),
  });

  // ---- reorder (drag a header grip, view mode) ----
  const dragCol = useRef<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const dropOn = (target: string) => {
    const src = dragCol.current;
    dragCol.current = null;
    setDragId(null);
    setOverId(null);
    if (!src || src === target || target === "date") return;
    setColumnOrder((prev) => {
      const order = prev.length ? [...prev] : [...defaultOrder];
      const from = order.indexOf(src);
      const to = order.indexOf(target);
      if (from < 0 || to < 0) return prev;
      order.splice(from, 1);
      order.splice(to, 0, src);
      return order;
    });
    setActiveView(null);
  };

  // ---- named views ----
  const namedViews = useMemo(() => views.filter((v) => v.id !== LOG_LAYOUT_ID), [views]);

  const applyView = (v: JournalView) => {
    setColumnOrder(reconcileOrder(v.columnOrder, defaultOrder, metricKeys));
    setColumnVisibility(v.columnVisibility);
    setColumnSizing(v.columnSizing);
    setActiveView(v.id);
  };

  const saveView = (name: string) => {
    const view: JournalView = {
      id: uid(),
      name: name.trim().slice(0, 60),
      columnOrder: table.getState().columnOrder,
      columnVisibility: table.getState().columnVisibility as Record<string, boolean>,
      columnSizing: table.getState().columnSizing,
    };
    onViewsChange([...viewsRef.current, view]);
    setActiveView(view.id);
  };

  const deleteView = (id: string) => {
    onViewsChange(viewsRef.current.filter((v) => v.id !== id));
    if (activeView === id) setActiveView(null);
  };

  const resetView = () => {
    setColumnVisibility({});
    setColumnOrder(defaultOrder);
    setColumnSizing({});
    setActiveView(null);
  };

  // popovers
  const [saveOpen, setSaveOpen] = useState(false);
  const [colOpen, setColOpen] = useState(false);
  const [rowOpen, setRowOpen] = useState(false);
  const [name, setName] = useState("");
  const [newCol, setNewCol] = useState("");
  const [newRow, setNewRow] = useState("");
  const saveRef = useDismiss(saveOpen, () => {
    setSaveOpen(false);
    setName("");
  });
  const colRef = useDismiss(colOpen, () => {
    setColOpen(false);
    setNewCol("");
  });
  const rowRef = useDismiss(rowOpen, () => {
    setRowOpen(false);
    setNewRow("");
  });

  const shownCount = table.getVisibleLeafColumns().length - 1; // minus the date column

  return (
    <div>
      {/* toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {editing ? (
          <p className="text-xs text-muted-fg">Editing — Save writes to the record.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={resetView}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[13px] font-medium transition-colors",
                activeView === null
                  ? "bg-muted text-fg"
                  : "bg-card text-muted-fg hover:bg-muted hover:text-fg",
              )}
            >
              All columns
            </button>
            {namedViews.map((v) => (
              <span
                key={v.id}
                className={cn(
                  "group inline-flex h-8 items-center gap-1 rounded-lg border border-border pl-2.5 pr-1 text-[13px] font-medium transition-colors",
                  activeView === v.id
                    ? "bg-muted text-fg"
                    : "bg-card text-muted-fg hover:bg-muted hover:text-fg",
                )}
              >
                <button
                  type="button"
                  onClick={() => applyView(v)}
                  className="inline-flex items-center gap-1.5"
                >
                  <Bookmark width={13} height={13} />
                  {v.name}
                </button>
                <button
                  type="button"
                  title="Delete view"
                  onClick={() => deleteView(v.id)}
                  className="rounded p-0.5 text-muted-fg/60 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                >
                  <X width={12} height={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* data-quality scan — duplicate columns, dead columns, messy values;
            joins this row, findings list wraps to a full-width line below */}
        {!editing && onReload ? <DataQualityPanel compact onChanged={onReload} /> : null}

        <div className={cn("flex items-center gap-2", (editing || !onReload) && "ml-auto")}>
          {editing ? (
            <>
              {/* add a column */}
              <div className="relative" ref={colRef}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setColOpen((o) => !o)}
                  className={cn(colOpen && "bg-muted")}
                >
                  <Plus width={15} height={15} />
                  Column
                </Button>
                {colOpen ? (
                  <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-border bg-card p-3 shadow-xl">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        addColumn(newCol);
                        setNewCol("");
                        setColOpen(false);
                      }}
                      className="flex gap-1.5"
                    >
                      <input
                        autoFocus
                        value={newCol}
                        onChange={(e) => setNewCol(e.target.value)}
                        placeholder="metric or source.metric"
                        className="h-8 w-full rounded-lg border border-input bg-bg px-2.5 text-sm text-fg placeholder:text-muted-fg/70 focus-visible:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                      <Button type="submit" size="sm" variant="primary" disabled={!newCol.trim()}>
                        Add
                      </Button>
                    </form>
                  </div>
                ) : null}
              </div>

              {/* add a row */}
              <div className="relative" ref={rowRef}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setRowOpen((o) => !o)}
                  className={cn(rowOpen && "bg-muted")}
                >
                  <Plus width={15} height={15} />
                  Row
                </Button>
                {rowOpen ? (
                  <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-border bg-card p-3 shadow-xl">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        addRow(newRow);
                        setNewRow("");
                        setRowOpen(false);
                      }}
                      className="flex gap-1.5"
                    >
                      <input
                        autoFocus
                        type="date"
                        value={newRow}
                        onChange={(e) => setNewRow(e.target.value)}
                        className="h-8 w-full rounded-lg border border-input bg-bg px-2.5 text-sm text-fg focus-visible:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                      <Button type="submit" size="sm" variant="primary" disabled={!newRow}>
                        Add
                      </Button>
                    </form>
                  </div>
                ) : null}
              </div>

              <Button size="sm" variant="secondary" onClick={cancelEdit} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={saveEdits} disabled={saving}>
                {saving ? <Spinner width={14} height={14} /> : null}
                Save
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="secondary" onClick={startEdit}>
                <Pencil width={14} height={14} />
                Edit
              </Button>

              {/* save view */}
              <div className="relative" ref={saveRef}>
                <Button size="sm" variant="secondary" onClick={() => setSaveOpen((o) => !o)}>
                  <Bookmark width={15} height={15} />
                  Save view
                </Button>
                {saveOpen ? (
                  <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-border bg-card p-3 shadow-xl">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!name.trim()) return;
                        saveView(name);
                        setName("");
                        setSaveOpen(false);
                      }}
                      className="flex gap-1.5"
                    >
                      <input
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="View name"
                        className="h-8 w-full rounded-lg border border-input bg-bg px-2.5 text-sm text-fg placeholder:text-muted-fg/70 focus-visible:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                      <Button type="submit" size="sm" variant="primary" disabled={!name.trim()}>
                        Save
                      </Button>
                    </form>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      {editError ? <p className="mb-2 text-xs text-destructive">{editError}</p> : null}

      {/* table */}
      <div className="scrollbar-thin overflow-x-auto rounded-xl border border-border">
        <table
          className="border-separate border-spacing-0 text-left text-sm"
          style={{ width: table.getTotalSize() }}
        >
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const meta = header.column.columnDef.meta as ColMeta | undefined;
                  const isDate = header.column.id === "date";
                  return (
                    <th
                      key={header.id}
                      style={{ width: header.getSize() }}
                      onDragOver={(e) => {
                        if (dragCol.current && !isDate) {
                          e.preventDefault();
                          if (overId !== header.column.id) setOverId(header.column.id);
                        }
                      }}
                      onDrop={() => dropOn(header.column.id)}
                      className={cn(
                        "group relative select-none border-b border-border bg-muted/50 px-3 py-2 align-bottom",
                        overId === header.column.id && "bg-accent/10",
                        dragId === header.column.id && "opacity-50",
                      )}
                    >
                      <div className="flex items-center gap-1">
                        {!isDate && !editing ? (
                          <span
                            draggable
                            onDragStart={() => {
                              dragCol.current = header.column.id;
                              setDragId(header.column.id);
                            }}
                            onDragEnd={() => {
                              dragCol.current = null;
                              setDragId(null);
                              setOverId(null);
                            }}
                            title="Drag to reorder"
                            className="-ml-1 cursor-grab text-muted-fg/50 hover:text-fg active:cursor-grabbing"
                          >
                            <GripVertical width={14} height={14} />
                          </span>
                        ) : null}
                        <span className="min-w-0 flex-1 truncate">
                          <span className="text-[11px] font-medium uppercase tracking-wide text-fg">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </span>
                          {meta?.source ? (
                            <span className="ml-1 text-[10px] normal-case text-muted-fg">
                              {meta.source}
                            </span>
                          ) : null}
                        </span>
                        {!isDate && editing ? (
                          <button
                            type="button"
                            title="Delete column"
                            onClick={() => deleteColumn(header.column.id)}
                            className="-mr-1 shrink-0 rounded p-0.5 text-muted-fg/40 transition-colors hover:text-destructive"
                          >
                            <X width={12} height={12} />
                          </button>
                        ) : null}
                      </div>
                      {header.column.getCanResize() ? (
                        <span
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onClick={(e) => e.stopPropagation()}
                          className={cn(
                            "absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none select-none",
                            "after:absolute after:right-0 after:top-1/4 after:h-1/2 after:w-px after:bg-border hover:after:bg-accent",
                            header.column.getIsResizing() && "after:bg-accent after:w-0.5",
                          )}
                        />
                      ) : null}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, ri) => (
              <tr key={row.id} className="hover:bg-muted/30">
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    style={{ width: cell.column.getSize() }}
                    className={cn(
                      "truncate px-3 py-1.5",
                      ri < table.getRowModel().rows.length - 1 && "border-b border-border/60",
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!rows.length ? (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-10 text-center text-sm text-muted-fg">
          No data yet.
        </div>
      ) : (
        <div className="mt-2.5 flex items-center gap-3">
          <p className="text-[11px] text-muted-fg">
            {(editing || showAllRows ? rows.length : Math.min(COMPACT_ROWS, rows.length)).toLocaleString()} of{" "}
            {data.totalDays.toLocaleString()} day{data.totalDays === 1 ? "" : "s"} · {shownCount} column
            {shownCount === 1 ? "" : "s"}
          </p>
          {!editing && rows.length > COMPACT_ROWS ? (
            <button
              type="button"
              onClick={() => setShowAllRows((v) => !v)}
              className="text-[11px] font-medium text-accent hover:underline"
            >
              {showAllRows ? "Show fewer" : `Show all ${rows.length.toLocaleString()} loaded days`}
            </button>
          ) : null}
          {!editing && !fullHistory && onLoadFullHistory ? (
            <button
              type="button"
              onClick={onLoadFullHistory}
              disabled={loadingFull}
              className="text-[11px] font-medium text-accent hover:underline disabled:opacity-50"
            >
              {loadingFull ? "Loading full history…" : `Load full history (${data.totalDays.toLocaleString()} days)`}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

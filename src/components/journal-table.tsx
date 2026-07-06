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
import { Bookmark, GripVertical, Plus, X } from "./icons";

interface ColMeta {
  source?: string;
  numeric?: boolean;
  custom?: boolean;
}

/** Prefix for a user-defined column that maps to a `source.metric` key which may
 *  not have landed yet. Stored in columnOrder (survives the views API), so custom
 *  columns persist with the rest of the layout — no config.ts change needed. */
const CUSTOM_PREFIX = "custom:";
/** Reserved view id holding the live Log layout, auto-saved so add/remove/reorder
 *  of columns persist across reloads without an explicit "Save view". Hidden from
 *  the named-views tabs. */
const LOG_LAYOUT_ID = "__log_layout__";

const isCustom = (id: string) => id.startsWith(CUSTOM_PREFIX);
const underlyingKey = (id: string) => id.slice(CUSTOM_PREFIX.length);

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** Keep date first, drop ids that are neither a live metric nor a custom column,
 *  then append any metric not yet in the order. */
function reconcileOrder(
  order: string[],
  defaultOrder: string[],
  metricKeys: Set<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (id === "date" || metricKeys.has(id) || isCustom(id)) {
      if (!seen.has(id)) {
        out.push(id);
        seen.add(id);
      }
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
}: {
  data: JournalData;
  views: JournalView[];
  onViewsChange: (next: JournalView[]) => void;
}) {
  const metricKeys = useMemo(() => new Set(data.metrics.map((m) => m.key)), [data.metrics]);
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

  // Custom columns are just the prefixed ids living in the order.
  const customIds = useMemo(() => columnOrder.filter(isCustom), [columnOrder]);

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
        name: "Log layout",
        columnOrder,
        columnVisibility: columnVisibility as Record<string, boolean>,
        columnSizing,
      };
      const rest = viewsRef.current.filter((v) => v.id !== LOG_LAYOUT_ID);
      onViewsChangeRef.current([...rest, working]);
    }, 400);
    return () => clearTimeout(t);
  }, [columnOrder, columnVisibility, columnSizing]);

  const columns = useMemo<ColumnDef<JournalDay>[]>(() => {
    const cols: ColumnDef<JournalDay>[] = [
      {
        id: "date",
        header: "Date",
        accessorFn: (d) => d.date,
        size: 128,
        minSize: 96,
        enableHiding: false,
        cell: (ctx) => (
          <span className="font-mono text-[13px] text-fg">{ctx.getValue() as string}</span>
        ),
      },
    ];
    for (const m of data.metrics) {
      cols.push({
        id: m.key,
        header: m.metric,
        accessorFn: (d) => d.values[m.key]?.text ?? "",
        size: 120,
        minSize: 70,
        meta: { source: m.source, numeric: m.numeric } as ColMeta,
        cell: (ctx) => {
          const v = ctx.row.original.values[m.key];
          if (!v) return <span className="text-muted-fg/40">—</span>;
          return (
            <span className={cn("text-fg", m.numeric && "font-mono")}>
              {v.num != null ? v.num : v.text}
            </span>
          );
        },
      });
    }
    for (const id of customIds) {
      const key = underlyingKey(id);
      const dot = key.indexOf(".");
      const source = dot > 0 ? key.slice(0, dot) : "custom";
      const metric = dot > 0 ? key.slice(dot + 1) : key;
      cols.push({
        id,
        header: metric,
        accessorFn: (d) => d.values[key]?.text ?? "",
        size: 120,
        minSize: 70,
        meta: { source, custom: true } as ColMeta,
        cell: (ctx) => {
          const v = ctx.row.original.values[key];
          if (!v) return <span className="text-muted-fg/40">—</span>;
          return <span className="text-fg">{v.num != null ? v.num : v.text}</span>;
        },
      });
    }
    return cols;
  }, [data.metrics, customIds]);

  const table = useReactTable({
    data: data.days,
    columns,
    state: { columnVisibility, columnOrder, columnSizing },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: "onChange",
    enableColumnResizing: true,
    getCoreRowModel: getCoreRowModel(),
  });

  // ---- reorder (drag a header grip) ----
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

  // ---- add / remove a column ----
  const addMetric = (key: string) => {
    setColumnVisibility((prev) => ({ ...prev, [key]: true }));
    setActiveView(null);
  };

  const addCustom = (raw: string) => {
    const key = raw.trim();
    if (!key) return;
    if (metricKeys.has(key)) {
      addMetric(key);
      return;
    }
    const id = CUSTOM_PREFIX + key;
    setColumnOrder((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setColumnVisibility((prev) => ({ ...prev, [id]: true }));
    setActiveView(null);
  };

  const removeColumn = (id: string) => {
    if (isCustom(id)) {
      setColumnOrder((prev) => prev.filter((x) => x !== id));
      setColumnSizing((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setColumnVisibility((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } else {
      setColumnVisibility((prev) => ({ ...prev, [id]: false }));
    }
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
  const [addOpen, setAddOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [custom, setCustom] = useState("");
  const addRef = useDismiss(addOpen, () => {
    setAddOpen(false);
    setCustom("");
  });
  const saveRef = useDismiss(saveOpen, () => {
    setSaveOpen(false);
    setName("");
  });

  // metric series that exist but are currently hidden → available to add back
  const hiddenMetrics = data.metrics.filter((m) => columnVisibility[m.key] === false);
  const shownCount = table.getVisibleLeafColumns().length - 1; // minus the date column

  return (
    <div>
      {/* toolbar: views + column controls */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
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

        <div className="ml-auto flex items-center gap-2">
          {/* add a column */}
          <div className="relative" ref={addRef}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAddOpen((o) => !o)}
              className={cn(addOpen && "bg-muted")}
            >
              <Plus width={15} height={15} />
              Add column
            </Button>
            {addOpen ? (
              <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-border bg-card p-2 shadow-xl">
                {hiddenMetrics.length ? (
                  <div className="scrollbar-thin max-h-60 overflow-y-auto">
                    {hiddenMetrics.map((m) => (
                      <button
                        key={m.key}
                        type="button"
                        onClick={() => addMetric(m.key)}
                        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-muted"
                      >
                        <Plus width={13} height={13} className="shrink-0 text-muted-fg" />
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">{m.metric}</span>
                        <span className="shrink-0 text-[10px] text-muted-fg">{m.source}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="px-1.5 py-1.5 text-xs text-muted-fg">All series shown.</p>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    addCustom(custom);
                    setCustom("");
                  }}
                  className="mt-1 flex gap-1.5 border-t border-border pt-2"
                >
                  <input
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    placeholder="source.metric"
                    className="h-8 w-full rounded-lg border border-input bg-bg px-2.5 text-sm text-fg placeholder:text-muted-fg/70 focus-visible:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  />
                  <Button type="submit" size="sm" variant="primary" disabled={!custom.trim()}>
                    Add
                  </Button>
                </form>
              </div>
            ) : null}
          </div>

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
        </div>
      </div>

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
                        {!isDate ? (
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
                        {!isDate ? (
                          <button
                            type="button"
                            title="Remove column"
                            onClick={() => removeColumn(header.column.id)}
                            className="-mr-1 shrink-0 rounded p-0.5 text-muted-fg/40 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
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

      {!data.days.length ? (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-10 text-center text-sm text-muted-fg">
          No data yet.
        </div>
      ) : (
        <p className="mt-2.5 text-[11px] text-muted-fg">
          {data.totalDays} day{data.totalDays === 1 ? "" : "s"} · {shownCount} column
          {shownCount === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}

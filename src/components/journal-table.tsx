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
import { Bookmark, Check, GripVertical, Plus, Sliders, Trash, X } from "./icons";

interface ColMeta {
  source?: string;
  numeric?: boolean;
}

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
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
  const defaultOrder = useMemo(
    () => ["date", ...data.metrics.map((m) => m.key)],
    [data.metrics],
  );

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(defaultOrder);
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [activeView, setActiveView] = useState<string | null>(null);

  // Keep the order in sync if the underlying metric set changes (new source synced).
  useEffect(() => {
    setColumnOrder((prev) => {
      if (!prev.length) return defaultOrder;
      const valid = new Set(defaultOrder);
      const kept = prev.filter((id) => valid.has(id));
      for (const id of defaultOrder) if (!kept.includes(id)) kept.push(id);
      return kept.length === prev.length && kept.every((id, i) => id === prev[i])
        ? prev
        : kept;
    });
  }, [defaultOrder]);

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
    return cols;
  }, [data.metrics]);

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

  // ---- views ----
  const applyView = (v: JournalView) => {
    const valid = new Set(defaultOrder);
    const order = ["date", ...v.columnOrder.filter((id) => id !== "date" && valid.has(id))];
    for (const id of defaultOrder) if (!order.includes(id)) order.push(id);
    setColumnOrder(order);
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
    onViewsChange([...views, view]);
    setActiveView(view.id);
  };

  const deleteView = (id: string) => {
    onViewsChange(views.filter((v) => v.id !== id));
    if (activeView === id) setActiveView(null);
  };

  const resetView = () => {
    setColumnVisibility({});
    setColumnOrder(defaultOrder);
    setColumnSizing({});
    setActiveView(null);
  };

  // popovers
  const [colsOpen, setColsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const colsRef = useDismiss(colsOpen, () => setColsOpen(false));
  const saveRef = useDismiss(saveOpen, () => {
    setSaveOpen(false);
    setName("");
  });

  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide());
  const hiddenCount = hideable.filter((c) => !c.getIsVisible()).length;

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
          {views.map((v) => (
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
                className="rounded p-0.5 text-muted-fg/60 opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
              >
                <X width={12} height={12} />
              </button>
            </span>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* columns show/hide */}
          <div className="relative" ref={colsRef}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setColsOpen((o) => !o)}
              className={cn(colsOpen && "bg-muted")}
            >
              <Sliders width={15} height={15} />
              Columns
              {hiddenCount > 0 ? (
                <span className="rounded-full bg-accent/15 px-1.5 text-[11px] font-semibold text-accent">
                  {hideable.length - hiddenCount}/{hideable.length}
                </span>
              ) : null}
            </Button>
            {colsOpen ? (
              <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-border bg-card p-2 shadow-xl">
                <div className="flex items-center justify-between px-1.5 pb-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
                    Show columns
                  </span>
                  <div className="flex gap-2 text-[11px]">
                    <button
                      type="button"
                      className="text-muted-fg hover:text-fg"
                      onClick={() =>
                        setColumnVisibility(
                          Object.fromEntries(hideable.map((c) => [c.id, false])),
                        )
                      }
                    >
                      Hide all
                    </button>
                    <button
                      type="button"
                      className="text-accent hover:opacity-80"
                      onClick={() => setColumnVisibility({})}
                    >
                      Show all
                    </button>
                  </div>
                </div>
                <div className="scrollbar-thin max-h-72 overflow-y-auto">
                  {hideable.map((c) => {
                    const meta = c.columnDef.meta as ColMeta | undefined;
                    return (
                      <label
                        key={c.id}
                        className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-muted"
                      >
                        <span
                          className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                            c.getIsVisible()
                              ? "border-accent bg-accent text-accent-fg"
                              : "border-input bg-bg",
                          )}
                        >
                          {c.getIsVisible() ? <Check width={12} height={12} /> : null}
                        </span>
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={c.getIsVisible()}
                          onChange={c.getToggleVisibilityHandler()}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">
                          {c.columnDef.header as string}
                        </span>
                        {meta?.source ? (
                          <span className="shrink-0 text-[10px] text-muted-fg">{meta.source}</span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          {/* save view */}
          <div className="relative" ref={saveRef}>
            <Button size="sm" variant="secondary" onClick={() => setSaveOpen((o) => !o)}>
              <Plus width={15} height={15} />
              Save view
            </Button>
            {saveOpen ? (
              <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-border bg-card p-3 shadow-xl">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
                  Save current layout
                </p>
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
                    placeholder="e.g. Sleep"
                    className="h-8 w-full rounded-lg border border-input bg-bg px-2.5 text-sm text-fg placeholder:text-muted-fg/70 focus-visible:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  />
                  <Button type="submit" size="sm" variant="primary" disabled={!name.trim()}>
                    Save
                  </Button>
                </form>
                <p className="mt-2 text-[11px] text-muted-fg">
                  Captures which columns are shown, their order and widths.
                </p>
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
                        "relative select-none border-b border-border bg-muted/50 px-3 py-2 align-bottom",
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
          No days yet. Connect a source or structure an inbox item to fill the table.
        </div>
      ) : (
        <p className="mt-2.5 text-[11px] text-muted-fg">
          {data.totalDays} day{data.totalDays === 1 ? "" : "s"} · {data.metrics.length} metric
          {data.metrics.length === 1 ? "" : "s"} · drag{" "}
          <GripVertical width={11} height={11} className="inline align-[-1px] text-muted-fg" /> to
          reorder, drag a column edge to resize, then <b className="font-medium text-fg">Save view</b>.
        </p>
      )}
    </div>
  );
}

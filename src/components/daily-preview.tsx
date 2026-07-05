"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Spinner, Table } from "@/components/icons";
import { cn } from "@/components/ui";

interface Cell {
  date: string;
  source: string;
  metric: string;
  value: string;
  num: number | null;
}
interface SourceStat {
  source: string;
  metrics: number;
  rows: number;
  firstDate: string;
  lastDate: string;
}
interface Summary {
  totalRows: number;
  sources: SourceStat[];
  recent: Cell[];
}

/**
 * Live window onto the rebuilt daily cache — proves Structure (and the importers)
 * actually land rows. Refetches whenever `version` bumps, plus a manual refresh.
 */
export function DailyPreview({ version }: { version: number }) {
  const [data, setData] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/daily");
      if (res.ok) setData((await res.json()) as Summary);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  const rows = data?.recent ?? [];

  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        <Table width={16} height={16} className="text-muted-fg" />
        <p className="text-sm font-semibold text-fg">Daily table</p>
        {data ? (
          <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-fg">
            {data.totalRows} rows
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          title="Refresh"
          className="ml-auto rounded-lg border border-border bg-card p-1.5 text-muted-fg transition-colors hover:bg-muted hover:text-fg disabled:opacity-40"
        >
          {busy ? <Spinner width={14} height={14} /> : <RefreshCw width={14} height={14} />}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-fg">
        The rebuilt cache — what Structure and your importers write. Long form:{" "}
        <span className="font-mono">(date, source, metric, value)</span>.
      </p>

      {data?.sources.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {data.sources.map((s) => (
            <span
              key={s.source}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] text-muted-fg"
              title={`${s.firstDate} → ${s.lastDate}`}
            >
              <span className="font-medium text-fg">{s.source}</span>
              <span>
                · {s.metrics} metric{s.metrics === 1 ? "" : "s"} · {s.rows} rows
              </span>
            </span>
          ))}
        </div>
      ) : null}

      {rows.length ? (
        <div className="scrollbar-thin mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-[11px] uppercase tracking-wide text-muted-fg">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Metric</th>
                <th className="px-3 py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.date}-${r.source}-${r.metric}-${i}`} className="border-b border-border/60 last:border-0">
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[13px] text-muted-fg">
                    {r.date}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-fg">
                      {r.source}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-fg">{r.metric}</td>
                  <td
                    className={cn(
                      "px-3 py-1.5 text-right font-medium text-fg",
                      r.num != null && "font-mono",
                    )}
                  >
                    {r.num != null ? r.num : r.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-fg">
          No daily data yet. Structure an inbox item or sync a source to fill this table.
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { JournalTimeline } from "./journal-timeline";
import { JournalTable } from "./journal-table";
import { JournalSearch } from "./journal-search";
import { cn } from "./ui";
import { Spinner } from "./icons";
import type { JournalData, JournalView } from "@/lib/journal";

type Mode = "timeline" | "table";
const MODE_KEY = "agentqs_journal_mode";
const MODE_LABEL: Record<Mode, string> = { timeline: "Timeline", table: "Log" };

/**
 * Client shell for the Journal tab. Fetches the pivoted per-day record once and
 * hands it to either the narrative Timeline or the TanStack Table. Saved views
 * are loaded from / persisted to config (per user) via /api/journal/views.
 */
export function JournalWorkspace() {
  const [data, setData] = useState<JournalData | null>(null);
  const [views, setViews] = useState<JournalView[]>([]);
  const [mode, setMode] = useState<Mode>("timeline");
  const [loading, setLoading] = useState(true);

  // restore last-used view mode
  useEffect(() => {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "table" || saved === "timeline") setMode(saved);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [d, v] = await Promise.all([
        fetch("/api/journal").then((r) => (r.ok ? (r.json() as Promise<JournalData>) : null)),
        fetch("/api/journal/views")
          .then((r) => (r.ok ? (r.json() as Promise<{ views: JournalView[] }>) : { views: [] }))
          .catch(() => ({ views: [] as JournalView[] })),
      ]);
      if (!alive) return;
      setData(d);
      setViews(v?.views ?? []);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
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
            ? `${data.totalDays} day${data.totalDays === 1 ? "" : "s"} · ${data.totalCells} data point${data.totalCells === 1 ? "" : "s"}`
            : " "}
        </p>
        <div className="flex rounded-lg border border-border bg-card p-0.5 text-sm">
          {(["timeline", "table"] as const).map((m) => (
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

      {loading || !data ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card py-20 text-sm text-muted-fg">
          <Spinner width={16} height={16} /> Loading…
        </div>
      ) : mode === "timeline" ? (
        <JournalTimeline data={data} />
      ) : (
        <JournalTable data={data} views={views} onViewsChange={persistViews} />
      )}
    </div>
  );
}

"use client";

import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Sparkles, Spinner, Wand, X } from "./icons";
import { cn } from "./ui";

/**
 * "Find days that felt like this" — semantic search over the record, right on the
 * Journal. Hits the keyless /api/search (local embeddings + sqlite-vec), so it works
 * with no AI key. Returns the closest days by *meaning*, each with a dated snippet and
 * a match strength — a way to jump to the days that rhyme with a feeling.
 */
interface Hit {
  date: string;
  kind: "memo" | "session";
  snippet: string;
  score: number;
}

function niceDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function JournalSearch() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ran, setRan] = useState("");

  async function run() {
    const query = q.trim();
    if (!query || busy) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, limit: 6 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error || "Search failed.");
        setHits(null);
      } else {
        setHits(Array.isArray(data.hits) ? (data.hits as Hit[]) : []);
        setRan(query);
      }
    } catch {
      setErr("Could not reach search.");
      setHits(null);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void run();
    }
  }

  function clear() {
    setQ("");
    setHits(null);
    setErr("");
    setRan("");
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-2 rounded-lg border border-input bg-bg px-2.5 py-1.5 focus-within:border-ring/60">
        <Sparkles width={15} height={15} className="shrink-0 text-accent" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search by meaning"
          className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted-fg/70"
        />
        {q || hits ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="shrink-0 rounded p-1 text-muted-fg transition-colors hover:text-fg"
          >
            <X width={14} height={14} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void run()}
          disabled={!q.trim() || busy}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors",
            "bg-accent text-accent-fg hover:opacity-90 disabled:opacity-40",
          )}
        >
          {busy ? <Spinner width={14} height={14} /> : <Wand width={14} height={14} />}
          Search
        </button>
      </div>

      {err ? <p className="mt-2 px-1 text-xs text-destructive">{err}</p> : null}

      {hits ? (
        hits.length ? (
          <div className="mt-3 space-y-1.5">
            <p className="px-1 text-[11px] font-medium text-muted-fg">
              Closest to <span className="text-fg">&ldquo;{ran}&rdquo;</span>
            </p>
            {hits.map((h) => (
              <div
                key={h.date + h.kind}
                className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2"
              >
                <span className="mt-0.5 w-24 shrink-0 text-[13px] font-medium text-fg">
                  {niceDate(h.date)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted-fg" title={h.snippet}>
                  {h.snippet}
                </span>
                <span className="shrink-0 rounded-full border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  {Math.round(h.score * 100)}%
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 px-1 text-xs text-muted-fg">No matches.</p>
        )
      ) : null}
    </div>
  );
}

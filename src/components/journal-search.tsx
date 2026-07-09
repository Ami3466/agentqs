"use client";

import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Sparkles, Spinner, Wand, X } from "./icons";
import { Badge } from "./ui";

/**
 * "Find days that felt like this" — semantic search over the record, right on the
 * Journal. Hits the keyless /api/search (local embeddings + sqlite-vec), so it works
 * with no AI key. Returns the closest days by *meaning*, each with a dated snippet and
 * a match strength — a way to jump to the days that rhyme with a feeling.
 */
interface Hit {
  date: string;
  kind: "memo" | "session" | "daily_text";
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
  const [disabled, setDisabled] = useState(false); // embeddings turned off in Settings
  // Bumped by clear() so a response landing after the user dismissed the search
  // can't resurrect results for a query that is no longer on screen.
  const seq = useRef(0);

  async function run() {
    const query = q.trim();
    if (!query || busy) return;
    const mySeq = ++seq.current;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, limit: 6 }),
      });
      const data = await res.json().catch(() => ({}));
      if (seq.current !== mySeq) return;
      if (!res.ok) {
        setErr(data.error || "Search failed.");
        setHits(null);
      } else {
        setHits(Array.isArray(data.hits) ? (data.hits as Hit[]) : []);
        setRan(query);
        setDisabled(Boolean(data.disabled));
      }
    } catch {
      if (seq.current === mySeq) {
        setErr("Could not reach search.");
        setHits(null);
      }
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
    seq.current++;
    setQ("");
    setHits(null);
    setErr("");
    setRan("");
  }

  // A compact input that joins the Journal filter row; results wrap to their own
  // full-width line below (the parent row is flex-wrap).
  return (
    <>
      <div className="flex h-8 w-56 shrink-0 items-center gap-1.5 rounded-lg border border-input bg-bg px-2 focus-within:border-ring/60">
        <Sparkles width={14} height={14} className="shrink-0 text-accent" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search by meaning"
          title="Semantic search over memos, sessions and journal text — Enter to run"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-muted-fg/70"
        />
        {q || hits || err ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="shrink-0 rounded p-0.5 text-muted-fg transition-colors hover:text-fg"
          >
            <X width={13} height={13} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void run()}
          disabled={!q.trim() || busy}
          aria-label="Search"
          title="Search (Enter)"
          className="shrink-0 rounded p-0.5 text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
        >
          {busy ? <Spinner width={14} height={14} /> : <Wand width={14} height={14} />}
        </button>
      </div>

      {err ? (
        <div className="order-last basis-full">
          <p className="px-1 text-xs text-destructive">{err}</p>
        </div>
      ) : null}

      {hits ? (
        <div className="order-last basis-full">
          {hits.length ? (
            <div className="space-y-1.5">
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
                  <Badge tone="accent" className="shrink-0">
                    {Math.round(h.score * 100)}%
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-1 text-xs text-muted-fg">
              {disabled ? "Semantic search is turned off in Settings — re-enable it to search by meaning." : "No matches."}
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}

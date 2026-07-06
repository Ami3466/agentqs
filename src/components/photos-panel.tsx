"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Input, cn } from "@/components/ui";
import { Spinner, Upload, X } from "@/components/icons";

/**
 * Photos under the Data tab. All local: point it at a folder (or the Mac Photos
 * library) and it records EXIF + thumbnails + a CLIP embedding — the ORIGINALS never
 * leave the machine. Then recall photos by describing them ("beach at sunset"), with
 * no AI key. CLI-first: the same thing is `agentqs photos <folder>` and `photos search`.
 */

interface Status {
  count: number;
  withGps: number;
  captioned: number;
  cameras: string[];
  firstDate: string | null;
  lastDate: string | null;
  indexed: number;
  backend: string | null;
}

interface Hit {
  id: string;
  date: string;
  thumb: string | null;
  caption: string | null;
  tags: string[];
  score: number;
}

export function PhotosPanel({ version }: { version?: number }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [folder, setFolder] = useState("");
  const [library, setLibrary] = useState(false);
  const [caption, setCaption] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/photos");
      if (res.ok) setStatus((await res.json()) as Status);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus, version]);

  async function runImport() {
    if (busy || (!folder.trim() && !library)) return;
    setBusy(true);
    setErr("");
    setNote("");
    try {
      const res = await fetch("/api/photos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder: folder.trim() || undefined, library, caption }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? "Import failed.");
      } else {
        setNote(
          `Imported ${data.imported} (${data.skipped} already known) · ${data.embedded} embedded${
            data.captioned ? ` · ${data.captioned} captioned` : ""
          } · ${data.withGps} geotagged.`,
        );
        await loadStatus();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    if (!q.trim() || searching) return;
    setSearching(true);
    setErr("");
    try {
      const res = await fetch("/api/photos/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
      });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? "Search failed.");
      else setHits((data.hits as Hit[]) ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-fg">Photos</h2>
        <p className="text-xs text-muted-fg">
          {status && status.count > 0
            ? `${status.count} photos · ${status.indexed} indexed · ${status.withGps} geotagged${
                status.captioned ? ` · ${status.captioned} captioned` : ""
              }`
            : "Local only — originals never leave this machine"}
        </p>
      </div>

      {/* Import */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder="/path/to/photos (Google Takeout, a folder, screenshots…)"
          disabled={library}
          className="min-w-0 flex-1"
        />
        <Button onClick={() => void runImport()} disabled={busy || (!folder.trim() && !library)}>
          {busy ? <Spinner width={14} height={14} /> : <Upload width={14} height={14} />}
          <span>Import</span>
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-muted-fg">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={library} onChange={(e) => setLibrary(e.target.checked)} />
          Mac Photos library
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={caption} onChange={(e) => setCaption(e.target.checked)} />
          Caption + scene tags (slower)
        </label>
        <code className="ml-auto rounded bg-bg px-1.5 py-0.5 text-[11px] text-muted-fg">agentqs photos &lt;folder&gt;</code>
      </div>
      {note ? <p className="mt-2 text-xs text-fg">{note}</p> : null}
      {err ? <p className="mt-2 text-xs text-destructive">{err}</p> : null}

      {/* Text → image recall */}
      {status && status.indexed > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <div className="flex items-center gap-2 rounded-lg border border-input bg-bg px-2.5 py-1.5 focus-within:border-ring/60">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void runSearch();
                }
              }}
              placeholder="Find photos… (e.g. beach at sunset, my dog, whiteboard)"
              className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted-fg/70"
            />
            {q || hits ? (
              <button
                type="button"
                onClick={() => {
                  setQ("");
                  setHits(null);
                }}
                aria-label="Clear"
                className="shrink-0 rounded p-1 text-muted-fg transition-colors hover:text-fg"
              >
                <X width={14} height={14} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void runSearch()}
              disabled={!q.trim() || searching}
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                q.trim() && !searching ? "bg-accent text-accent-fg hover:opacity-90" : "bg-muted text-muted-fg",
              )}
            >
              {searching ? "…" : "Search"}
            </button>
          </div>

          {hits ? (
            hits.length ? (
              <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                {hits.map((h) => (
                  <figure key={h.id} className="group relative overflow-hidden rounded-lg border border-border bg-bg">
                    {h.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/photos/thumb?id=${h.id}`}
                        alt={h.caption ?? h.date}
                        className="aspect-square w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex aspect-square w-full items-center justify-center text-[10px] text-muted-fg">
                        no thumb
                      </div>
                    )}
                    <figcaption className="absolute inset-x-0 bottom-0 truncate bg-fg/70 px-1 py-0.5 text-[10px] text-bg opacity-0 transition-opacity group-hover:opacity-100">
                      {h.date} · {h.score}
                    </figcaption>
                  </figure>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-fg">No matches.</p>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

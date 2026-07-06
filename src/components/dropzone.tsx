"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { Spinner, Upload } from "@/components/icons";
import { cn } from "@/components/ui";

const TEXT_EXT = /\.(csv|tsv|tab|psv|txt|md|markdown|json|jsonl|ndjson|log|ics|vcf|xml|yaml|yml)$/i;
function looksTextual(f: File): boolean {
  return f.type.startsWith("text/") || f.type === "application/json" || TEXT_EXT.test(f.name);
}
function kindOf(name: string): string {
  return /\.(csv|tsv|tab|psv)$/i.test(name) ? "csv" : "file";
}
/** A file we could read but that is actually binary (NUL byte in the head). */
function isBinary(text: string): boolean {
  const head = text.slice(0, 4096);
  for (let i = 0; i < head.length; i++) if (head.charCodeAt(i) === 0) return true;
  return false;
}

/**
 * The one manual ingest path (Loop 2 redesign). Drag & drop — or click to browse —
 * ANY unstructured file. It lands verbatim in the pending inbox (no LLM, free);
 * the inbox's Structure step turns it into daily rows. This is deliberately the
 * ONLY drop target on the page: sources are live feeds, a dropped file is not a
 * connection. Bumps the shared `version` so the inbox + daily table refetch.
 */
export function Dropzone({ onUploaded }: { onUploaded: () => void }) {
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  function say(tone: "ok" | "error", text: string) {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash((f) => (f && f.text === text ? null : f)), 7000);
  }

  const upload = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      setBusy(true);
      let ok = 0;
      const skipped: string[] = [];
      try {
        for (const f of list) {
          let text = "";
          try {
            text = await f.text();
          } catch {
            skipped.push(f.name);
            continue;
          }
          if (!text.trim() || (!looksTextual(f) && isBinary(text))) {
            skipped.push(f.name);
            continue;
          }
          const res = await fetch("/api/inbox", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              source: "drop",
              kind: kindOf(f.name),
              meta: { filename: f.name, bytes: f.size },
            }),
          });
          if (res.ok) ok++;
          else skipped.push(f.name);
        }
        if (ok) {
          say("ok", `${ok} file${ok === 1 ? "" : "s"} in your inbox — hit Structure below.`);
          onUploaded();
        }
        if (skipped.length) {
          say(
            ok ? "ok" : "error",
            `Couldn't read ${skipped.join(", ")} — text-based files only (CSV, JSON, notes, exports).`,
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [onUploaded],
  );

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragDepth.current += 1;
    setDrag(true);
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
  }
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDrag(false);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragDepth.current = 0;
    setDrag(false);
    if (e.dataTransfer?.files?.length) void upload(e.dataTransfer.files);
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop data here"
        onClick={() => (busy ? undefined : fileRef.current?.click())}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !busy) {
            e.preventDefault();
            fileRef.current?.click();
          }
        }}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          drag ? "border-accent bg-accent/10" : "border-border bg-muted/30 hover:bg-muted/60",
        )}
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-muted-fg">
          {busy ? <Spinner width={20} height={20} /> : <Upload width={20} height={20} />}
        </span>
        <p className="text-base font-semibold text-fg">
          {busy ? "Adding to inbox…" : "Drop data here"}
        </p>
        <p className="max-w-md text-sm text-muted-fg">
          Any file — a CSV export, notes, a chat log, JSON. It lands in your inbox; then{" "}
          <b className="font-medium text-fg">Structure</b> turns it into daily data. Or click to
          browse.
        </p>
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void upload(e.target.files);
          e.target.value = "";
        }}
      />
      {flash ? (
        <p
          className={cn(
            "mt-2 text-center text-xs",
            flash.tone === "error" ? "text-destructive" : "text-accent",
          )}
        >
          {flash.text}
        </p>
      ) : null}
    </div>
  );
}

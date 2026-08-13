"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { Spinner, Upload } from "@/components/icons";
import { cn } from "@/components/ui";
// The zero-dependency leaf, NOT `@/lib/pdf-text`: importing the brain from here
// makes webpack emit its 1.6MB pdf.js chunk into static/ for a parse that only
// ever happens on the server.
import { MAX_PDF_BYTES, PDF_MIME, looksPdfName } from "@/lib/pdf-limits";

const TEXT_EXT = /\.(csv|tsv|tab|psv|txt|md|markdown|json|jsonl|ndjson|log|ics|vcf|xml|yaml|yml)$/i;
type UploadItem = { file: File; path: string };
type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntry | null;
};

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

/** Read a file as a data URL (used to embed photos verbatim into the inbox, and
 *  to base64 a PDF for the server to parse). */
function readDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(f);
  });
}

function uploadItems(files: FileList | File[]): UploadItem[] {
  return Array.from(files).map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  }));
}

function isUploadItems(input: FileList | File[] | UploadItem[]): input is UploadItem[] {
  return Array.isArray(input) && input.every((item) => "file" in item);
}

function fileFromEntry(entry: FileSystemFileEntry, path: string): Promise<UploadItem> {
  return new Promise((resolve, reject) => {
    entry.file(
      (file) => resolve({ file, path }),
      (err) => reject(err),
    );
  });
}

function readDirectoryEntries(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    function readBatch() {
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            resolve(entries);
            return;
          }
          entries.push(...batch);
          readBatch();
        },
        (err) => reject(err),
      );
    }
    readBatch();
  });
}

async function itemsFromEntry(entry: FileSystemEntry, parent = ""): Promise<UploadItem[]> {
  const path = parent ? `${parent}/${entry.name}` : entry.name;
  if (entry.isFile) return [await fileFromEntry(entry as FileSystemFileEntry, path)];
  if (!entry.isDirectory) return [];

  const children = await readDirectoryEntries(entry as FileSystemDirectoryEntry);
  const nested = await Promise.all(children.map((child) => itemsFromEntry(child, path)));
  return nested.flat();
}

async function droppedItems(dataTransfer: DataTransfer): Promise<UploadItem[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .map((item) => (item as DataTransferItemWithEntry).webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => Boolean(entry));

  if (entries.length) {
    const nested = await Promise.all(entries.map((entry) => itemsFromEntry(entry)));
    return nested.flat();
  }
  return uploadItems(dataTransfer.files);
}

/**
 * The one manual ingest path. Drag & drop — or click to browse — ANY file,
 * including folders, images and PDFs. Text files land verbatim in the pending inbox;
 * images are read as a data URL and land there too (embedded on Structure); a PDF
 * is posted as base64 and the SERVER extracts its text layer. This is
 * the ONLY drop target on the page: sources are live feeds, a dropped file is not a
 * connection. Bumps the shared `version` so the inbox refetches.
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
    async (input: FileList | File[] | UploadItem[]) => {
      const list = isUploadItems(input) ? input : uploadItems(input);
      if (!list.length) return;
      setBusy(true);
      let ok = 0;
      // A refusal carries its REASON when the server gave one (a scanned PDF, an
      // encrypted one) — "couldn't read it" is only for a file we never got.
      const skipped: { name: string; why?: string }[] = [];
      async function post(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
        const res = await fetch("/api/inbox", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "drop", ...body }),
        });
        if (res.ok) return { ok: true };
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: detail.error };
      }
      try {
        for (const item of list) {
          const f = item.file;
          const filename = item.path || f.name;
          if (f.type.startsWith("image/")) {
            let dataUrl = "";
            try {
              dataUrl = await readDataUrl(f);
            } catch {
              skipped.push({ name: filename });
              continue;
            }
            const done = await post({
              text: dataUrl,
              kind: "image",
              meta: { filename, bytes: f.size, mime: f.type },
            });
            if (done.ok) ok++;
            else skipped.push({ name: filename, why: done.error });
            continue;
          }
          // A PDF is binary here and text on the server: ship the BYTES and let
          // /api/inbox extract the text layer. The browser never parses a PDF.
          if (looksPdfName(f.name, f.type)) {
            if (f.size > MAX_PDF_BYTES) {
              skipped.push({ name: filename, why: "PDF too large — use `agentqs import <file>`" });
              continue;
            }
            let dataUrl = "";
            try {
              dataUrl = await readDataUrl(f);
            } catch {
              skipped.push({ name: filename });
              continue;
            }
            const done = await post({
              pdfBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
              kind: "file",
              meta: { filename, bytes: f.size, mime: PDF_MIME },
            });
            if (done.ok) ok++;
            else skipped.push({ name: filename, why: done.error });
            continue;
          }
          let text = "";
          try {
            text = await f.text();
          } catch {
            skipped.push({ name: filename });
            continue;
          }
          if (!text.trim() || (!looksTextual(f) && isBinary(text))) {
            skipped.push({ name: filename });
            continue;
          }
          const done = await post({
            text,
            kind: kindOf(filename),
            meta: { filename, bytes: f.size },
          });
          if (done.ok) ok++;
          else skipped.push({ name: filename, why: done.error });
        }
        if (ok) {
          say("ok", `${ok} file${ok === 1 ? "" : "s"} added — Structure below.`);
          onUploaded();
        }
        if (skipped.length) {
          const explained = skipped.filter((s) => s.why);
          say(
            ok ? "ok" : "error",
            explained.length
              ? explained.map((s) => `${s.name}: ${s.why}`).join(" · ") +
                  (explained.length < skipped.length
                    ? ` · couldn't read ${skipped.filter((s) => !s.why).map((s) => s.name).join(", ")}`
                    : "")
              : `Couldn't read ${skipped.map((s) => s.name).join(", ")}.`,
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
    if (e.dataTransfer?.items?.length || e.dataTransfer?.files?.length) {
      void droppedItems(e.dataTransfer)
        .then((items) => upload(items))
        .catch(() => say("error", "Couldn't read that folder."));
    }
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
          {busy ? "Adding…" : "Drop data here"}
        </p>
        <p className="max-w-md text-sm text-muted-fg">
          Files or folders. Photos embed, PDFs extract to text.
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

"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Inbox, Spinner, Upload, Wand, X } from "@/components/icons";
import { cn } from "@/components/ui";
import { INBOX_TEXT_ACCEPT, uploadFilesToInbox } from "@/lib/inbox-upload";

interface Item {
  id: string;
  ts: string;
  source: string;
  kind: string;
  text: string;
}

interface StructResult {
  id: string;
  status: "structured" | "empty" | "error";
  route: "csv" | "llm";
  source?: string;
  rowsAdded?: number;
  message?: string;
}

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * The pending bucket (Loop 6) plus the Loop-7 Structure step. Everything lands
 * here raw and free — memos (`>>` in Chat), dropped/uploaded CSVs and notes.
 * Structure routes clean CSV → direct column map (no LLM) and prose → the model,
 * writing wide daily rows. `onChanged` bumps the parent so the daily preview
 * refetches; `version` triggers this panel's own refetch after any mutation.
 */
export function InboxPanel({
  version,
  onChanged,
}: {
  version: number;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // item id | "all" | "upload"
  const [flash, setFlash] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const load = useCallback(async () => {
    const res = await fetch("/api/inbox");
    if (!res.ok) return;
    const data = (await res.json()) as { pending: number; items: Item[] };
    setPending(data.pending);
    setItems(data.items);
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  function say(tone: "ok" | "error", text: string) {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash((f) => (f && f.text === text ? null : f)), 7000);
  }

  async function uploadFiles(files: FileList | File[]) {
    if (!Array.from(files).length) return;
    setBusy("upload");
    try {
      const { added, skipped } = await uploadFilesToInbox(files, "drop");
      if (skipped.length) say("error", `Skipped ${skipped[0]}.`);
      if (added) {
        say(
          "ok",
          `${added} file${added === 1 ? "" : "s"} added — hit Structure to turn ${added === 1 ? "it" : "them"} into daily rows.`,
        );
        onChanged();
      }
    } finally {
      setBusy(null);
    }
  }

  async function structure(id?: string) {
    setBusy(id ?? "all");
    try {
      const res = await fetch("/api/structure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(id ? { id } : { all: true }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        results?: StructResult[];
      };
      if (!res.ok) {
        say("error", data.error || "Structuring failed.");
        return;
      }
      const rs = data.results ?? [];
      const done = rs.filter((r) => r.status === "structured");
      const cells = done.reduce((n, r) => n + (r.rowsAdded ?? 0), 0);
      const problem = rs.find((r) => r.status === "error" || r.status === "empty");
      if (done.length) {
        const srcs = [...new Set(done.map((r) => r.source))].filter(Boolean).join(", ");
        say(
          "ok",
          `Structured ${done.length} item${done.length === 1 ? "" : "s"} → ${cells} daily row${cells === 1 ? "" : "s"} in ${srcs}.`,
        );
      } else if (problem) {
        say("error", problem.message || "Nothing could be structured.");
      }
      onChanged();
    } catch {
      say("error", "Could not reach the structure endpoint.");
    } finally {
      setBusy(null);
    }
  }

  async function discard(id: string) {
    setBusy(id);
    try {
      const res = await fetch(`/api/inbox?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) onChanged();
    } finally {
      setBusy(null);
    }
  }

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
    if (e.dataTransfer?.files?.length) void uploadFiles(e.dataTransfer.files);
  }

  const anyBusy = busy !== null;

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative p-4"
    >
      <div className="flex items-center gap-2">
        <Inbox width={16} height={16} className="text-muted-fg" />
        <p className="text-sm font-semibold text-fg">Pending inbox</p>
        {pending != null ? (
          <span className="ml-auto inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-fg">
            {pending}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-fg">
        Everything lands here raw and free. Hit <b>Structure</b> to turn it into clean daily data —
        tokens are only spent on prose notes.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => structure()}
          disabled={!pending || anyBusy}
          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg transition-colors hover:opacity-90 disabled:opacity-40"
        >
          {busy === "all" ? <Spinner width={14} height={14} /> : <Wand width={14} height={14} />}
          Structure all
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={anyBusy}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-fg transition-colors hover:bg-muted disabled:opacity-40"
        >
          {busy === "upload" ? <Spinner width={14} height={14} /> : <Upload width={14} height={14} />}
          Upload
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={INBOX_TEXT_ACCEPT}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {flash ? (
        <p className={cn("mt-2 text-xs", flash.tone === "error" ? "text-destructive" : "text-accent")}>
          {flash.text}
        </p>
      ) : null}

      {items.length ? (
        <ul className="mt-3 space-y-1.5">
          {items.map((it) => (
            <li key={it.id} className="rounded-lg border border-border bg-bg px-3 py-2">
              <div className="mb-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-fg">
                <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{it.source}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{it.kind}</span>
                <span>{ago(it.ts)}</span>
                <span className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => structure(it.id)}
                    disabled={anyBusy}
                    title="Structure this item"
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 normal-case text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
                  >
                    {busy === it.id ? (
                      <Spinner width={12} height={12} />
                    ) : (
                      <Wand width={12} height={12} />
                    )}
                    Structure
                  </button>
                  <button
                    type="button"
                    onClick={() => discard(it.id)}
                    disabled={anyBusy}
                    title="Discard"
                    className="rounded p-0.5 text-muted-fg transition-colors hover:text-destructive disabled:opacity-40"
                  >
                    <X width={12} height={12} />
                  </button>
                </span>
              </div>
              <p className="line-clamp-2 whitespace-pre-wrap text-sm text-fg">{it.text}</p>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3 flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-fg">
          <Upload width={18} height={18} className="opacity-60" />
          Drop a CSV or text file here, log a memo with <code className="font-mono">&gt;&gt;</code> in
          Chat, or Upload above.
        </div>
      )}

      {drag ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-accent bg-accent/10 text-accent">
          <Upload width={22} height={22} />
          <p className="text-sm font-medium">Drop to add to your inbox</p>
        </div>
      ) : null}
    </div>
  );
}

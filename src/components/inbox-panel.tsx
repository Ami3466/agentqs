"use client";

import { useCallback, useEffect, useState } from "react";
import { Inbox, RefreshCw, Spinner, Wand, X } from "@/components/icons";
import { Button, cn } from "@/components/ui";

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
 * The pending bucket (Loop 6) + the Loop-7 Structure step. Everything captured
 * lands here raw and free — memos (`>>` in Chat) and files from the dropzone above.
 * Structure routes clean CSV → direct column map (no LLM) and prose → the model,
 * writing wide daily rows. Uploading lives in the one hero Dropzone; this panel is
 * just the queue + Structure. `onChanged` bumps the parent so the daily preview
 * refetches; `version` triggers this panel's own refetch after any mutation.
 */
export function InboxPanel({
  version,
  onChanged,
  onAutomate,
}: {
  version: number;
  onChanged: () => void;
  /** Opens the automation setup flow (the Sources → Connections catalog) so a
   *  recurring feed replaces dropping this file by hand. */
  onAutomate?: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // item id | "all"
  const [flash, setFlash] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

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

  const anyBusy = busy !== null;

  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        <Inbox width={16} height={16} className="text-muted-fg" />
        <p className="text-sm font-semibold text-fg">Pending inbox</p>
        {pending != null ? (
          <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-fg">
            {pending}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {onAutomate ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={onAutomate}
              title="Set up a recurring feed instead of dropping this by hand"
            >
              <RefreshCw width={14} height={14} />
              Automate imports
            </Button>
          ) : null}
          <button
            type="button"
            onClick={() => structure()}
            disabled={!pending || anyBusy}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg transition-colors hover:opacity-90 disabled:opacity-40"
          >
            {busy === "all" ? <Spinner width={14} height={14} /> : <Wand width={14} height={14} />}
            Structure all
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-fg">
        Raw captures — dropped files and <code className="font-mono">&gt;&gt;</code> memos. Structure
        turns them into daily rows; tokens are only spent on prose. Doing this often?{" "}
        <button
          type="button"
          onClick={onAutomate}
          disabled={!onAutomate}
          className="font-medium text-accent underline-offset-2 hover:underline disabled:no-underline disabled:opacity-100"
        >
          Automate imports
        </button>{" "}
        so a source feeds itself.
      </p>

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
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-fg">
          Inbox empty. Drop a file above or log a memo with{" "}
          <code className="font-mono">&gt;&gt;</code> in Chat.
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, Inbox, ScanSearch, Spinner, Wand, X } from "@/components/icons";
import { ago, Badge, cn } from "@/components/ui";
import { runScan } from "./column-scanner";

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
  route: "csv" | "llm" | "agent" | "merge";
  source?: string;
  rowsAdded?: number;
  message?: string;
}

/**
 * The pending bucket (Loop 6) + the Loop-7 Structure step. Everything captured —
 * from ANY entry point: `//` memos, voice notes, Telegram/Slack messages, dropped
 * files, the API — lands here raw and free. Structure routes clean CSV → direct
 * column map (no LLM) and prose → the model, writing wide daily rows. The header's
 * Auto-structure checkbox (the same config flag as Settings → Structure) makes new
 * captures skip this queue entirely. `onChanged` bumps the parent so the daily
 * preview refetches; `version` triggers this panel's own refetch after any mutation.
 */
export function InboxPanel({
  version,
  onChanged,
}: {
  version: number;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  // Column-scanner notifications — structuring one applies its merge instead of
  // extracting a CSV, so they're their own section under the pending captures.
  const [notes, setNotes] = useState<Item[]>([]);
  const [pending, setPending] = useState<number | null>(null);
  // A big backlog lives inside a fixed-height scrollable box with its own search —
  // it must never turn the page itself into an endless scroll.
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // item id | "all"
  const [flash, setFlash] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  // The auto-structure switch (same setting as Settings → Structure): new captures
  // skip this queue entirely and merge straight into the daily table. Always
  // clickable — the settings fetch only syncs the initial value.
  const [auto, setAuto] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/inbox");
    if (!res.ok) return;
    const data = (await res.json()) as { pending: number; items: Item[]; notifications?: Item[] };
    setPending(data.pending);
    setItems(data.items);
    setNotes(data.notifications ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  useEffect(() => {
    let alive = true;
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setAuto(Boolean(d.autoStructure)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function toggleAuto(v: boolean) {
    setAuto(v); // optimistic — revert on failure
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoStructure: v }),
    }).catch(() => null);
    if (!res?.ok) {
      setAuto(!v);
      say("error", "Could not save the auto-structure setting.");
    }
  }

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
        scan?: { autoMerged: number; findings: number; notified: number };
      };
      if (!res.ok) {
        say("error", data.error || "Structuring failed.");
        return;
      }
      const rs = data.results ?? [];
      const done = rs.filter((r) => r.status === "structured");
      const merges = done.filter((r) => r.route === "merge");
      const cells = done.reduce((n, r) => n + (r.rowsAdded ?? 0), 0);
      const problem = rs.find((r) => r.status === "error" || r.status === "empty");
      if (done.length) {
        const srcs = [...new Set(done.map((r) => r.source))].filter(Boolean).join(", ");
        let msg =
          merges.length === done.length
            ? merges[0]?.message ||
              `Merged ${merges.length} duplicate column pair${merges.length === 1 ? "" : "s"}.`
            : `Structured ${done.length} item${done.length === 1 ? "" : "s"} → ${cells} daily row${cells === 1 ? "" : "s"} in ${srcs}.`;
        if (data.scan?.notified) {
          msg += ` Scanner found ${data.scan.notified} duplicate column${data.scan.notified === 1 ? "" : "s"} — see Notifications below.`;
        }
        say("ok", msg);
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

  /** The column scanner, from the Data tab: new findings land as notifications below. */
  async function scanColumns() {
    setBusy("scan");
    const r = await runScan();
    if (r.error) say("error", r.error);
    else {
      const parts = [
        r.findings.length ? `${r.findings.length} duplicate column${r.findings.length === 1 ? "" : "s"} found` : "No duplicate columns",
        r.autoMerged ? `${r.autoMerged} saved rule${r.autoMerged === 1 ? "" : "s"} re-applied` : "",
      ].filter(Boolean);
      say("ok", `${parts.join(" · ")}.`);
    }
    setBusy(null);
    onChanged();
  }

  const anyBusy = busy !== null;
  const q = query.trim().toLowerCase();
  const filteredItems = q
    ? items.filter((it) => it.text.toLowerCase().includes(q) || it.source.toLowerCase().includes(q) || it.kind.toLowerCase().includes(q))
    : items;

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
        <div className="ml-auto flex items-center gap-3">
          <label
            className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-fg hover:text-fg"
            title="New captures merge straight into the daily table — nothing waits here."
          >
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => void toggleAuto(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-accent"
            />
            Auto-structure
          </label>
          <button
            type="button"
            onClick={() => void scanColumns()}
            disabled={anyBusy}
            title="Find duplicated daily columns (manual + auto imports)"
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-muted-fg transition-colors hover:bg-muted hover:text-fg disabled:opacity-40"
          >
            {busy === "scan" ? <Spinner width={14} height={14} /> : <ScanSearch width={14} height={14} />}
            Scan
          </button>
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
        {auto
          ? "Auto-structure is on — new captures from anywhere become daily rows on arrival; only leftovers wait here."
          : "Everything you capture lands here first — memos, voice notes, channel messages, dropped files. Structure turns it into daily rows; tokens are only spent on prose."}
      </p>

      {flash ? (
        <p className={cn("mt-2 text-xs", flash.tone === "error" ? "text-destructive" : "text-accent")}>
          {flash.text}
        </p>
      ) : null}

      {items.length ? (
        <div className="mt-3 rounded-lg border border-border">
          {items.length > 5 ? (
            <div className="border-b border-border p-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${items.length} pending items`}
                className="h-8 w-full rounded-md border border-input bg-bg px-2.5 text-[13px] text-fg placeholder:text-muted-fg/70 focus-visible:border-ring/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
              />
            </div>
          ) : null}
          <ul className="max-h-80 space-y-1.5 overflow-y-auto p-2">
          {filteredItems.map((it) => (
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
          {!filteredItems.length ? (
            <li className="px-3 py-4 text-center text-xs text-muted-fg">No pending item matches "{query}".</li>
          ) : null}
          </ul>
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-fg">
          Inbox empty. Drop a file above or log a memo with{" "}
          <code className="font-mono">&gt;&gt;</code> in Chat.
        </div>
      )}

      {notes.length ? (
        <div className="mt-4">
          <div className="flex items-center gap-2">
            <Bell width={14} height={14} className="text-muted-fg" />
            <p className="text-sm font-semibold text-fg">Notifications</p>
            <Badge>{notes.length}</Badge>
          </div>
          <ul className="scrollbar-thin mt-2 max-h-56 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border">
            {notes.map((it) => (
              <li key={it.id} className="flex items-center gap-2 px-3 py-1.5">
                <p className="min-w-0 flex-1 truncate text-[13px] text-fg" title={it.text}>
                  {it.text}
                </p>
                <span className="hidden shrink-0 text-[11px] text-muted-fg sm:inline">{ago(it.ts)}</span>
                <span className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => structure(it.id)}
                    disabled={anyBusy}
                    title="Apply this merge (undo from the Log)"
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
                  >
                    {busy === it.id ? <Spinner width={12} height={12} /> : <Wand width={12} height={12} />}
                    Merge
                  </button>
                  <button
                    type="button"
                    onClick={() => discard(it.id)}
                    disabled={anyBusy}
                    title="Dismiss — never suggest this pair again"
                    className="rounded p-0.5 text-muted-fg transition-colors hover:text-destructive disabled:opacity-40"
                  >
                    <X width={12} height={12} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, MessageSquare, Spinner, Trash } from "@/components/icons";
import { ago, Button, cn } from "@/components/ui";
import { DRAFT_KEY } from "@/lib/smart-input";

interface AppliedCell {
  d: string;
  m: string;
  before: string | null;
  after: string;
}

interface LogStructured {
  source: string | null;
  via: string | null;
  cells: number | null;
  metrics: string[];
  at: string | null;
  canRevert: boolean;
  applied: AppliedCell[];
}

interface LogItem {
  id: string;
  ts: string;
  source: string;
  kind: string;
  status: string; // pending | structured | discarded
  text: string;
  textLength: number;
  filename: string | null;
  structured: LogStructured | null;
  rejectedAt: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "pending",
  structured: "structured",
  discarded: "rejected",
};

/**
 * The Data-tab Log: every capture that entered the record (drops, memos,
 * photos), newest first. A row expands to the raw capture + what Structure made
 * of it, with two actions: Reject (undoes the cells it wrote, marks it
 * discarded) and Ask AI (tags the item into Chat to review / improve it).
 */
export function DataLog({ version, onChanged }: { version: number; onChanged: () => void }) {
  const router = useRouter();
  const [items, setItems] = useState<LogItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null); // reject needs a second click
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/log");
    if (!res.ok) return;
    const data = (await res.json()) as { total: number; items: LogItem[] };
    setItems(data.items);
    setTotal(data.total);
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  function toggle(id: string) {
    setOpen((cur) => (cur === id ? null : id));
    setArmed(null);
    setError(null);
  }

  async function reject(it: LogItem) {
    if (armed !== it.id) {
      setArmed(it.id);
      return;
    }
    setArmed(null);
    setBusy(it.id);
    setError(null);
    try {
      const res = await fetch("/api/log/reject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: it.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || "Reject failed.");
        return;
      }
      onChanged();
    } catch {
      setError("Could not reach the log endpoint.");
    } finally {
      setBusy(null);
    }
  }

  function askAi(it: LogItem) {
    const label = it.filename || `${it.source} ${it.kind}`;
    const s = it.structured;
    const what = s
      ? `it was structured into ${s.source}${s.cells != null ? ` (${s.cells} cells: ${s.metrics.join(", ")})` : ""}`
      : `it is still ${STATUS_LABEL[it.status] ?? it.status}`;
    const draft = `Review log item ${it.id} — "${label}" from ${it.ts.slice(0, 10)}: ${what}. `;
    try {
      sessionStorage.setItem(DRAFT_KEY, draft);
    } catch {
      /* ignore */
    }
    router.push("/");
  }

  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        <Clock width={16} height={16} className="text-muted-fg" />
        <p className="text-sm font-semibold text-fg">Log</p>
        {total != null ? (
          <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-fg">
            {total}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-fg">
        Every capture that entered the record. Click one to review, reject, or hand to the AI.
      </p>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}

      {items.length ? (
        <ul className="mt-3 space-y-1.5">
          {items.map((it) => {
            const expanded = open === it.id;
            const s = it.structured;
            return (
              <li key={it.id} className="rounded-lg border border-border bg-bg">
                <button
                  type="button"
                  onClick={() => toggle(it.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left"
                >
                  <span
                    className={cn(
                      "shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                      it.status === "structured" && "text-fg",
                      it.status === "pending" && "text-muted-fg",
                      it.status === "discarded" && "text-destructive",
                    )}
                  >
                    {STATUS_LABEL[it.status] ?? it.status}
                  </span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-fg">
                    {it.source}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">
                    {it.filename || it.text.split("\n", 1)[0] || it.kind}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-fg">
                    {ago(it.ts)}
                  </span>
                </button>

                {expanded ? (
                  <div className="border-t border-border px-3 py-2.5">
                    {s ? (
                      <p className="text-xs text-muted-fg">
                        → <span className="font-medium text-fg">{s.source}</span>
                        {s.cells != null ? ` · ${s.cells} cell${s.cells === 1 ? "" : "s"}` : ""}
                        {s.metrics.length ? ` · ${s.metrics.join(", ")}` : ""}
                        {s.via ? ` · via ${s.via === "llm" ? "AI" : "CSV"}` : ""}
                      </p>
                    ) : null}
                    {s && s.applied.length ? (
                      <table className="mt-2 w-full text-xs">
                        <tbody>
                          {s.applied.map((c) => (
                            <tr key={`${c.d}:${c.m}`} className="border-t border-border first:border-t-0">
                              <td className="py-1 pr-3 font-mono text-muted-fg">{c.d}</td>
                              <td className="py-1 pr-3 text-fg">{c.m}</td>
                              <td className="py-1 text-right font-mono">
                                {c.before != null ? (
                                  <>
                                    <span className="text-muted-fg line-through">{c.before}</span>{" "}
                                  </>
                                ) : null}
                                <span className="font-medium text-fg">{c.after}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : null}
                    {it.rejectedAt ? (
                      <p className="text-xs text-destructive">Rejected {ago(it.rejectedAt)}.</p>
                    ) : null}

                    <pre className="scrollbar-thin mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 px-2.5 py-2 font-mono text-xs text-fg">
                      {it.text}
                      {it.textLength > it.text.length ? "\n…" : ""}
                    </pre>

                    {it.status !== "discarded" ? (
                      <div className="mt-2 flex items-center gap-2">
                        <Button size="sm" variant="secondary" onClick={() => askAi(it)}>
                          <MessageSquare width={14} height={14} />
                          Ask AI
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => reject(it)}
                          disabled={busy === it.id}
                          title={
                            s
                              ? s.canRevert
                                ? "Undo the cells this wrote and discard it"
                                : "Discard it (its cells were written before undo tracking and stay)"
                              : "Discard this capture"
                          }
                        >
                          {busy === it.id ? (
                            <Spinner width={14} height={14} />
                          ) : (
                            <Trash width={14} height={14} />
                          )}
                          {armed === it.id ? "Confirm reject" : "Reject"}
                        </Button>
                        {s && !s.canRevert ? (
                          <span className="text-[11px] text-muted-fg">
                            Written cells stay — rejecting only removes it from the log.
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-fg">
          Nothing logged yet. Drop a file above or log a memo with{" "}
          <code className="font-mono">//</code> in Chat.
        </div>
      )}
    </div>
  );
}

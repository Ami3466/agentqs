"use client";

import { useEffect, useState } from "react";
import type { ColumnFinding, MergeOutcome } from "@/lib/column-scan";
import { Badge, Button, cn } from "./ui";
import { ScanSearch, Spinner, Wand, X } from "./icons";

interface ScanResponse {
  error?: string;
  findings?: ColumnFinding[];
  autoMerged?: MergeOutcome[];
}

interface StructureResponse {
  error?: string;
  results?: Array<{ id: string; status: string; message?: string }>;
}

/** Open findings on mount (no scan — reads pending notifications), so results
 *  survive navigation. Exported for the Data inbox's scan trigger too. */
export async function fetchFindings(): Promise<ColumnFinding[]> {
  try {
    const res = await fetch("/api/scan");
    if (!res.ok) return [];
    const data = (await res.json()) as ScanResponse;
    return (data.findings ?? []).filter((f) => f.notificationStatus === "pending");
  } catch {
    return [];
  }
}

/** Run the scanner (applies saved rules + queues new findings). */
export async function runScan(): Promise<{ findings: ColumnFinding[]; autoMerged: number; error?: string }> {
  try {
    const res = await fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const data = (await res.json().catch(() => ({}))) as ScanResponse;
    if (!res.ok) return { findings: [], autoMerged: 0, error: data.error || "Scan failed." };
    return {
      findings: (data.findings ?? []).filter((f) => f.notificationStatus === "pending"),
      autoMerged: (data.autoMerged ?? []).length,
    };
  } catch {
    return { findings: [], autoMerged: 0, error: "Could not reach the scan endpoint." };
  }
}

/**
 * The column scanner panel (Journal → Table): duplicated / near-duplicate daily
 * columns, each with Merge (keeps the auto-synced column, saves a rule) or
 * Dismiss. The list is the pending scanner notifications, so it persists across
 * reloads; the same items appear under Data → Inbox → Notifications.
 */
export function ColumnScanner({ onMerged }: { onMerged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null); // finding id being merged/dismissed
  const [scanned, setScanned] = useState(false);
  const [findings, setFindings] = useState<ColumnFinding[]>([]);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    void fetchFindings().then(setFindings);
  }, []);

  async function scanNow() {
    setBusy(true);
    setNote(null);
    const r = await runScan();
    if (r.error) setNote({ tone: "error", text: r.error });
    else if (r.autoMerged) {
      setNote({ tone: "ok", text: `Re-applied ${r.autoMerged} saved merge rule${r.autoMerged === 1 ? "" : "s"}.` });
      onMerged();
    }
    setFindings(r.findings);
    setScanned(true);
    setBusy(false);
  }

  async function merge(f: ColumnFinding) {
    setActing(f.id);
    setNote(null);
    try {
      const res = await fetch("/api/structure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: f.notificationId }),
      });
      const data = (await res.json().catch(() => ({}))) as StructureResponse;
      if (!res.ok) {
        setNote({ tone: "error", text: data.error || "Merge failed." });
        return;
      }
      const r = data.results?.find((x) => x.id === f.notificationId);
      setFindings((prev) => prev.filter((x) => x.id !== f.id));
      setNote({ tone: "ok", text: r?.message || `Merged ${f.from.key} into ${f.into.key}.` });
      onMerged();
    } catch {
      setNote({ tone: "error", text: "Could not reach the structure endpoint." });
    } finally {
      setActing(null);
    }
  }

  async function dismiss(f: ColumnFinding) {
    setActing(f.id);
    try {
      const res = await fetch(`/api/inbox?id=${encodeURIComponent(f.notificationId)}`, { method: "DELETE" });
      if (res.ok) setFindings((prev) => prev.filter((x) => x.id !== f.id));
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => void scanNow()} disabled={busy || acting !== null}>
          {busy ? <Spinner width={14} height={14} /> : <ScanSearch width={14} height={14} />}
          Scan
        </Button>
        {findings.length ? <Badge>{findings.length} duplicate column{findings.length === 1 ? "" : "s"}</Badge> : null}
        {scanned && !findings.length && !note ? <span className="text-xs text-muted-fg">No duplicate columns.</span> : null}
        {note ? (
          <span className={cn("min-w-0 truncate text-xs", note.tone === "error" ? "text-destructive" : "text-accent")} title={note.text}>
            {note.text}
          </span>
        ) : null}
      </div>

      {findings.length ? (
        <ul className="scrollbar-thin mt-2 max-h-56 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border">
          {findings.map((f) => (
            <li key={f.id} className="flex items-center gap-2 px-3 py-1.5">
              <span
                className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg"
                title={`${f.reason} · ${f.fromCells} + ${f.intoCells} values${f.overlap ? ` · ${Math.round(f.agree * f.overlap)}/${f.overlap} shared days match` : ""}`}
              >
                {f.from.key} <span className="text-muted-fg">→</span> {f.into.key}
                {f.intoAuto ? <span className="ml-1.5 font-sans text-[10px] uppercase text-muted-fg">auto</span> : null}
              </span>
              <span className="hidden shrink-0 text-[11px] text-muted-fg sm:inline">
                {f.overlap ? `${Math.round(f.agree * 100)}% of ${f.overlap}d` : "no overlap"}
              </span>
              <span className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => void merge(f)}
                  disabled={acting !== null}
                  title={`Merge into ${f.into.key} and keep it that way`}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
                >
                  {acting === f.id ? <Spinner width={12} height={12} /> : <Wand width={12} height={12} />}
                  Merge
                </button>
                <button
                  type="button"
                  onClick={() => void dismiss(f)}
                  disabled={acting !== null}
                  title="Dismiss — never suggest this pair again"
                  className="rounded p-0.5 text-muted-fg transition-colors hover:text-destructive disabled:opacity-40"
                >
                  <X width={12} height={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import type { QualityFinding } from "@/lib/column-scan";
import { Badge, Button, cn } from "./ui";
import { Check, Copy, ScanSearch, Spinner, Trash, Wand, X } from "./icons";
import { PH, fixPromptSnip, useCopy } from "./connect-api";

interface ScanResponse {
  error?: string;
  findings?: QualityFinding[];
  autoMerged?: unknown[];
}

interface StructureResponse {
  error?: string;
  results?: Array<{ id: string; status: string; message?: string }>;
}

/** Open findings (no scan — reads pending notifications), so results survive
 *  navigation. */
export async function fetchFindings(): Promise<QualityFinding[]> {
  try {
    const res = await fetch("/api/scan");
    if (!res.ok) return [];
    const data = (await res.json()) as ScanResponse;
    return (data.findings ?? []).filter((f) => f.notificationStatus === "pending");
  } catch {
    return [];
  }
}

/** Run the scanner (applies saved merge rules + queues new findings). */
export async function runScan(): Promise<{ findings: QualityFinding[]; autoMerged: number; error?: string }> {
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

const FIX_LABEL: Record<QualityFinding["kind"], string> = { merge: "Merge", drop: "Delete", clean: "Clean" };
const ISSUE_LABEL: Record<QualityFinding["kind"], string> = { merge: "Duplicate", drop: "Dead column", clean: "Messy values" };

function fixTitle(f: QualityFinding): string {
  if (f.kind === "merge") return `Merge into ${f.into} and keep it that way`;
  if (f.kind === "drop") return "Delete this dead column (undo from the Log)";
  return "Normalize the numbers and clear junk cells (undo from the Log)";
}

/** "Copy fix prompt": a paste-into-your-AI prompt that points at /api/scan — the
 *  agent reads the issues from the API, nothing is copied out of the record. */
function CopyPromptButton() {
  const [done, copy] = useCopy();
  const [key, setKey] = useState("");
  useEffect(() => {
    let alive = true;
    fetch("/api/keys")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setKey(d.masked || ""))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => copy(fixPromptSnip(window.location.origin, key || PH))}
      title="Copy a prompt for your AI agent — it reads the open issues from the API and fixes them with you"
    >
      {done ? <Check width={14} height={14} className="text-accent" /> : <Copy width={14} height={14} />}
      Copy fix prompt
    </Button>
  );
}

/**
 * The data-quality panel: duplicate columns, dead all-zero columns and messy
 * values, each with a one-click fix (undoable from the Log) or Dismiss. The list
 * is the pending scanner notifications, so it persists across reloads. Two homes,
 * one component: Data → Data quality tab (full) and Journal → Table (compact).
 */
export function DataQualityPanel({
  version = 0,
  onChanged,
  onCount,
  compact = false,
}: {
  version?: number;
  onChanged: () => void;
  /** Reports the open-issue count on every change — feeds the Data tab badge. */
  onCount?: (n: number) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null); // finding id being fixed/dismissed
  const [scanned, setScanned] = useState(false);
  const [findings, setFindings] = useState<QualityFinding[]>([]);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const setList = useCallback(
    (list: QualityFinding[]) => {
      setFindings(list);
      onCount?.(list.length);
    },
    [onCount],
  );

  useEffect(() => {
    void fetchFindings().then(setList);
  }, [setList, version]);

  async function scanNow() {
    setBusy(true);
    setNote(null);
    const r = await runScan();
    if (r.error) {
      // Keep the currently shown findings — a failed scan says nothing about them.
      setNote({ tone: "error", text: r.error });
    } else {
      if (r.autoMerged) {
        setNote({ tone: "ok", text: `Re-applied ${r.autoMerged} saved merge rule${r.autoMerged === 1 ? "" : "s"}.` });
        onChanged();
      }
      setList(r.findings);
    }
    setScanned(true);
    setBusy(false);
  }

  async function applyFix(f: QualityFinding) {
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
        setNote({ tone: "error", text: data.error || "Fix failed." });
        return;
      }
      const r = data.results?.find((x) => x.id === f.notificationId);
      setList(findings.filter((x) => x.id !== f.id));
      setNote({ tone: "ok", text: r?.message || `Fixed ${f.key}.` });
      onChanged();
    } catch {
      setNote({ tone: "error", text: "Could not reach the structure endpoint." });
    } finally {
      setActing(null);
    }
  }

  async function dismiss(f: QualityFinding) {
    setActing(f.id);
    try {
      const res = await fetch(`/api/inbox?id=${encodeURIComponent(f.notificationId)}`, { method: "DELETE" });
      if (res.ok) setList(findings.filter((x) => x.id !== f.id));
    } finally {
      setActing(null);
    }
  }

  const empty = scanned && !findings.length && !note;
  const controls = (
    <>
      <Button size="sm" variant="secondary" onClick={() => void scanNow()} disabled={busy || acting !== null}>
        {busy ? <Spinner width={14} height={14} /> : <ScanSearch width={14} height={14} />}
        {compact ? "Scan data" : "Scan"}
      </Button>
      <CopyPromptButton />
      {findings.length ? <Badge>{findings.length} issue{findings.length === 1 ? "" : "s"}</Badge> : null}
      {empty ? <span className="min-w-0 truncate text-xs text-muted-fg">No data-quality issues.</span> : null}
      {note ? (
        <span
          className={cn(
            "min-w-0 truncate text-xs",
            compact && "max-w-[280px]",
            note.tone === "error" ? "text-destructive" : "text-accent",
          )}
          title={note.text}
        >
          {note.text}
        </span>
      ) : null}
    </>
  );

  const list = findings.length ? (
    <ul
      className={cn(
        "scrollbar-thin max-h-56 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border",
        compact ? "order-last basis-full" : "mt-2",
      )}
    >
      {findings.map((f) => (
        <li key={f.id} className="flex items-center gap-2 px-3 py-1.5">
          <Badge tone="warning" className="shrink-0">
            {ISSUE_LABEL[f.kind]}
          </Badge>
          <span
            className="min-w-0 flex-1 truncate text-[12px]"
            title={`${f.reason} · fix touches ${f.cells} cell${f.cells === 1 ? "" : "s"}`}
          >
            <span className="font-mono text-fg">
              {f.key}
              {f.into ? (
                <>
                  {" "}
                  <span className="text-muted-fg">→</span> {f.into}
                  {f.intoAuto ? <span className="ml-1.5 font-sans text-[10px] uppercase text-muted-fg">auto</span> : null}
                </>
              ) : null}
            </span>
            <span className="ml-2 text-muted-fg">{f.reason}</span>
          </span>
          <span className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => void applyFix(f)}
              disabled={acting !== null || busy}
              title={fixTitle(f)}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
            >
              {acting === f.id ? (
                <Spinner width={12} height={12} />
              ) : f.kind === "drop" ? (
                <Trash width={12} height={12} />
              ) : (
                <Wand width={12} height={12} />
              )}
              {FIX_LABEL[f.kind]}
            </button>
            <button
              type="button"
              onClick={() => void dismiss(f)}
              disabled={acting !== null || busy}
              title="Dismiss — never suggest this again"
              className="rounded p-0.5 text-muted-fg transition-colors hover:text-destructive disabled:opacity-40"
            >
              <X width={12} height={12} />
            </button>
          </span>
        </li>
      ))}
    </ul>
  ) : null;

  // Compact (Journal toolbar): controls join the parent's flex row; the findings
  // list wraps to its own full-width line below it.
  if (compact) {
    return (
      <>
        <div className="ml-auto flex min-w-0 items-center gap-2">{controls}</div>
        {list}
      </>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2">{controls}</div>
      <p className="mt-1 text-xs text-muted-fg">
        Duplicate columns, dead all-zero columns, messy values. Every fix is undoable from the Log.
      </p>
      {list ?? (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-fg">
          No open issues. Scan checks every daily column for duplicates, dead columns and messy values.
        </div>
      )}
    </div>
  );
}

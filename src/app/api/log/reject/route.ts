import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import {
  applyDailyEdits,
  readRecord,
  rebuild,
  updateInboxItems,
  type AppliedCell,
  type DailyEdit,
} from "@/lib/record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function appliedOf(meta: unknown): { source: string; applied: AppliedCell[] } | null {
  if (!meta || typeof meta !== "object") return null;
  const o = meta as { source?: unknown; applied?: unknown };
  if (typeof o.source !== "string" || !Array.isArray(o.applied)) return null;
  const applied: AppliedCell[] = [];
  for (const c of o.applied) {
    if (!c || typeof c !== "object") continue;
    const { d, m, p } = c as { d?: unknown; m?: unknown; p?: unknown };
    if (typeof d !== "string" || typeof m !== "string") continue;
    applied.push({ d, m, p: typeof p === "string" ? p : null });
  }
  return applied.length ? { source: o.source, applied } : null;
}

/** Reject a Log item: undo what it wrote to the daily table (when the exact
 * cells were recorded at structure time) and mark it discarded. Pending items
 * are simply discarded. `{ id }`. */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: string };
  const id = (body.id ?? "").trim();
  if (!id) {
    return NextResponse.json({ error: "Pass the log item id." }, { status: 400 });
  }

  const rDir = recordDir();
  const item = readRecord(rDir).inbox.find((i) => i.id === id);
  if (!item) {
    return NextResponse.json({ error: "No log item with that id." }, { status: 404 });
  }
  if (item.status === "discarded") {
    return NextResponse.json({ error: "Already rejected." }, { status: 400 });
  }

  // Undo the merge: replay the recorded cell changes in reverse (restore the
  // prior value; clear cells that didn't exist before).
  let reverted = 0;
  const undo = appliedOf(item.meta);
  if (item.status === "structured" && undo) {
    const edits: DailyEdit[] = [...undo.applied].reverse().map((c) => ({
      op: "set",
      source: undo.source,
      metric: c.m,
      date: c.d,
      value: c.p ?? "",
    }));
    applyDailyEdits(edits, { recordDir: rDir });
    reverted = undo.applied.length;
  }

  const meta = item.meta && typeof item.meta === "object" ? item.meta : {};
  updateInboxItems(
    [{ id, status: "discarded", meta: { ...meta, rejectedAt: new Date().toISOString() } }],
    { recordDir: rDir },
  );
  rebuild({ recordDir: rDir });

  return NextResponse.json({ ok: true, reverted });
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import {
  applyDailyEdits,
  landInboxCaptures,
  readInboxFromRecord,
  refreshSyncCache,
  revertEditsFromAppliedMeta,
  updateInboxItems,
} from "@/lib/record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  // The inbox stream ONLY — readRecord would also parse events.jsonl (hundreds of
  // MB) just to look up one capture by id.
  const item = readInboxFromRecord(rDir).find((i) => i.id === id);
  if (!item) {
    return NextResponse.json({ error: "No log item with that id." }, { status: 404 });
  }
  if (item.status === "discarded") {
    return NextResponse.json({ error: "Already rejected." }, { status: 400 });
  }

  // Undo the merge: replay the recorded cell changes in reverse (restore the
  // prior value; clear cells that didn't exist before).
  let reverted = 0;
  let touched: string[] = [];
  if (item.status === "structured") {
    const edits = revertEditsFromAppliedMeta(item.meta);
    const result = applyDailyEdits(edits, { recordDir: rDir });
    reverted = result.sets + result.clears;
    touched = result.sources;
  }

  const rejected = {
    ...item,
    status: "discarded",
    meta: {
      ...(item.meta && typeof item.meta === "object" ? item.meta : {}),
      rejectedAt: new Date().toISOString(),
    },
  };
  updateInboxItems([{ id, status: rejected.status, meta: rejected.meta }], { recordDir: rDir });
  // Patch the cells this reject touched, then the one inbox row — a full rebuild
  // re-derives every event in the record (minutes of frozen server) to undo one
  // merge. landInboxCaptures falls back to that rebuild only when no cache exists.
  refreshSyncCache({ sources: touched }, { recordDir: rDir });
  landInboxCaptures([rejected], { recordDir: rDir });

  return NextResponse.json({ ok: true, reverted });
}

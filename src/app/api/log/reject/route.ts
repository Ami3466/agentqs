import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import {
  applyDailyEdits,
  readRecord,
  rebuild,
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
  if (item.status === "structured") {
    const edits = revertEditsFromAppliedMeta(item.meta);
    const result = applyDailyEdits(edits, { recordDir: rDir });
    reverted = result.sets + result.clears;
  }

  const meta = item.meta && typeof item.meta === "object" ? item.meta : {};
  updateInboxItems(
    [{ id, status: "discarded", meta: { ...meta, rejectedAt: new Date().toISOString() } }],
    { recordDir: rDir },
  );
  rebuild({ recordDir: rDir });

  return NextResponse.json({ ok: true, reverted });
}

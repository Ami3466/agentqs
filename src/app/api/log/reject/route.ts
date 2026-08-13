import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { logReject } from "@/lib/cli-core";
import { readInboxFromRecord } from "@/lib/record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reject a Log item: undo what it wrote to the daily table (when the exact
 * cells were recorded at structure time) and mark it discarded. The undo is
 * conditional — a cell someone has changed since the merge holds THEIR value,
 * not the capture's, so it stays and `reverted` doesn't count it. Pending items
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

  // One brain: the same core the CLI and MCP reject through. It replays the
  // recorded cells in reverse, forgets a rejected column-merge's rule (or the
  // next import would silently redo what this just undid), and patches only the
  // sources it rewrote plus the one inbox row — never a full rebuild.
  const { reverted } = logReject(id);

  return NextResponse.json({ ok: true, reverted });
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { nudges, nudgeRemove, nudgeSave, nudgeTest } from "@/lib/cli-core";
import type { NudgeInput } from "@/lib/nudges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List every configured daily nudge (scheduled outbound message) + its state. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json({ nudges: nudges() });
}

/** Create/update a nudge, or POST {action:"test", id} to send one now (no schedule
 *  consumed). Body for upsert: {channel, target, text, atLocal, id?, enabled?}. */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as (NudgeInput & { action?: string }) | Record<string, unknown>;
  try {
    if ((body as { action?: string }).action === "test") {
      const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id.trim() : "";
      if (!id) return NextResponse.json({ error: "Missing nudge id." }, { status: 400 });
      const nudge = await nudgeTest(id);
      return NextResponse.json({ ok: true, sent: true, nudge });
    }
    const saved = nudgeSave(body as NudgeInput);
    return NextResponse.json({ ok: true, nudge: saved, nudges: nudges() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Delete a nudge by id. */
export async function DELETE(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "Missing nudge id." }, { status: 400 });
  const removed = nudgeRemove(id);
  return NextResponse.json({ ok: true, ...removed, nudges: nudges() });
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { structurePending } from "@/lib/structure-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drain pending inbox items into the daily table via the shared Structure core
 * (clean CSV → direct column map, prose → LLM). One implementation backs this
 * route, the `agentqs structure` CLI, and the MCP tool.
 *
 * Body: `{ id }` structures one pending item; `{}` / `{ all: true }` drains all.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { id?: string; all?: boolean };
  const r = await structurePending({ id: body.id, all: body.all }); // wipes demo itself
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: r.error?.includes("isn't in") ? 404 : 400 });
  }
  return NextResponse.json({
    ok: true,
    structured: r.structured,
    results: r.results,
    pending: r.pending,
    dailyRows: r.dailyRows,
  });
}

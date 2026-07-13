import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { buildSources } from "@/lib/source-registry";
import { disconnectSource, setInterval as setSourceInterval } from "@/lib/cli-core";
import { isValidInterval } from "@/lib/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Pipeline-tab sources list: kind, connected, last-sync, interval, stale/due. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const cfg = readConfig();
  return NextResponse.json({ sources: buildSources(cfg, recordDir()) });
}

/** Set one source's sync interval (persisted per user), return the fresh list.
 *  Goes through the core setter, so a backup target — not a source — is refused
 *  here too, with a pointer to POST /api/backup. */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; interval?: unknown };
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return NextResponse.json({ error: "Missing source id." }, { status: 400 });
  }
  if (!isValidInterval(body.interval)) {
    return NextResponse.json({ error: "Invalid interval." }, { status: 400 });
  }
  try {
    setSourceInterval(id, body.interval);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  return NextResponse.json({ ok: true, sources: buildSources(readConfig(), recordDir()) });
}

/** Remove an automated import — drop its data, credential, and schedule. Returns
 *  the fresh list, with the source now back in the Connections catalog. */
export async function DELETE(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return NextResponse.json({ error: "Missing source id." }, { status: 400 });
  }
  try {
    disconnectSource(id);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  return NextResponse.json({ ok: true, sources: buildSources(readConfig(), recordDir()) });
}

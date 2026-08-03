import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { cachedJson } from "@/lib/api";
import { storeStamp } from "@/lib/cache-stamp";
import { dataDir, recordDir } from "@/lib/paths";
import { buildSources } from "@/lib/source-registry";
import { disconnectSource, resetSource, setInterval as setSourceInterval } from "@/lib/cli-core";
import { isValidInterval } from "@/lib/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Pipeline-tab sources list: kind, connected, last-sync, interval, stale/due. */
export async function GET(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // Connection + schedule state lives in the config and the sync ledgers, so both
  // stamp this view — a 304 must never hide a sync that just finished.
  return cachedJson(req, () => ({ sources: buildSources(readConfig(), recordDir()) }), [
    storeStamp(dataDir()),
  ]);
}

/** Set one source's sync interval (persisted per user), or `{"action":"reset"}` to wipe
 *  what it landed while KEEPING its connection — the repair path for a record poisoned
 *  by an importer bug, since a re-sync only merges and can never delete an invented row.
 *  Returns the fresh list. Goes through the core setters, so a backup target — not a
 *  source — is refused here too, with a pointer to POST /api/backup. */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    id?: unknown;
    interval?: unknown;
    action?: unknown;
  };
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return NextResponse.json({ error: "Missing source id." }, { status: 400 });
  }
  if (body.action === "reset") {
    try {
      const result = resetSource(id);
      return NextResponse.json({
        ok: true,
        reset: result,
        sources: buildSources(readConfig(), recordDir()),
      });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
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

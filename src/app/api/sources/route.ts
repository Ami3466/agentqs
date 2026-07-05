import { NextResponse } from "next/server";
import { readConfig, writeConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { buildSources } from "@/lib/source-registry";
import { isValidInterval } from "@/lib/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Data-tab sources list: kind, connected, last-sync, interval, stale/due. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const cfg = readConfig();
  return NextResponse.json({ sources: buildSources(cfg, recordDir()) });
}

/** Set one source's sync interval (persisted per user), return the fresh list. */
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

  const cfg = readConfig();
  if (!cfg) {
    return NextResponse.json({ error: "No config." }, { status: 500 });
  }
  cfg.sourceIntervals = { ...(cfg.sourceIntervals ?? {}), [id]: body.interval };
  writeConfig(cfg);

  return NextResponse.json({ ok: true, sources: buildSources(cfg, recordDir()) });
}

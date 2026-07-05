import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readConfig, sanitizeJournalViews, writeConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Saved Journal table layouts for the current user (from config.json). */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const cfg = readConfig();
  return NextResponse.json({ views: cfg?.journalViews ?? [] });
}

/** Replace the saved-views list. The client owns the list (add/apply/delete)
 * and POSTs the whole array; we sanitize and persist it into config. */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const cfg = readConfig();
  if (!cfg) {
    return NextResponse.json({ error: "No config." }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as { views?: unknown };
  cfg.journalViews = sanitizeJournalViews(body.views);
  try {
    writeConfig(cfg);
  } catch {
    return NextResponse.json({ error: "Could not save views." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, views: cfg.journalViews });
}

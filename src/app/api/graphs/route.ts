import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readConfig, sanitizeSavedGraphs, writeConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const cfg = readConfig();
  return NextResponse.json({ graphs: cfg?.savedGraphs ?? [] });
}

export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const cfg = readConfig();
  if (!cfg) {
    return NextResponse.json({ error: "No config." }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as { graphs?: unknown };
  cfg.savedGraphs = sanitizeSavedGraphs(body.graphs);
  try {
    writeConfig(cfg);
  } catch {
    return NextResponse.json({ error: "Could not save graphs." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, graphs: cfg.savedGraphs });
}

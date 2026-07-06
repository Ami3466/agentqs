import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { readConfig } from "@/lib/config";
import { buildSources } from "@/lib/source-registry";
import { automationRun } from "@/lib/cli-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Replay one automation now. This is the endpoint both the "record it once" trial
 * run and lazy-sync-on-open POST to (the source's syncEndpoint carries `?id=`).
 * Always headless here — a headed browser only makes sense on the user's own
 * machine via the CLI (`agentqs automation run <id> --headed`).
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  const id = (typeof body.id === "string" && body.id.trim()) || url.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "Missing automation id." }, { status: 400 });
  try {
    const result = await automationRun({ id });
    return NextResponse.json({ ok: true, result, sources: buildSources(readConfig(), recordDir()) });
  } catch (e) {
    // Surface the failure but still return the fresh list (last-run status updated).
    return NextResponse.json(
      { error: (e as Error).message, sources: buildSources(readConfig(), recordDir()) },
      { status: 502 },
    );
  }
}

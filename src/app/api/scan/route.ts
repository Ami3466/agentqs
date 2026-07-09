import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { scan } from "@/lib/cli-core";
import { pendingFindings } from "@/lib/column-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Open data-quality findings (pending scanner notifications) — pure read, no
 *  scan. This is what the quality panels render on mount, so results survive
 *  navigation. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json({ ok: true, findings: pendingFindings() });
}

/**
 * The data-quality scan (Journal → Table → "Scan data", Data → Data quality →
 * "Scan"). Re-applies saved merge rules, then checks every daily column for
 * duplicates (merge), dead all-zero columns (drop) and messy values (clean), and
 * queues each new finding as an inbox notification — structuring that
 * notification (the normal /api/structure route) applies the fix. Same core as
 * `agentqs scan`. `{fix: true}` applies every open fix immediately.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { fix?: boolean };
  try {
    const r = scan({ fix: Boolean(body.fix) });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { auditIndex } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Index audit (same object as `agentqs audit` and the MCP tool): deterministic
 *  evidence — impossible dates, single-day sources, coverage holes, stale
 *  sources, outlier values — for an AI review pass. Read-only. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json(auditIndex());
}

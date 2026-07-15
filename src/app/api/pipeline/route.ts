import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { apiError } from "@/lib/api";
import { pipelineReport } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The data-pipeline truth table (same object as `agentqs pipeline` and the MCP
 *  tool): per source — origin, credential provenance, schedule, scheduler
 *  presence, last run outcome, landed data coverage. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    return NextResponse.json(pipelineReport());
  } catch (e) {
    return apiError(e);
  }
}

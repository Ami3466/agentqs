import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { apiError, cachedJson } from "@/lib/api";
import { storeStamp } from "@/lib/cache-stamp";
import { dataDir } from "@/lib/paths";
import { pipelineReport } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The data-pipeline truth table (same object as `agentqs pipeline` and the MCP
 *  tool): per source — origin, credential provenance, schedule, scheduler
 *  presence, last run outcome, landed data coverage. */
export async function GET(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    // Schedules and run outcomes live beside the cache, so the report moves when
    // they do — the store stamp is what keeps this ETag honest mid-sync.
    return cachedJson(req, () => pipelineReport(), [storeStamp(dataDir())]);
  } catch (e) {
    return apiError(e);
  }
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { apiError } from "@/lib/api";
import { buildCoverage } from "@/lib/coverage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/coverage — the shape of the whole record: every source with its total rows,
 * distinct days, date span, and a per-year histogram, plus the year axis and record
 * totals. The Overview tab renders this as a source×year heatmap; an agent GETs it to
 * learn what streams exist and how far back each goes before querying. Same brain as
 * the `coverage` CLI command and MCP tool (buildCoverage).
 */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    return NextResponse.json(buildCoverage());
  } catch (e) {
    return apiError(e);
  }
}

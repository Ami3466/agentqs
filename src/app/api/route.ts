import { NextResponse } from "next/server";
import { API_CATALOG, API_OMISSIONS, API_ORIENTATION } from "@/lib/api-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The API discovery manifest — an agent's FIRST call. Lists every door with its CLI +
 * MCP equivalent, the routing rules that stop wrong-door mistakes (analysis is
 * /api/query not /api/chat; recall is /api/search; connecting means storing a working
 * key), and the capabilities deliberately left off HTTP.
 *
 * Intentionally UNAUTHENTICATED: it exposes only the API's SHAPE (no record data), so
 * an agent can orient before it authenticates. Mutating routes still require the
 * bearer key; that rule is stated in the orientation.
 */
export function GET() {
  return NextResponse.json({
    name: "agentqs",
    description:
      "Local-first personal data journal: plain-text record → SQLite cache → web / CLI / MCP / API, all driving one core.",
    faces: {
      api: "this HTTP API (bearer key for mutations)",
      cli: "agentqs <command> (npm run cli -- <command>)",
      mcp: "agentqs serve --mcp",
    },
    orientation: API_ORIENTATION,
    startHere: "/api/onboarding",
    endpoints: API_CATALOG,
    notOnHttp: API_OMISSIONS,
  });
}

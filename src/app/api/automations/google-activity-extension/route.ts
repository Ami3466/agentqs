import { NextResponse } from "next/server";
import { ingestCorsHeaders, isAllowedIngestOrigin, runIngest, type IngestBody } from "@/lib/ingest-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Same-port ingest path. Validation, origin policy and the ingest call live in
 *  src/lib/ingest-server.ts, shared with the standalone listener the extension
 *  falls back to when this route is unavailable (dev recompile, route flap). */

export function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: ingestCorsHeaders(req.headers.get("origin")) });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (!isAllowedIngestOrigin(origin)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: ingestCorsHeaders(origin) });
  }
  const body = (await req.json().catch(() => ({}))) as IngestBody;
  const { status, payload } = runIngest(body);
  return NextResponse.json(payload as Record<string, unknown>, { status, headers: ingestCorsHeaders(origin) });
}

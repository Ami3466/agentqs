import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { migrateStore } from "@/lib/store-doctor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Move the store to a sync-safe location (same operation as
 *  `agentqs migrate-store` and the MCP tool). Body: { to?, dryRun? }.
 *  The server keeps serving from its open handles — restart it after a
 *  real (non-dry) migration so it opens the new store. */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  let body: { to?: string; dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body = defaults */
  }
  try {
    return NextResponse.json(migrateStore({ to: body.to, dryRun: body.dryRun }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

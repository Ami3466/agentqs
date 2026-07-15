import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { apiError } from "@/lib/api";
import { doctorReport } from "@/lib/store-doctor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Store health (same object as `agentqs doctor` and the MCP tool): sync-engine
 *  exposure, cloud-evicted files, "X 2" conflict twins, split stores. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    return NextResponse.json(doctorReport());
  } catch (e) {
    return apiError(e);
  }
}

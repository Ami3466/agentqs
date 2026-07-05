import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readDailySummary } from "@/lib/daily";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only summary of the rebuilt daily cache — powers the Data-tab preview. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json(readDailySummary());
}

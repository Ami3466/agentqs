import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { apiError } from "@/lib/api";
import { readDailySummary } from "@/lib/daily";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only summary of the rebuilt daily cache — powers the Pipeline-tab preview. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    return NextResponse.json(readDailySummary());
  } catch (e) {
    return apiError(e);
  }
}

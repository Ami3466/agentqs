import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { apiError } from "@/lib/api";
import { onboardingGuide } from "@/lib/cli-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The live onboarding checklist (same object as `agentqs onboarding` and the
 *  MCP tool): every setup step with its exact CLI / MCP / API call and a
 *  `done` flag derived from real state. Read-only. */
export async function GET() {
  if (!getCurrentUser()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(onboardingGuide());
  } catch (e) {
    return apiError(e);
  }
}

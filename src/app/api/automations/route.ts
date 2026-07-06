import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { readConfig } from "@/lib/config";
import { buildSources } from "@/lib/source-registry";
import { automations, automationSave, disconnectSource } from "@/lib/cli-core";
import type { SaveAutomationInput } from "@/lib/automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List every configured automation (redacted — secrets shown as booleans). */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json({ automations: automations() });
}

/** Create or update an automation recipe (site + credentials + recorded steps). */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as SaveAutomationInput;
  try {
    const saved = automationSave(body);
    return NextResponse.json({ ok: true, automation: saved, sources: buildSources(readConfig(), recordDir()) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Delete an automation — its recipe, secrets, data, and schedule. */
export async function DELETE(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "Missing automation id." }, { status: 400 });
  try {
    disconnectSource(id);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  return NextResponse.json({ ok: true, sources: buildSources(readConfig(), recordDir()) });
}

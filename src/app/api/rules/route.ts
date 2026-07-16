import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import * as core from "@/lib/cli-core";
import type { RuleInput } from "@/lib/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List every agent rule + its state. */
export async function GET() {
  if (!getCurrentUser()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  return NextResponse.json(core.rulesList());
}

/** Create/update a rule, or POST {action:"test", id} to fire one now. */
export async function POST(req: Request) {
  if (!getCurrentUser()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as (RuleInput & { action?: string }) & Record<string, unknown>;
  try {
    if (body.action === "test") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
      return NextResponse.json({ ...(await core.rulesTest(id)), sent: true });
    }
    return NextResponse.json({ ok: true, ...core.rulesUpsert(body) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Delete a rule by id. */
export async function DELETE(req: Request) {
  if (!getCurrentUser()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...core.rulesRemove(id) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

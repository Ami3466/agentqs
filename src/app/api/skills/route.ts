import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listSkills, removeSkill, upsertSkill } from "@/lib/skills-store";
import { isBuiltinSkill } from "@/lib/skills-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mentors (personas) as a resource — the JSON API face of `agentqs skill …` and
 * the MCP `skill_*` tools. GET lists built-ins + your own; POST adds/edits a
 * custom mentor; DELETE removes one. The chat brain resolves whatever lands here,
 * so a mentor added over the API answers in the GUI and every channel.
 */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const skills = listSkills().map((s) => ({ ...s, builtin: isBuiltinSkill(s.id) }));
  return NextResponse.json({ skills });
}

export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    blurb?: string;
    system?: string;
  };
  if (!body.name || !body.system) {
    return NextResponse.json({ error: "A mentor needs a name and a system prompt." }, { status: 400 });
  }
  try {
    const { skill, created } = upsertSkill({
      id: body.id,
      name: body.name,
      blurb: body.blurb,
      system: body.system,
    });
    return NextResponse.json({ ok: true, skill, created });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) {
    return NextResponse.json({ error: "Pass ?id=<mentor>." }, { status: 400 });
  }
  try {
    const removed = removeSkill(id);
    if (!removed) return NextResponse.json({ error: `No custom mentor "${id}".` }, { status: 404 });
    return NextResponse.json({ ok: true, removed: id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

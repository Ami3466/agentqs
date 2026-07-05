import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readConfig, writeConfig } from "@/lib/config";
import {
  effectiveMentors,
  mentorId,
  sanitizeMentor,
  type Mentor,
} from "@/lib/mentors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mentor CRUD. The effective list = the user's saved set once they've touched it,
 * else the three built-ins. Any mutation seeds the built-ins into config.json first
 * (so they become editable copies) then applies the change, keeping config the
 * single source of truth the chat chip and settings editor both read.
 *
 *   GET             → { mentors }
 *   POST   {name,blurb,system}      → create; returns { mentor, mentors }
 *   PUT    {id,name,blurb,system}   → edit;   returns { mentor, mentors }
 *   DELETE {id}                     → delete; returns { mentors }
 */

function auth() {
  return Boolean(getCurrentUser());
}

/** Load config + its current effective mentor list; null when there is no config. */
function load(): { cfg: NonNullable<ReturnType<typeof readConfig>>; list: Mentor[] } | null {
  const cfg = readConfig();
  if (!cfg) return null;
  return { cfg, list: [...effectiveMentors(cfg.mentors)] };
}

export async function GET() {
  if (!auth()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const ctx = load();
  if (!ctx) return NextResponse.json({ error: "No config." }, { status: 400 });
  return NextResponse.json({ mentors: ctx.list });
}

export async function POST(req: Request) {
  if (!auth()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const ctx = load();
  if (!ctx) return NextResponse.json({ error: "No config." }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const system = typeof body.system === "string" ? body.system.trim() : "";
  if (!name) return NextResponse.json({ error: "A mentor needs a name." }, { status: 400 });
  if (!system) return NextResponse.json({ error: "A mentor needs a system prompt." }, { status: 400 });

  const id = mentorId(name, ctx.list.map((m) => m.id));
  const mentor = sanitizeMentor({ id, name, blurb: body.blurb, system });
  if (!mentor) return NextResponse.json({ error: "Invalid mentor." }, { status: 400 });

  const list = [...ctx.list, mentor];
  ctx.cfg.mentors = list;
  try {
    writeConfig(ctx.cfg);
  } catch {
    return NextResponse.json({ error: "Could not save." }, { status: 500 });
  }
  return NextResponse.json({ mentor, mentors: list });
}

export async function PUT(req: Request) {
  if (!auth()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const ctx = load();
  if (!ctx) return NextResponse.json({ error: "No config." }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const idx = ctx.list.findIndex((m) => m.id === id);
  if (idx < 0) return NextResponse.json({ error: "No such mentor." }, { status: 404 });

  const name = typeof body.name === "string" ? body.name.trim() : ctx.list[idx].name;
  const system = typeof body.system === "string" ? body.system.trim() : ctx.list[idx].system;
  if (!name) return NextResponse.json({ error: "A mentor needs a name." }, { status: 400 });
  if (!system) return NextResponse.json({ error: "A mentor needs a system prompt." }, { status: 400 });

  // Keep the id stable so saved sessions and the localStorage pick still resolve.
  const mentor = sanitizeMentor({ id, name, blurb: body.blurb ?? ctx.list[idx].blurb, system });
  if (!mentor) return NextResponse.json({ error: "Invalid mentor." }, { status: 400 });

  const list = ctx.list.map((m) => (m.id === id ? mentor : m));
  ctx.cfg.mentors = list;
  try {
    writeConfig(ctx.cfg);
  } catch {
    return NextResponse.json({ error: "Could not save." }, { status: 500 });
  }
  return NextResponse.json({ mentor, mentors: list });
}

export async function DELETE(req: Request) {
  if (!auth()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const ctx = load();
  if (!ctx) return NextResponse.json({ error: "No config." }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!ctx.list.some((m) => m.id === id)) {
    return NextResponse.json({ error: "No such mentor." }, { status: 404 });
  }
  const list = ctx.list.filter((m) => m.id !== id);
  if (!list.length) return NextResponse.json({ error: "Keep at least one mentor." }, { status: 400 });

  ctx.cfg.mentors = list;
  try {
    writeConfig(ctx.cfg);
  } catch {
    return NextResponse.json({ error: "Could not save." }, { status: 500 });
  }
  return NextResponse.json({ mentors: list });
}

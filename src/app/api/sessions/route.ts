import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readConfig } from "@/lib/config";
import { recordDir } from "@/lib/paths";
import { appendSession, readSessionsFromRecord, rebuild } from "@/lib/record";
import { skillById } from "@/lib/skills";
import type { LlmMessage } from "@/lib/llm";
import {
  openCommitments,
  priorSessionsNewestFirst,
  synthesizeSession,
} from "@/lib/synthesis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The synthesis view of a session sent to the client — no transcript. */
interface SessionView {
  id: string;
  date: string;
  startedAt: string;
  skill: string;
  title: string | null;
  summary: string | null;
  insights: string[];
  commitments: string[];
}

function toView(s: {
  id: string;
  date: string | null;
  startedAt: string;
  skill: string;
  title: string | null;
  summary: string | null;
  insights: string[];
  commitments: string[];
}): SessionView {
  return {
    id: s.id,
    date: s.date ?? s.startedAt.slice(0, 10),
    startedAt: s.startedAt,
    skill: s.skill,
    title: s.title,
    summary: s.summary,
    insights: s.insights,
    commitments: s.commitments,
  };
}

/** Persisted sessions (synthesis only), newest first — powers the sidebar. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const sessions = readSessionsFromRecord(recordDir());
  return NextResponse.json({
    sessions: priorSessionsNewestFirst(sessions).map(toView),
    openCommitments: openCommitments(sessions).length,
  });
}

/**
 * End a session: distill the transcript into {title, summary, insights,
 * commitments}, append it to the typed session store (record/sessions.jsonl,
 * separate from daily data), rebuild the cache so it lands on the Journal
 * timeline, and return the synthesis. The agent later reads this synthesis —
 * never the transcript — for continuity.
 *
 * Body: `{ messages: [{role,content}], skill, title?, startedAt? }`.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    messages?: LlmMessage[];
    skill?: string;
    title?: string;
    startedAt?: string;
  };

  const messages = Array.isArray(body.messages)
    ? body.messages.filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim(),
      )
    : [];
  if (!messages.some((m) => m.role === "user")) {
    return NextResponse.json({ error: "Nothing to save — a session needs at least one message." }, { status: 400 });
  }

  const skill = skillById(body.skill).id;
  const startedAt = body.startedAt || new Date().toISOString();
  const date = startedAt.slice(0, 10);
  const cfg = readConfig();

  const { synthesis, via, transcript } = await synthesizeSession({ messages, skill, date, cfg });

  const rDir = recordDir();
  const item = appendSession(
    {
      skill,
      startedAt,
      date,
      title: body.title?.trim() || synthesis.title || null,
      summary: synthesis.summary || null,
      transcript, // kept in the record for provenance; the agent never reads it back
      insights: synthesis.insights,
      commitments: synthesis.commitments,
    },
    { recordDir: rDir },
  );
  rebuild({ recordDir: rDir });

  return NextResponse.json({ ok: true, via, session: toView(item) });
}

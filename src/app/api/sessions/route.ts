import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readConfig } from "@/lib/config";
import { recordDir } from "@/lib/paths";
import { appendSession, readSessionsFromRecord, rebuild, removeSessionFromRecord } from "@/lib/record";
import { resolveSkill } from "@/lib/skills-store";
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
 * End a session and record its synthesis {title, summary, insights, commitments}
 * to the typed session store (record/sessions.jsonl, separate from daily data),
 * rebuild so it lands on the Journal timeline, and return it. The agent later reads
 * this synthesis — never the transcript — for continuity.
 *
 * TWO shapes, because YOU are the AI:
 *  - Key-free (the self-building path): send the synthesis you already reasoned —
 *    `{ insights: [...], commitments: [...], summary?, title?, skill?, startedAt?,
 *    transcript? }`. Nothing is sent to any model; agentqs just validates + records.
 *    Same contract idea as POST /api/structure's `csv`.
 *  - Transcript: `{ messages: [{role,content}], skill, title?, startedAt? }` — agentqs
 *    distills it with the configured AI key (what the built-in chat UI uses).
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
    summary?: string;
    insights?: string[];
    commitments?: string[];
    transcript?: string;
  };

  const skill = resolveSkill(body.skill).id;
  const startedAt = body.startedAt || new Date().toISOString();
  const date = startedAt.slice(0, 10);
  const rDir = recordDir();

  const cleanList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()) : [];
  const insights = cleanList(body.insights);
  const commitments = cleanList(body.commitments);
  const summary = typeof body.summary === "string" ? body.summary.trim() : "";

  // Key-free path: the agent already did the reasoning — record it verbatim, no model call.
  if (insights.length || commitments.length || summary) {
    const item = appendSession(
      {
        skill,
        startedAt,
        date,
        title: body.title?.trim() || null,
        summary: summary || null,
        transcript: typeof body.transcript === "string" ? body.transcript : "", // optional provenance
        insights,
        commitments,
      },
      { recordDir: rDir },
    );
    rebuild({ recordDir: rDir });
    return NextResponse.json({ ok: true, via: "provided", session: toView(item) });
  }

  // Transcript path: distill with the configured AI (the chat UI's flow).
  const messages = Array.isArray(body.messages)
    ? body.messages.filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim(),
      )
    : [];
  if (!messages.some((m) => m.role === "user")) {
    return NextResponse.json(
      {
        error:
          "Nothing to save. Send the synthesis you reasoned — {insights:[…], commitments:[…], summary?} — or a transcript {messages:[…]} for agentqs to distill.",
      },
      { status: 400 },
    );
  }

  const cfg = readConfig();
  const { synthesis, via, transcript } = await synthesizeSession({ messages, skill, date, cfg });

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

/** Delete a session from the record by id, then rebuild so it leaves the timeline. */
export async function DELETE(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const id = (searchParams.get("id") || "").trim();
  if (!id) {
    return NextResponse.json({ error: "Which session? Pass ?id=…" }, { status: 400 });
  }
  const rDir = recordDir();
  const removed = removeSessionFromRecord(id, { recordDir: rDir });
  if (!removed) {
    return NextResponse.json({ error: "No such session." }, { status: 404 });
  }
  rebuild({ recordDir: rDir });
  return NextResponse.json({ ok: true, id });
}

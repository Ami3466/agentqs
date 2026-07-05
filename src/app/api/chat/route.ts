import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { llmComplete, type LlmMessage } from "@/lib/llm";
import { recordDir } from "@/lib/paths";
import { readSessionsFromRecord } from "@/lib/record";
import { skillById } from "@/lib/skills";
import { continuityBlock, continuityFallbackReply } from "@/lib/synthesis";
import { groundedCrossSourceAnswer, groundingContext, readGrounding } from "@/lib/grounding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Does the message look like it's asking about the user's data (so the keyless
 *  path should compute a grounded cross-source answer rather than a persona note)? */
function looksLikeDataQuestion(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("?")) return true;
  return /\b(why|how|what|when|which|compare|correlat|affect|impact|pattern|trend|productiv|focus|sleep|commit|meeting|music|recovery|hrv|heart|listen)\b/.test(
    t,
  );
}

/**
 * Plain-text chat, now with memory (Loop 9). The persona's system prompt is
 * augmented with a continuity block built from the synthesis of past sessions
 * (summaries / insights / commitments — never the raw transcripts), so a new
 * session can pick up an earlier commitment. With no key set it degrades to a
 * persona-flavoured note that still references the latest open commitment when a
 * session opens. `>>` memos and `/` commands never reach here.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    message?: string;
    skill?: string;
    history?: LlmMessage[];
  };
  const message = (body.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ error: "Say something first." }, { status: 400 });
  }

  const skill = skillById(body.skill);
  const cfg = readConfig();

  const history = Array.isArray(body.history)
    ? body.history
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-10)
    : [];
  const sessionStart = history.length === 0;

  // Prior sessions' synthesis — the memory the agent reads (not transcripts).
  const prior = readSessionsFromRecord(recordDir());
  // Real numbers from the daily cache — the grounding both paths reason over.
  const grounding = readGrounding();

  // No key yet: honest, persona-flavoured fallback. But a data question over ≥2
  // sources still gets a real, grounded cross-source answer computed from the
  // numbers — no model, no invention.
  if (!cfg?.llmProvider || !cfg?.llmKey) {
    if (grounding.sources.length >= 2 && looksLikeDataQuestion(message)) {
      const answer = groundedCrossSourceAnswer(grounding, message);
      if (answer) {
        return NextResponse.json({
          reply: answer.text,
          skill: skill.id,
          grounded: true,
          sources: answer.sources,
          metrics: answer.metrics,
          continuity: false,
        });
      }
    }
    const opener = sessionStart ? continuityFallbackReply(skill.name, prior) : null;
    return NextResponse.json({
      reply:
        opener ??
        `I'm your ${skill.name.toLowerCase()}. Add an AI key in Settings and I'll answer this ` +
          `grounded in your real data. Until then, log with \`>>\` and I'll keep your record building.`,
      skill: skill.id,
      grounded: false,
      continuity: Boolean(opener),
    });
  }

  const memory = continuityBlock(prior);
  const dataBlock = groundingContext(grounding);
  const system = [skill.system, dataBlock, memory].filter(Boolean).join("\n\n");

  try {
    const reply = await llmComplete({
      provider: cfg.llmProvider,
      apiKey: cfg.llmKey,
      model: cfg.model,
      system,
      messages: [...history, { role: "user", content: message }],
    });
    return NextResponse.json({
      reply: reply || "(no reply)",
      skill: skill.id,
      grounded: Boolean(dataBlock),
      sources: grounding.sources,
      continuity: Boolean(memory),
      model: cfg.model || null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Model call failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}

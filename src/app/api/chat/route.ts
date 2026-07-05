import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { llmComplete, type LlmMessage } from "@/lib/llm";
import { skillById } from "@/lib/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Plain-text chat. Loop 6 keeps it single-turn: the persona's system prompt +
 * recent history to the configured provider. With no key set it degrades to a
 * persona-flavoured note (grounded, tool-using chat is Loop 4). `>>` memos and
 * `/` commands never reach here — the input parses those on the client.
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

  // No key yet: honest, persona-flavoured fallback rather than a fake answer.
  if (!cfg?.llmProvider || !cfg?.llmKey) {
    return NextResponse.json({
      reply:
        `I'm your ${skill.name.toLowerCase()}. Add an AI key in Settings and I'll answer this ` +
        `grounded in your real data. Until then, log with \`>>\` and I'll keep your record building.`,
      skill: skill.id,
      grounded: false,
    });
  }

  const history = Array.isArray(body.history)
    ? body.history
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-10)
    : [];

  try {
    const reply = await llmComplete({
      provider: cfg.llmProvider,
      apiKey: cfg.llmKey,
      model: cfg.model,
      system: skill.system,
      messages: [...history, { role: "user", content: message }],
    });
    return NextResponse.json({
      reply: reply || "(no reply)",
      skill: skill.id,
      grounded: false,
      model: cfg.model || null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Model call failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}

import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import type { LlmMessage } from "@/lib/llm";
import { dbPath, recordDir } from "@/lib/paths";
import { readSessionsFromRecord } from "@/lib/record";
import { effectiveMentors, mentorById } from "@/lib/mentors";
import { continuityBlock, continuityFallbackReply } from "@/lib/synthesis";
import {
  buildSpark,
  groundedCrossSourceAnswer,
  looksLikeDataQuestion,
  looksLikeRecallQuestion,
  readGrounding,
} from "@/lib/grounding";
import { answerRecall } from "@/lib/embeddings";
import { dailyCatalog, resolveModel, streamMentor } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Split a deterministic (non-model) answer into word-boundary chunks so the keyless
 *  path streams into the UI the same way the model path does, one frame per chunk. */
function* chunkText(text: string, size = 42): Generator<string> {
  let buf = "";
  for (const part of text.split(/(\s+)/)) {
    buf += part;
    if (buf.length >= size) {
      yield buf;
      buf = "";
    }
  }
  if (buf) yield buf;
}

/**
 * Stream an answer to the browser as newline-delimited JSON frames:
 *   {"t":"delta","v":"…"}  incremental reply text
 *   {"t":"done", grounded, sources, metrics, spark, mentor, continuity, model}
 *   {"t":"error","error":"…"}  a mid-stream failure
 * The Chat UI reads tokens as they arrive; the `done` frame carries the grounded
 * badge + the inline sparkline. Auth/validation still return plain JSON errors.
 */
function ndjson(pump: (send: (frame: unknown) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: unknown) => controller.enqueue(enc.encode(JSON.stringify(frame) + "\n"));
      try {
        await pump(send);
      } catch (e) {
        send({ t: "error", error: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

/**
 * Plain-text chat = the mentor agent (Loop 4), streamed (Loop 5). With a key the
 * mentor's system prompt is joined with a compact schema catalog + a continuity
 * block (synthesis of past sessions, never raw transcripts) and the Vercel AI SDK
 * agent runs: it calls SQL (query_daily) + FTS (search_notes) tools to ground the
 * reply, and the final text streams to the UI token-by-token. With no key it degrades
 * to a deterministic cross-source answer computed straight from the numbers (still
 * streamed), or a mentor note referencing the latest open commitment. Either way the
 * closing `done` frame carries the grounded sources + a sparkline of a cited metric.
 * `>>` memos and `/` commands never reach here.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    message?: string;
    mentor?: string;
    history?: LlmMessage[];
  };
  const message = (body.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ error: "Say something first." }, { status: 400 });
  }

  const cfg = readConfig();
  const mentor = mentorById(body.mentor, effectiveMentors(cfg?.mentors));

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

  // No key yet: honest, mentor-flavoured fallback. But a data question over ≥2
  // sources still gets a real, grounded cross-source answer computed from the
  // numbers — no model, no invention. Streamed for a consistent UI.
  if (!cfg?.llmProvider || !cfg?.llmKey) {
    return ndjson(async (send) => {
      // Semantic recall ("find days that felt like this") — the local embedding index
      // answers it with no key. Checked first: it's the most specific intent.
      if (looksLikeRecallQuestion(message)) {
        const recall = await answerRecall(message, history);
        if (recall) {
          for (const chunk of chunkText(recall.text)) send({ t: "delta", v: chunk });
          send({
            t: "done",
            mentor: mentor.id,
            grounded: true,
            sources: recall.sources,
            metrics: [],
            spark: null,
            continuity: false,
          });
          return;
        }
      }
      if (grounding.sources.length >= 2 && looksLikeDataQuestion(message)) {
        const answer = groundedCrossSourceAnswer(grounding, message);
        if (answer) {
          for (const chunk of chunkText(answer.text)) send({ t: "delta", v: chunk });
          send({
            t: "done",
            mentor: mentor.id,
            grounded: true,
            sources: answer.sources,
            metrics: answer.metrics,
            spark: buildSpark(grounding, answer.sources, answer.metrics),
            continuity: false,
          });
          return;
        }
      }
      const opener = sessionStart ? continuityFallbackReply(mentor.name, prior) : null;
      const text =
        opener ??
        `I'm your ${mentor.name.toLowerCase()}. Add an AI key in Settings and I'll answer this ` +
          `grounded in your real data. Until then, log with \`>>\` and I'll keep your record building.`;
      for (const chunk of chunkText(text)) send({ t: "delta", v: chunk });
      send({
        t: "done",
        mentor: mentor.id,
        grounded: false,
        sources: [],
        metrics: [],
        spark: null,
        continuity: Boolean(opener),
      });
    });
  }

  const memory = continuityBlock(prior);
  const dbFile = dbPath();
  const catalog = dailyCatalog(dbFile);
  const system = [mentor.system, catalog.hint, memory].filter(Boolean).join("\n\n");

  let model;
  try {
    model = resolveModel(cfg.llmProvider, cfg.llmKey, cfg.model, cfg.llmModels);
  } catch (e) {
    return NextResponse.json({ error: `Model config failed: ${(e as Error).message}` }, { status: 502 });
  }

  return ndjson(async (send) => {
    const { textStream, used, err } = streamMentor({
      model,
      system,
      messages: [...history, { role: "user", content: message }],
      dbFile,
    });

    for await (const delta of textStream) {
      if (delta) send({ t: "delta", v: delta });
    }

    if (err.error) {
      send({ t: "error", error: `Model call failed: ${String((err.error as Error)?.message ?? err.error)}` });
      return;
    }

    // Attribute the grounded badge: the exact sources the tools touched, else (if it
    // queried but didn't SELECT source) fall back to the record's sources.
    const sources = used.sources.size ? [...used.sources].sort() : used.hits > 0 ? grounding.sources : [];
    const metrics = [...used.metrics].sort();
    send({
      t: "done",
      mentor: mentor.id,
      grounded: used.hits > 0,
      sources,
      metrics,
      spark: buildSpark(grounding, sources, metrics),
      continuity: Boolean(memory),
      model: cfg.model || null,
    });
  });
}

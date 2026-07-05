import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { answerRecall, semanticSearch } from "@/lib/embeddings";
import type { LlmMessage } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Semantic search over the record — "find days that felt like this." Runs entirely on
 * the local embedding index + sqlite-vec, so it works with NO AI key set. Returns the
 * closest days (one hit per date) with a dated snippet + match score, and a ready-made
 * grounded answer string. The index is built/refreshed lazily on first call.
 *
 * POST { query, limit? } → { query, hits:[{date,kind,snippet,score}], answer, sources }
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    query?: string;
    limit?: number;
    history?: LlmMessage[];
  };
  const query = (body.query ?? "").trim();
  if (!query) {
    return NextResponse.json({ error: "Say what a day felt like." }, { status: 400 });
  }
  const limit = Math.max(1, Math.min(Number(body.limit) || 5, 25));

  try {
    const recall = answerRecall(query, body.history, { limit });
    const hits = recall?.hits ?? semanticSearch(query, { limit });
    return NextResponse.json({
      query: recall?.query ?? query,
      hits,
      answer: recall?.text ?? "",
      sources: recall?.sources ?? [],
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { photosSearch } from "@/lib/cli-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Text → image recall — "beach at sunset", "my dog". Runs on the local CLIP index, so
 * it works with NO AI key. POST { query, limit? } → { hits:[{id,date,thumb,caption,...}] }.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { query?: string; limit?: number };
  const query = (body.query ?? "").trim();
  if (!query) return NextResponse.json({ error: "Describe the photos to find." }, { status: 400 });
  try {
    const hits = await photosSearch(query, Math.max(1, Math.min(Number(body.limit) || 12, 40)));
    return NextResponse.json({ query, hits });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

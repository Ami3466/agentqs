import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { buildIndex, indexStatus } from "@/lib/embeddings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — the semantic index's status (Settings shows this): built? how many entries?
 *  is it stale vs the current record? which local model + backend. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const status = await indexStatus();
  return NextResponse.json({ ...status, modelId: status.model });
}

/** POST — reindex now (Settings "Reindex"). Rebuilds the local embedding index from
 *  the record. No AI key, no cost — the model is local. */
export async function POST() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const result = await buildIndex();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

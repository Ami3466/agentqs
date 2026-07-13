import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { googleState, setGoogleProducts, toggleGoogleProducts } from "@/lib/google-connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Pipeline's Google card: ONE Google connection, one key, a tree of products
 * (Google → Gmail → Sent). Same object as `agentqs google` and the `google_products`
 * MCP tool.
 *
 * GET  → { connected, products[], missingProducts, needsAuthorize }
 * POST → { products: [...] }            replace the ticked set (what the checkboxes send)
 *        { enable: [...], disable: [...] }  tick/untick a few
 *
 * Ticking is NOT connecting (the connection rule is untouched: connected ⇔ a stored
 * credential). Ticking a product the grant has no scope for answers
 * `needsAuthorize: true` — re-run the authorize dance from Pipeline to widen the
 * SAME key. The credential to do it with lives at POST /api/oauth/gcal.
 */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json(googleState());
}

export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  let body: { products?: unknown; enable?: unknown; disable?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  try {
    const state = Array.isArray(body.products)
      ? setGoogleProducts(list(body.products))
      : toggleGoogleProducts(list(body.enable), list(body.disable));
    return NextResponse.json(state);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

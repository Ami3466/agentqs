import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { beginOAuth, saveOAuthApp } from "@/lib/oauth";
import { requestOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TWO acts, deliberately separate — they have different lifetimes:
 *
 *   { clientId, clientSecret, saveOnly: true } → REGISTER the app key. Once, per
 *       provider. No dance starts. Every account added later reuses it.
 *   { origin }                                 → SIGN IN. Uses the saved key and
 *       hands back the provider's authorize URL. Adding a second account, or logging
 *       back in after a revoke, is just this — never the key form again.
 *
 * (Passing clientId/clientSecret without saveOnly still works: it replaces the key
 * and signs in, which is what "use a different app key" does.)
 */
export async function POST(req: Request, { params }: { params: { source: string } }) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    clientId?: string;
    clientSecret?: string;
    saveOnly?: boolean;
    origin?: string;
  };
  if (body.saveOnly === true) {
    try {
      const r = saveOAuthApp(params.source, body.clientId ?? "", body.clientSecret ?? "");
      return NextResponse.json({ ok: true, saved: true, ...r });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }
  // The redirect URI must match the one the connect form displayed, so prefer the
  // browser's own origin; the fallback reads the PROXY headers, never req.url (in
  // the container that is 0.0.0.0:3000 — a redirect_uri no provider can call back).
  const origin = body.origin?.trim() || requestOrigin(req);
  try {
    const r = beginOAuth(params.source, body.clientId ?? "", body.clientSecret ?? "", origin);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

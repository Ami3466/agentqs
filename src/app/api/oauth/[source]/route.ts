import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { beginOAuth } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start the OAuth dance for an expiring-token source: save the user's app
 *  credentials (client id + secret) and hand back the provider authorize URL
 *  for the browser to visit. The provider then redirects to /api/oauth/callback. */
export async function POST(req: Request, { params }: { params: { source: string } }) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    clientId?: string;
    clientSecret?: string;
    origin?: string;
  };
  // The redirect URI must match the one the connect form displayed, so prefer
  // the browser's own origin over the server-seen request URL.
  const origin = body.origin?.trim() || new URL(req.url).origin;
  try {
    const r = beginOAuth(params.source, body.clientId ?? "", body.clientSecret ?? "", origin);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

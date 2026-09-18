import { NextResponse } from "next/server";
import * as core from "@/lib/cli-core";
import { requestOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Password recovery.
 *   {username}         → email a single-use link (30 min, one per 60s).
 *   {token, password}  → set the new password, clear the token, rotate the session secret.
 *
 * AUTH EXCEPTION — this route does NOT call getCurrentUser(), on purpose: the
 * caller is someone who cannot sign in. Every other route guards; do not "fix"
 * this one. What stands in for the guard is the emailed token (only its hash is
 * stored) and the 60s throttle. Nothing here returns the hash or the token.
 *
 * Not a job: a reset writes config.json and sends one mail. It never touches the record.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { username?: unknown; token?: unknown; password?: unknown };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  try {
    if (str(body.token)) {
      return NextResponse.json(core.passwordResetComplete(str(body.token).trim(), str(body.password)));
    }
    if (!str(body.username).trim()) {
      return NextResponse.json({ error: "Missing the username." }, { status: 400 });
    }
    // The proxy-aware origin, never req.url (0.0.0.0:3000 inside the container).
    return NextResponse.json(await core.passwordResetRequest(str(body.username).trim(), requestOrigin(req)));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

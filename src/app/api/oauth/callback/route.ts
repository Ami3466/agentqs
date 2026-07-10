import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { completeOAuth } from "@/lib/oauth";
import { readConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The one redirect URI every OAuth provider is registered with. Validates the
 *  state nonce, exchanges the code for tokens, and bounces back to Pipeline —
 *  ?connected=1&source=<id> on success (the connect row runs the first sync), or
 *  ?oauth_error=…&source=<id> so the failure shows on the row, never silently. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (query: string) => NextResponse.redirect(new URL(`/pipeline?${query}`, url.origin));
  if (!getCurrentUser()) {
    return NextResponse.redirect(new URL("/login", url.origin));
  }
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const denied = url.searchParams.get("error");
  // Attribute failures to the in-flight source so the error lands on its row.
  const pendingId = readConfig()?.oauthPending?.instanceId ?? "";
  const err = (message: string) =>
    back(`source=${encodeURIComponent(pendingId)}&oauth_error=${encodeURIComponent(message)}`);
  if (denied) return err(`Provider returned "${denied}" — authorization was not completed.`);
  if (!code) return err("Provider sent no authorization code.");
  try {
    const { instanceId } = await completeOAuth(code, state);
    return back(`source=${encodeURIComponent(instanceId)}&connected=1`);
  } catch (e) {
    return err((e as Error).message);
  }
}

import { cookies } from "next/headers";
import { readConfig, sessionSecretFor } from "./config";
import { SESSION_TTL_MS, signSession, verifySession } from "./auth";

export const SESSION_COOKIE = "agentqs_session";

/**
 * Reads the signed session cookie and returns the logged-in user, or null.
 * Server-only (uses next/headers + fs via readConfig).
 */
export function getCurrentUser(): { username: string } | null {
  const cfg = readConfig();
  if (!cfg) return null;
  const token = cookies().get(SESSION_COOKIE)?.value;
  const payload = verifySession(token, sessionSecretFor(cfg));
  if (!payload) return null;
  return { username: payload.u };
}

/** Issues a fresh signed-session cookie. Route-handler / server-action only.
 * secure:false so it works over plain http locally and in Docker. */
export function setSessionCookie(username: string, secret: string): void {
  const token = signSession(
    { u: username, exp: Date.now() + SESSION_TTL_MS },
    secret,
  );
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(): void {
  cookies().set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 0,
  });
}

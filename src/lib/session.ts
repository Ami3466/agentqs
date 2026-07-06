import { cookies, headers } from "next/headers";
import crypto from "crypto";
import { readConfig, sessionSecretFor } from "./config";
import { SESSION_TTL_MS, signSession, verifySession } from "./auth";

export const SESSION_COOKIE = "agentqs_session";

/** Constant-time compare of the presented bearer against the saved API key. */
function apiKeyMatches(presented: string, saved: string): boolean {
  if (!presented || !saved) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(saved);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Reads the signed session cookie — OR an `Authorization: Bearer <apiKey>` header
 * matching the generated API key — and returns the logged-in user, or null. The
 * bearer path is what makes the curl/CLI/MCP snippets in Connect actually work
 * against a headless instance. Server-only (uses next/headers + fs via readConfig).
 */
export function getCurrentUser(): { username: string } | null {
  const cfg = readConfig();
  if (!cfg) return null;

  const token = cookies().get(SESSION_COOKIE)?.value;
  const payload = verifySession(token, sessionSecretFor(cfg));
  if (payload) return { username: payload.u };

  const auth = headers().get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (cfg.apiKey && apiKeyMatches(bearer, cfg.apiKey)) {
    return { username: cfg.username };
  }
  return null;
}

/**
 * Cookie-only user — ignores the bearer path. Used to gate actions a leaked API
 * key must never perform (rotating/revoking the key itself).
 */
export function getSessionUser(): { username: string } | null {
  const cfg = readConfig();
  if (!cfg) return null;
  const payload = verifySession(cookies().get(SESSION_COOKIE)?.value, sessionSecretFor(cfg));
  return payload ? { username: payload.u } : null;
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

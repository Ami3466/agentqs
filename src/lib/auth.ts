import crypto from "crypto";

/**
 * Password + signed-session primitives built only on Node's crypto module —
 * no external auth dependency.
 */

// ---- password hashing (scrypt) --------------------------------------------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = (stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(password, salt, 64);
  return (
    expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  );
}

// ---- signed session token (HMAC-SHA256) -----------------------------------

export interface SessionPayload {
  u: string; // username
  exp: number; // epoch ms expiry
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(
  token: string | undefined,
  secret: string,
): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as SessionPayload;
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function newSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

import crypto from "crypto";
import { hashPassword, newSecret } from "./auth";
import { readConfig, writeConfig } from "./config";
import { addressOf, mailConfigured, mailStatus, sendMail, type SendMailOpts } from "./mail";

/**
 * PASSWORD RECOVERY — the one brain. `/api/reset`, the /reset page and
 * `agentqs password --set` are thin faces over this file.
 *
 * Single-user instance: there is exactly one `username` + `passwordHash` on
 * config, so a reset token lives on config too (`passwordReset`), one at a time.
 * Only the SHA-256 of the emailed token is stored — reading config.json never
 * yields a usable link. Nothing here touches the record.
 */

/** The exact text a reset request fails with when no mail transport is set up.
 *  The user asked for this wording; reset-test asserts it verbatim. */
export const RESET_NO_MAIL =
  "Password reset needs email, and no SMTP or Gmail account is set up. Add one in Settings → Channels → Email, or reset from the machine with: agentqs password --set";

export const RESET_TTL_MS = 30 * 60 * 1000;
/** One token per minute, so the endpoint cannot be used to spam the mailbox. */
export const RESET_THROTTLE_MS = 60 * 1000;
/** Same floor as /api/setup and /api/settings. */
export const MIN_PASSWORD = 6;

const BAD_LINK = "This reset link is not valid, or was already used. Request a new one.";

function hashToken(token: string): Buffer {
  return crypto.createHash("sha256").update(token, "utf8").digest();
}

function checkPassword(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
  }
}

/** Where the link goes: the username when it is an email (signup takes either),
 *  else the mailbox the instance sends from — on a single-user box that is the owner. */
function resetRecipient(username: string): string {
  return addressOf(username) || addressOf(mailStatus().from);
}

/**
 * Mint a token, store its hash, email the link. `origin` is the address the
 * browser reached us on. It comes from request headers, which a caller can forge,
 * so `AGENTQS_PUBLIC_URL` wins when set — a forged Host must not be able to point
 * the emailed link at someone else's server.
 */
export async function requestPasswordReset(
  username: string,
  origin: string,
  opts: SendMailOpts & { now?: number } = {},
): Promise<{ ok: true; sentTo: string }> {
  const cfg = readConfig();
  if (!cfg) throw new Error("Not set up yet.");
  if (!mailConfigured(cfg)) throw new Error(RESET_NO_MAIL);
  // Case-insensitive, like /api/login.
  if (!username?.trim() || username.trim().toLowerCase() !== cfg.username.toLowerCase()) {
    throw new Error("That is not the account on this instance.");
  }
  const now = opts.now ?? Date.now();
  const last = Date.parse(cfg.passwordReset?.sentAt ?? "");
  if (Number.isFinite(last) && now - last < RESET_THROTTLE_MS) {
    throw new Error("A reset link was just sent — check the inbox, or try again in a minute.");
  }
  const to = resetRecipient(cfg.username);
  if (!to) {
    throw new Error(
      "No address to send the link to — the username is not an email and the mail From is blank. Set a From address in Settings → Channels → Email, or reset from the machine with: agentqs password --set",
    );
  }
  const base = (process.env.AGENTQS_PUBLIC_URL || origin || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("Could not work out this instance's address for the link.");

  const token = crypto.randomBytes(32).toString("hex");
  cfg.passwordReset = {
    hash: hashToken(token).toString("hex"),
    expiresAt: new Date(now + RESET_TTL_MS).toISOString(),
    sentAt: new Date(now).toISOString(),
  };
  writeConfig(cfg);

  try {
    await sendMail(
      to,
      "Reset your agentqs password",
      [
        "Someone asked to reset the password on your agentqs instance.",
        "",
        `${base}/reset?token=${token}`,
        "",
        "The link works once and expires in 30 minutes.",
        "If this was not you, ignore this message — nothing has changed.",
      ].join("\n"),
      opts,
    );
  } catch (err) {
    // Nothing was delivered, so the token is dead weight and the throttle would
    // only block the retry. Re-read: the send awaited, config may have moved on.
    const latest = readConfig();
    if (latest?.passwordReset?.hash === cfg.passwordReset.hash) {
      delete latest.passwordReset;
      writeConfig(latest);
    }
    throw err;
  }
  return { ok: true, sentTo: maskAddress(to) };
}

/** `a***@example.com` — enough to know which inbox to open; the route is
 *  unauthenticated, so the full address is not handed out. */
function maskAddress(addr: string): string {
  const [local, domain] = addr.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Finish a reset. The token is single-use: it is cleared in the same write that
 * changes the password. A too-short password does NOT burn the token.
 */
export function completePasswordReset(token: string, password: string, opts: { now?: number } = {}): { ok: true } {
  const cfg = readConfig();
  if (!cfg) throw new Error("Not set up yet.");
  const pr = cfg.passwordReset;
  if (!pr?.hash || typeof token !== "string" || !token) throw new Error(BAD_LINK);
  // Constant-time, like verifyPassword and the bearer check in session.ts.
  const expected = Buffer.from(pr.hash, "hex");
  const actual = hashToken(token);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new Error(BAD_LINK);
  const expires = Date.parse(pr.expiresAt);
  if (!Number.isFinite(expires) || expires <= (opts.now ?? Date.now())) {
    delete cfg.passwordReset;
    writeConfig(cfg);
    throw new Error("This reset link has expired. Request a new one.");
  }
  checkPassword(password);
  cfg.passwordHash = hashPassword(password);
  delete cfg.passwordReset;
  // Rotate the signing secret so every session minted before the reset dies —
  // including one an attacker already holds. NOTE: `sessionSecretFor()` prefers
  // process.env.SESSION_SECRET, so where that env var is set this rotation is
  // deliberately a no-op: the operator pinned the secret and owns rotating it.
  cfg.sessionSecret = newSecret();
  writeConfig(cfg);
  return { ok: true };
}

/** The `agentqs password --set` escape hatch: whoever can run the CLI already
 *  owns config.json, so no token. Same rotation as a reset, any pending link dies. */
export function setPassword(password: string): { ok: true; username: string } {
  const cfg = readConfig();
  if (!cfg) throw new Error("Not set up yet — open the app and create the account first.");
  checkPassword(password);
  cfg.passwordHash = hashPassword(password);
  delete cfg.passwordReset;
  cfg.sessionSecret = newSecret(); // no-op under SESSION_SECRET — see completePasswordReset
  writeConfig(cfg);
  return { ok: true, username: cfg.username };
}

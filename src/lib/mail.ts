import crypto from "crypto";
import { readConfig, writeConfig, type AppConfig, type EmailConfig } from "./config";
import { GMAIL_SEND_ID, SCOPE_GMAIL_READ, SCOPE_GMAIL_SEND } from "./importers/gmail-send";
import type { FetchLike } from "./importers/plugin";
import { beginOAuth, freshOAuthToken, readOAuthApp, saveOAuthApp } from "./oauth";
import { smtpSend, type SmtpSend } from "./mail/smtp";
import type { ConnectionOptions } from "tls";

/**
 * THE ONE PLACE THAT SENDS AN EMAIL.
 *
 * Two transports, one at a time (`config.email.transport`):
 *   smtp  → src/lib/mail/smtp.ts. Send-only, by design: SMTP cannot read a reply.
 *   gmail → the Gmail API on the `gmail_send` OAuth grant. Returns Google's
 *           `threadId`, and can ALSO read replies when `gmail.readonly` was granted
 *           — `canReceive` is that fact, nothing else is.
 *
 * Everything that mails you (notifications, the email channel, password reset) is
 * a thin face over `sendMail`. Mail never touches the record, so nothing in here
 * lands, patches or rebuilds anything.
 */

export type MailTransport = "smtp" | "gmail";

/** The exact text `sendMail` fails with when no transport is set up. Callers show
 *  it as is, and mail-test asserts it verbatim — keep the two in step. */
export const MAIL_NOT_CONFIGURED =
  "Email is not set up — add SMTP or a Google account in Settings → Channels → Email.";

export const DEFAULT_GMAIL_API_BASE = "https://gmail.googleapis.com";

export interface MailStatus {
  transport: MailTransport | null;
  from: string;
  ready: boolean;
  /** Why it is not ready — or, when it is, the one thing still worth knowing. */
  reason: string;
  /** Replies can be read back: gmail transport AND `gmail.readonly` granted. */
  canReceive: boolean;
  /** A Google app key is already saved (Calendar/Gmail) — Authorize needs no pasting. */
  googleApp: boolean;
  /** The `gmail_send` grant holds a token. */
  authorized: boolean;
  /** Outcome of the last `mail test`, so the card still shows it after a reload. */
  lastTest: EmailConfig["lastTest"] | null;
}

export interface SendMailOpts {
  fetchImpl?: FetchLike;
  /** Swap the SMTP client (a later phase's test that is not about SMTP). */
  smtpFactory?: SmtpSend;
  /** Extra TLS options for the SMTP connection (a test's self-signed CA). */
  smtpTls?: ConnectionOptions;
  /** Gmail API base — a loopback stub in tests. Env: GMAIL_API_BASE. */
  gmailApiBase?: string;
}

/** The bare address out of `a@b.c` or `Name <a@b.c>`; "" when it is not one. */
export function addressOf(s: string | undefined): string {
  const v = (s ?? "").trim();
  const m = /<([^<>]+)>\s*$/.exec(v);
  const addr = (m ? m[1] : v).trim();
  return /^[^\s@<>"]+@[^\s@<>"]+$/.test(addr) ? addr : "";
}

function grantScopes(cfg: AppConfig | null): string[] {
  return (cfg?.sourceOAuth?.[GMAIL_SEND_ID]?.scopes ?? "").split(/\s+/).filter(Boolean);
}

function statusOf(cfg: AppConfig | null): MailStatus {
  const e = cfg?.email;
  const grant = cfg?.sourceOAuth?.[GMAIL_SEND_ID];
  const authorized = Boolean(grant?.accessToken || grant?.refreshToken);
  const base = {
    googleApp: Boolean(readOAuthApp(cfg, "gcal") ?? readOAuthApp(cfg, GMAIL_SEND_ID)),
    authorized,
    lastTest: e?.lastTest ?? null,
    canReceive: false,
  };
  if (e?.transport === "smtp") {
    const from = addressOf(e.from) ? e.from!.trim() : addressOf(e.smtpUser);
    let reason = "";
    if (!e.smtpHost?.trim()) reason = "SMTP needs a host.";
    else if (!from) reason = "SMTP needs a From address (the username is not an email address).";
    return { ...base, transport: "smtp", from, ready: !reason, reason };
  }
  if (e?.transport === "gmail") {
    const scopes = grantScopes(cfg);
    const from = addressOf(e.from) ? e.from!.trim() : "";
    if (!authorized) {
      return { ...base, transport: "gmail", from, ready: false, reason: "Google is not authorized for sending yet — press Authorize." };
    }
    // A grant with no recorded scopes predates scope tracking; trust it and let Google say no.
    if (scopes.length && !scopes.includes(SCOPE_GMAIL_SEND)) {
      return { ...base, transport: "gmail", from, ready: false, reason: "Google did not grant gmail.send — authorize again and leave it ticked." };
    }
    const canReceive = scopes.includes(SCOPE_GMAIL_READ);
    const reason = e.captureReplies && !canReceive ? "Replies need read access — authorize again to grant it." : "";
    return { ...base, transport: "gmail", from, ready: true, reason, canReceive };
  }
  return { ...base, transport: null, from: "", ready: false, reason: MAIL_NOT_CONFIGURED };
}

export function mailConfigured(cfg: AppConfig | null = readConfig()): boolean {
  return statusOf(cfg ?? null).ready;
}

export function mailStatus(): MailStatus {
  return statusOf(readConfig());
}

// ---- the message ----

/** RFC 2047 encoded-word for a header that is not plain ASCII. */
function encodeHeader(s: string): string {
  const v = s.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

const QP_LINE = 75; // + the soft break's "=" makes the 76 the RFC allows
const QP_SAFE_WS = QP_LINE - 4; // room for the whitespace itself and the longest token (=XX) after it

/** Quoted-printable: 7-bit safe on every server, keeps plain text readable on the
 *  wire, and soft-wraps at 76 so a long line can never break the 998-byte limit. */
export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n|\r/g, "\n").split("\n")) {
    const bytes = Buffer.from(line, "utf8");
    let cur = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      // A literal space/tab never sits next to a soft break. RFC 2045 §6.7 allows
      // "word =\r\n" (the "=" ends the line, so the space is not trailing), but that
      // leaves the space one careless decoder away from vanishing and the two words
      // from merging. The next token is at most 3 chars, so whitespace is only literal
      // while one still fits after it (QP_SAFE_WS) — past that it goes out as =20/=09,
      // which nothing can misread.
      const ws = b === 32 || b === 9;
      const plain = (b >= 33 && b <= 126 && b !== 61) || (ws && !last && cur.length <= QP_SAFE_WS);
      const tok = plain ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
      if (cur.length + tok.length > QP_LINE) {
        out.push(`${cur}=`);
        cur = "";
      }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join("\r\n");
}

/** A complete RFC-822 text message, CRLF throughout. `from` may be "" on Gmail —
 *  Google stamps the authorized account. */
export function buildMessage(m: { from: string; to: string; subject: string; text: string; messageId: string }): string {
  const headers = [
    ...(m.from ? [`From: ${m.from.replace(/[\r\n]+/g, " ")}`] : []),
    `To: ${m.to}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${m.messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${quotedPrintable(m.text)}\r\n`;
}

// ---- send ----

export async function sendMail(
  to: string,
  subject: string,
  text: string,
  opts: SendMailOpts = {},
): Promise<{ id: string; threadId?: string }> {
  const cfg = readConfig();
  const st = statusOf(cfg);
  if (!st.ready || !st.transport) throw new Error(st.reason || MAIL_NOT_CONFIGURED);
  const rcpt = addressOf(to);
  if (!rcpt) throw new Error(`"${to}" is not an email address.`);
  const e = cfg!.email!;
  const fromAddr = addressOf(st.from);
  const messageId = `<${crypto.randomBytes(12).toString("hex")}@${fromAddr.split("@")[1] || "agentqs.local"}>`;
  const data = buildMessage({ from: st.from, to: rcpt, subject, text, messageId });

  if (st.transport === "smtp") {
    const port = e.smtpPort || (e.smtpSecure ? 465 : 587);
    await (opts.smtpFactory ?? smtpSend)(
      {
        host: e.smtpHost!.trim(),
        port,
        // 465 is implicit TLS whatever the box says; nothing else speaks it.
        secure: e.smtpSecure ?? port === 465,
        user: e.smtpUser?.trim() || undefined,
        pass: e.smtpPass,
        tls: opts.smtpTls,
      },
      { from: fromAddr, to: rcpt, data },
    );
    return { id: messageId };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = await freshOAuthToken(GMAIL_SEND_ID, cfg, fetchImpl);
  if (!token) throw new Error("Google is not authorized for sending yet — press Authorize.");
  const base = (opts.gmailApiBase || process.env.GMAIL_API_BASE || DEFAULT_GMAIL_API_BASE).replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/gmail/v1/users/me/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(data, "utf8").toString("base64url") }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 300);
    try {
      detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? detail;
    } catch {
      /* not JSON — keep the raw text */
    }
    const hint = res.status === 401 || res.status === 403 ? " — authorize Google again in Settings → Channels → Email." : "";
    throw new Error(`Gmail send → HTTP ${res.status}: ${detail}${hint}`);
  }
  const sent = JSON.parse(body) as { id?: string; threadId?: string };
  return { id: sent.id ?? messageId, threadId: sent.threadId };
}

/** Send a real message and REMEMBER the outcome on config — the card reads it
 *  back from GET /api/mail, so the result outlives the flash that announced it. */
export async function testMail(to: string, opts: SendMailOpts = {}): Promise<{ ok: true; id: string; threadId?: string; to: string }> {
  const note = (ok: boolean, detail: string) => {
    const latest = readConfig();
    if (!latest) return;
    latest.email = { ...(latest.email ?? {}), lastTest: { at: new Date().toISOString(), to, ok, detail } };
    writeConfig(latest);
  };
  try {
    const r = await sendMail(
      to,
      "agentqs test message",
      "This is a test from agentqs.\n\nIf you are reading it, outbound email works.",
      opts,
    );
    note(true, r.threadId ? `sent · thread ${r.threadId}` : "sent");
    return { ok: true, ...r, to };
  } catch (err) {
    note(false, (err as Error).message);
    throw err;
  }
}

// ---- Google connect ----

/**
 * Start the `gmail_send` OAuth dance. `useGoogle` is the one-click path: anyone
 * who connected Calendar or Gmail already has an app key under `oauthApps.google`,
 * so it is COPIED into the `gmail_send` slot and the user only clicks Authorize.
 *
 * WHY A COPY: the alternative is teaching `appKeyOf` (oauth.ts) that one plugin
 * may borrow another provider's key — and every provider rides that function.
 * Two duplicated strings in config are cheaper than a special case there. The
 * price: rotating the Google client secret means updating BOTH entries (re-running
 * this with `useGoogle` does it). The GRANT stays separate either way — sending as
 * you is its own consent, never folded into the Google card (see google.ts).
 */
export function beginMailConnect(
  origin: string,
  opts: { useGoogle?: boolean; clientId?: string; clientSecret?: string; captureReplies?: boolean } = {},
): { authorizeUrl: string; redirectUri: string } {
  const cfg = readConfig();
  if (!cfg) throw new Error("Run setup first.");
  // The scope asked for is a function of this flag (`gmailSendScopes`), so it has
  // to be on disk BEFORE the authorize URL is built.
  // Everything that can refuse goes first: a click that fails must change nothing.
  // EITHER slot, the same two `mailStatus().googleApp` counts: `gmail_send`'s own
  // (a key pasted into the Email card lands there) before the shared Google one. The
  // card hides its Client ID/Secret inputs whenever googleApp is true, so a slot
  // this refused would be a re-authorize with nowhere left to paste.
  // A slot holding the SAME client id as the shared key is the copy described above,
  // so the shared one still wins there — that is what keeps a rotated secret flowing
  // into the copy on the next Authorize.
  const own = opts.useGoogle ? readOAuthApp(cfg, GMAIL_SEND_ID) : undefined;
  const shared = opts.useGoogle ? readOAuthApp(cfg, "gcal") : undefined;
  const google = own && shared && own.clientId === shared.clientId ? shared : (own ?? shared);
  if (opts.useGoogle && !google) {
    throw new Error("No Google app key is saved yet — connect Google in Pipeline first, or paste a Client ID + Secret here.");
  }
  if (typeof opts.captureReplies === "boolean" && Boolean(cfg.email?.captureReplies) !== opts.captureReplies) {
    cfg.email = { ...(cfg.email ?? {}), captureReplies: opts.captureReplies };
    writeConfig(cfg);
  }
  if (google) saveOAuthApp(GMAIL_SEND_ID, google.clientId, google.clientSecret);
  // The TRANSPORT is not touched here. Starting a dance is not finishing one — an
  // abandoned Google tab must not switch off an SMTP setup that works. It flips in
  // `completeOAuth` (oauth.ts), when the grant actually lands.
  return beginOAuth(GMAIL_SEND_ID, opts.clientId ?? "", opts.clientSecret ?? "", origin);
}

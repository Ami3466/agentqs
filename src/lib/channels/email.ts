import crypto from "crypto";
import fs from "fs";
import path from "path";
import { readConfig } from "../config";
import { dataDir } from "../paths";
import { GMAIL_SEND_ID } from "../importers/gmail-send";
import { DEFAULT_GMAIL_API_BASE, addressOf, mailStatus, sendMail, type MailStatus } from "../mail";
import { freshOAuthToken } from "../oauth";
import type { ChannelAdapter, ChannelEnv, ChannelStatus, InboundMessage, PullResult, WebhookVerdict } from "./types";

/**
 * Email adapter — the fourth channel, and the only one with NO webhook.
 *
 * Outbound rides `sendMail` (src/lib/mail.ts), so it works on either transport.
 * Inbound is a POLL of the Gmail API and nothing else: SMTP cannot read a reply
 * (a product decision, not a gap), and there is no inbound host, label or tunnel
 * to set up. The trick that makes one query enough is the TAG — every message this
 * adapter sends ends with a footer carrying `aqs#<token>`, a reply quotes the
 * original, so the token comes back for free and `"aqs#"` finds every reply to
 * every notification.
 *
 * What is accepted as a reply is deliberately narrow, because with AI replies on a
 * captured message is ANSWERED with record-grounded text (the same reason Slack
 * refuses an unsigned request). All four must hold:
 *   • it carries THIS instance's token, not just any `aqs#`;
 *   • it IS a reply (In-Reply-To / References) — our own outgoing mail never is,
 *     which is what keeps a notification from being captured as its own answer;
 *   • it is From an address this channel has mailed (or the account itself);
 *   • Gmail did not file it under Spam or Trash (`in:anywhere` reads those too).
 */

/** The poll has one "conversation": replies. It names the cursor in the ledger. */
export const EMAIL_PULL_TARGET = "replies";

const TAG_PREFIX = "aqs#";
const FOOTER_LEAD = "agentqs -- reply to this and it lands in your record -- ";
const MAX_RECIPIENTS = 200;
const PAGE_LIMIT = 5; // × 100 ids — a 7-day window of replies is a handful, not a crawl

// ---- the tag + who we have mailed ------------------------------------------

interface EmailChannelState {
  tag?: string;
  recipients?: string[];
}

function stateFile(): string {
  return path.join(dataDir(), "email-channel.json");
}

function readState(): EmailChannelState {
  try {
    const v = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as EmailChannelState;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeState(s: EmailChannelState): void {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

/** This instance's reply token — minted once and KEPT. It lives in its own file,
 *  not derived from the session secret, because a password reset rotates that and
 *  every reply to an email already sent would stop matching. */
export function replyTag(): string {
  const s = readState();
  if (s.tag && /^[0-9a-f]{6}$/.test(s.tag)) return s.tag;
  const tag = crypto.randomBytes(3).toString("hex");
  writeState({ ...s, tag });
  return tag;
}

/** The footer every outgoing message ends with. `-- ` (with the space) is the
 *  standard signature delimiter, so most clients grey it out. */
export function replyFooter(): string {
  return `\n\n-- \n${FOOTER_LEAD}${TAG_PREFIX}${replyTag()}`;
}

function rememberRecipient(addr: string): void {
  const a = addr.toLowerCase();
  const s = readState();
  const list = (s.recipients ?? []).filter((r) => r !== a);
  list.push(a);
  writeState({ ...s, recipients: list.slice(-MAX_RECIPIENTS) });
}

/** First line of the body, as a subject. `send()` takes text only — the contract
 *  is channel-agnostic — so the subject is derived, never asked for. */
function subjectOf(text: string): string {
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const s = first.length > 70 ? `${first.slice(0, 69)}…` : first;
  return s ? `agentqs: ${s}` : "agentqs";
}

// ---- quoted text ------------------------------------------------------------

/**
 * Cut a reply down to what the person actually typed: everything above the first
 * line that starts the quoted original.
 *
 * THIS IS A HEURISTIC, NOT A PARSER. There is no standard for how a mail client
 * marks quoted text, so this cuts at the first of: a `>` line, an "On … wrote:"
 * attribution, a `-- ` signature delimiter, Outlook's "-----Original Message-----"
 * / "____" divider, or our own `aqs#` footer. That is good for Gmail, Apple Mail
 * and Outlook in their default top-posting setup. It is NOT exact for every client:
 * a localized attribution ("Am … schrieb:"), one wrapped over three lines, or a
 * bottom-posted reply (typed UNDER the quote) will be cut wrong — the last comes
 * back empty and is skipped rather than captured as garbage.
 */
export function stripQuoted(body: string): string {
  const lines = body.replace(/\r\n|\r/g, "\n").split("\n");
  const cut = lines.findIndex(
    (l, i) =>
      /^>/.test(l) ||
      /^On .* wrote:$/.test(l.trim()) ||
      // Gmail wraps a long attribution: "On <date> Name <addr>" / "wrote:".
      (/^On /.test(l) && /^On .* wrote:$/.test(`${l.trim()} ${(lines[i + 1] ?? "").trim()}`)) ||
      /^-- $/.test(l) ||
      /^-{3,} ?Original Message ?-{3,}$/i.test(l.trim()) ||
      /^_{10,}$/.test(l.trim()) ||
      l.includes(TAG_PREFIX),
  );
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n").trim();
}

// ---- Gmail ------------------------------------------------------------------

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: Array<{ name?: string; value?: string }>;
}

interface GmailMessage {
  id?: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
}

function findPart(p: GmailPart | undefined, mime: string): GmailPart | null {
  if (!p) return null;
  if (p.mimeType === mime && p.body?.data) return p;
  for (const c of p.parts ?? []) {
    const hit = findPart(c, mime);
    if (hit) return hit;
  }
  return null;
}

/** The text a person would read: the text/plain part, else the HTML with its tags
 *  dropped (an HTML-only client), else Gmail's snippet. */
function bodyText(m: GmailMessage): string {
  const decode = (p: GmailPart) => Buffer.from(p.body!.data!, "base64url").toString("utf8");
  const plain = findPart(m.payload, "text/plain");
  if (plain) return decode(plain);
  const html = findPart(m.payload, "text/html");
  if (html) {
    return decode(html)
      // A quote becomes a `>` line: the tag inside it must survive (it is how the
      // reply is recognised) and `stripQuoted` cuts there.
      .replace(/<blockquote[^>]*>/gi, "\n> ")
      .replace(/<(br|\/p|\/div|\/blockquote)\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
  }
  return m.snippet ?? "";
}

function header(m: GmailMessage, name: string): string {
  const h = (m.payload?.headers ?? []).find((x) => (x.name ?? "").toLowerCase() === name);
  return (h?.value ?? "").trim();
}

function status(env: ChannelEnv): MailStatus | null {
  return env.mail === undefined ? mailStatus() : env.mail;
}

/** One authenticated Gmail caller. Errors name the fix, like the Slack one. */
async function gmailCaller(env: ChannelEnv) {
  const fetchImpl = env.fetchImpl ?? fetch;
  const token = await freshOAuthToken(GMAIL_SEND_ID, readConfig(), fetchImpl);
  if (!token) throw new Error("Google is not authorized — press Authorize in Settings → Channels → Email.");
  const base = (env.gmailApiBase || process.env.GMAIL_API_BASE || DEFAULT_GMAIL_API_BASE).replace(/\/+$/, "");
  return async (pathname: string, params: Record<string, string>): Promise<any> => {
    const res = await fetchImpl(`${base}/gmail/v1/users/me/${pathname}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? ' — reading replies needs gmail.readonly: tick "Capture replies" and authorize again in Settings → Channels → Email.'
          : "";
      throw new Error(`Gmail ${pathname.split("/")[0]} → HTTP ${res.status}: ${json?.error?.message ?? res.statusText}${hint}`);
    }
    return json;
  };
}

export const emailAdapter: ChannelAdapter = {
  id: "email",
  label: "Email",
  target: { hint: "Email address", example: "you@example.com" },
  // No webhook: the poll is the ONLY way in, so it does the webhook's whole job.
  pullOnly: true,

  configured(env: ChannelEnv): boolean {
    return Boolean(status(env)?.ready);
  },

  describe(env: ChannelEnv): ChannelStatus {
    const st = status(env);
    const enabled = Boolean(st?.ready);
    return {
      channel: "email",
      label: "Email",
      enabled,
      // For a webhook channel this is "inbound is verified"; here it is the same
      // question asked of a poll — can replies be read back at all?
      verified: Boolean(st?.canReceive),
      reason: !enabled
        ? (st?.reason ?? "Email is not set up.")
        : st?.canReceive
          ? ""
          : st?.transport === "smtp"
            ? "SMTP is send-only — replies are captured on the Gmail transport."
            : st?.reason || 'Send-only — tick "Capture replies" and authorize again to read replies.',
    };
  },

  ingest(): WebhookVerdict {
    return { error: "Email has no webhook; replies arrive on the Gmail poll.", status: 404 };
  },

  async send(env: ChannelEnv, target: string, text: string): Promise<void> {
    const to = addressOf(target);
    if (!to) throw new Error(`"${target}" is not an email address.`);
    await sendMail(to, subjectOf(text), `${text.trimEnd()}${replyFooter()}`, {
      fetchImpl: env.fetchImpl,
      gmailApiBase: env.gmailApiBase,
    });
    // Only an address we have mailed may reply into the record.
    rememberRecipient(to);
  },

  /**
   * Pull replies since the last cursor (a Gmail `internalDate`, epoch ms).
   *
   * The cursor is only STORED by the caller, after the messages are in the record,
   * and any failure in here throws before one is returned — so a failed sweep
   * re-reads its window instead of skipping it.
   */
  async pull({ env, since }): Promise<PullResult> {
    const st = status(env);
    if (st?.transport !== "gmail") throw new Error("Replies are read over the Gmail API — SMTP is send-only.");
    if (!st.canReceive) throw new Error('Gmail is send-only — tick "Capture replies" and authorize again.');
    const call = await gmailCaller(env);

    // NOT `-from:me`: a notification mailed to your own Gmail address is answered
    // FROM that same account, so it would hide exactly the replies this exists for.
    // Our own outgoing mail is told apart below instead (it is never a reply).
    const q = `in:anywhere "${TAG_PREFIX}" newer_than:7d${since ? ` after:${Math.floor(Number(since) / 1000)}` : ""}`;
    const ids: string[] = [];
    let pageToken = "";
    for (let page = 0; page < PAGE_LIMIT; page++) {
      const data = await call("messages", { q, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
      for (const m of data.messages ?? []) if (m?.id) ids.push(String(m.id));
      pageToken = data.nextPageToken ?? "";
      if (!pageToken) break;
    }

    const state = readState();
    const tag = `${TAG_PREFIX}${replyTag()}`;
    const account = addressOf(st.from).toLowerCase();
    const known = new Set([...(state.recipients ?? []), ...(account ? [account] : [])]);

    const raw: GmailMessage[] = [];
    for (const id of ids) raw.push((await call(`messages/${encodeURIComponent(id)}`, { format: "full" })) as GmailMessage);

    const messages: InboundMessage[] = raw
      // `after:` is whole seconds and inclusive-ish, so the cursor message comes back.
      .filter((m) => m.id && (!since || Number(m.internalDate) > Number(since)))
      .filter((m) => !(m.labelIds ?? []).some((l) => l === "SPAM" || l === "TRASH"))
      .filter((m) => header(m, "in-reply-to") !== "" || header(m, "references") !== "")
      .map((m) => ({ m, from: addressOf(header(m, "from")).toLowerCase(), body: bodyText(m) }))
      .filter((x) => x.from && known.has(x.from) && x.body.includes(tag))
      .map((x) => ({ ...x, text: stripQuoted(x.body) }))
      .filter((x) => x.text !== "")
      .sort((a, b) => Number(a.m.internalDate) - Number(b.m.internalDate))
      .map(({ m, from, text }) => ({
        channel: "email",
        // Gmail's message id is stable and per MESSAGE — the one key this capture is
        // ever stored under, so an overlapping window can never double-capture.
        eventId: `gmail:${m.id}`,
        messageId: `gmail:${m.id}`,
        target: from,
        userId: from,
        text,
        at: new Date(Number(m.internalDate)).toISOString(),
      }));

    const seen = raw.map((m) => Number(m.internalDate)).filter((n) => Number.isFinite(n));
    return {
      messages,
      // Unchanged when nothing came back, so the next sweep asks the same question.
      cursor: seen.length ? String(Math.max(...seen, Number(since) || 0)) : since,
    };
  },
};

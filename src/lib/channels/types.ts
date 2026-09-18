/**
 * The channel-agnostic bot adapter contract (Loop 14). A channel is a transport —
 * Telegram (bot token) or Slack (official Web API) — that carries a message in and
 * a reply out. Every adapter is the same three-part shell around the shared brain
 * (`composeReply` in ../reply):
 *
 *   ingest(raw webhook request)  → verify the platform + parse to an InboundMessage
 *   composeReply(message.text)   → memo or grounded chat (shared, not per-channel)
 *   send(target, replyText)      → post the reply back via the platform API
 *
 * So adding a channel is one small file: authenticate + parse + send. The brain,
 * the record, and the grounding are identical across every channel. Pure types +
 * a plain `ChannelEnv` (lifted out of process.env) so adapters stay testable.
 */
import type { MailStatus } from "../mail";

/** A normalized inbound message, whatever platform it arrived on. */
export interface InboundMessage {
  channel: string; // "telegram" | "slack"
  eventId?: string; // platform DELIVERY id — dedupes the platform's own retries
  /**
   * The MESSAGE's own stable identity on the platform — Slack `<channel>:<ts>`,
   * Telegram `<chatId>:<messageId>`. Not the same thing as `eventId`: a delivery id
   * is minted per webhook POST, so the same message arriving by webhook and then by
   * poll carried two different ids and was captured TWICE (confirmed on the live
   * record — every Slack message existed as both a `slack:<channel>:<ts>` item and a
   * random UUID one). This is the id the inbox capture is stored under, from BOTH
   * paths, so a message that arrives both ways lands exactly once.
   */
  messageId?: string;
  target: string; // where the reply goes (chat id / channel id)
  userId: string; // sender id (provenance / logging)
  text: string; // the message text
  /** When the platform says it was SENT (ISO). A pulled backlog is history: dating
   *  it "now" would file a week-old entry under today and, once structured, write
   *  the daily row on the wrong day. Absent for a live push (now IS the send time). */
  at?: string;
}

/** The verdict of parsing+verifying one raw webhook request. Exactly one of
 *  `challenge` / `ignore` / `message` / `error` is the meaningful field. */
export interface WebhookVerdict {
  challenge?: string; // platform handshake to echo back verbatim (Slack url_verification)
  ignore?: string; // parsed fine but nothing to answer (bot's own msg, non-text event) — reason
  message?: InboundMessage; // a real inbound message to reply to
  error?: string; // verification/parse failure — the caller returns 4xx
  status?: number; // suggested HTTP status for an error (default 400)
}

/** Everything an adapter needs, lifted out of process.env so it's a pure input.
 *  API bases are overridable purely so the ships-when test can point the outbound
 *  call at a local capture server (same trick the importer tests use for fetch). */
export interface ChannelEnv {
  // Telegram
  telegramBotToken?: string; // TELEGRAM_BOT_TOKEN
  telegramWebhookSecret?: string; // TELEGRAM_WEBHOOK_SECRET (required — inbound refused without it)
  telegramApiBase?: string; // default https://api.telegram.org
  // Slack
  slackBotToken?: string; // SLACK_BOT_TOKEN (xoxb-…)
  slackSigningSecret?: string; // SLACK_SIGNING_SECRET (required — inbound refused without it)
  slackApiBase?: string; // default https://slack.com/api
  /** Channel to PULL history from (name like "daily-log", or a C…/G… id). Unset
   *  → Slack is push-only. */
  slackPullChannel?: string;
  // Email — no token of its own: it rides the mail transport (src/lib/mail.ts).
  /** The transport's status. `null` = none on this side (the env-only view);
   *  left undefined, the adapter asks `mailStatus()` itself. */
  mail?: MailStatus | null;
  gmailApiBase?: string; // default https://gmail.googleapis.com
  fetchImpl?: typeof fetch; // injectable for tests
}

/** One pull of a channel's history. `cursor` is stored verbatim and handed back as
 *  `since` next time — only advanced when the pull succeeded, so a failed sweep
 *  re-reads rather than skipping messages. */
export interface PullResult {
  messages: InboundMessage[];
  cursor: string;
}

/** One conversation the bot can see, with when it last had traffic — the answer to
 *  "where did my messages actually go?". */
export interface ChannelConversation {
  id: string;
  name: string; // channel name, or the DM's user id
  kind: "public" | "private" | "dm" | "group";
  member: boolean; // is the bot in it? (it can only read where it is)
  lastMessageAt: string | null; // ISO, null when empty or unreadable
}

export interface ChannelStatus {
  channel: string;
  label: string;
  enabled: boolean; // is the bot token configured?
  verified: boolean; // is request verification (secret/signature) configured?
  reason: string; // why it's disabled (empty when enabled)
}

/** What a channel's outbound `target` is, in the user's words — every picker (rules,
 *  notifications, CLI help) reads this, so a new channel never needs a UI edit. */
export interface ChannelTarget {
  hint: string; // "Slack channel/DM id (C0…/U0…)"
  example: string; // placeholder: "C0123456789"
}

/** A channel as a picker sees it. */
export interface ChannelOption extends ChannelTarget {
  id: string;
  label: string;
}

export interface ChannelAdapter {
  id: string;
  label: string;
  target: ChannelTarget;
  /** No webhook at all (email): the poll is the ONLY way a message arrives, so it
   *  does the webhook's whole job — `landCapture` per message (auto-structure
   *  included) and the AI reply. A channel with a webhook leaves this unset: its
   *  poll is a safety net that only collects. */
  pullOnly?: boolean;
  /** Capability probe for the UI/CLI — is this channel wired up? */
  describe(env: ChannelEnv): ChannelStatus;
  /** True when the outbound token is set (so the bot can reply). */
  configured(env: ChannelEnv): boolean;
  /** Verify the request came from the platform and parse it to a verdict. Pure —
   *  no network, no fs — so routing/verification is unit-testable on its own. */
  ingest(args: { env: ChannelEnv; headers: Headers; rawBody: string }): WebhookVerdict;
  /** Post a reply back out via the platform's official API. */
  send(env: ChannelEnv, target: string, text: string): Promise<void>;
  /**
   * PULL new messages from a channel, oldest-first, instead of waiting to be
   * pushed. The webhook is the live path; this is the one that still works when
   * the platform has stopped calling (a disabled subscription, a lapsed tunnel, a
   * host that was down) — it asks, so a gap self-heals on the next sweep instead
   * of being lost forever.
   *
   * `since` is the adapter's own opaque cursor from the previous pull ("" = start
   * from the platform's default window). Adapters without a history API omit this
   * and simply aren't pullable.
   */
  pull?(args: { env: ChannelEnv; channel: string; since: string }): Promise<PullResult>;
  /**
   * Every conversation the bot can see, newest traffic first. This is the tool for
   * "I logged for a week and nothing arrived": the messages are usually in a
   * conversation nobody pointed the poll at, and guessing costs more than asking.
   */
  conversations?(env: ChannelEnv): Promise<ChannelConversation[]>;
}

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

/** A normalized inbound message, whatever platform it arrived on. */
export interface InboundMessage {
  channel: string; // "telegram" | "slack"
  target: string; // where the reply goes (chat id / channel id)
  userId: string; // sender id (provenance / logging)
  text: string; // the message text
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
  telegramWebhookSecret?: string; // TELEGRAM_WEBHOOK_SECRET (optional shared secret)
  telegramApiBase?: string; // default https://api.telegram.org
  // Slack
  slackBotToken?: string; // SLACK_BOT_TOKEN (xoxb-…)
  slackSigningSecret?: string; // SLACK_SIGNING_SECRET (optional request signing)
  slackApiBase?: string; // default https://slack.com/api
  fetchImpl?: typeof fetch; // injectable for tests
}

export interface ChannelStatus {
  channel: string;
  label: string;
  enabled: boolean; // is the bot token configured?
  verified: boolean; // is request verification (secret/signature) configured?
  reason: string; // why it's disabled (empty when enabled)
}

export interface ChannelAdapter {
  id: string;
  label: string;
  /** Capability probe for the UI/CLI — is this channel wired up? */
  describe(env: ChannelEnv): ChannelStatus;
  /** True when the outbound token is set (so the bot can reply). */
  configured(env: ChannelEnv): boolean;
  /** Verify the request came from the platform and parse it to a verdict. Pure —
   *  no network, no fs — so routing/verification is unit-testable on its own. */
  ingest(args: { env: ChannelEnv; headers: Headers; rawBody: string }): WebhookVerdict;
  /** Post a reply back out via the platform's official API. */
  send(env: ChannelEnv, target: string, text: string): Promise<void>;
}

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
  eventId?: string; // platform delivery id for retry de-dupe
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
  telegramWebhookSecret?: string; // TELEGRAM_WEBHOOK_SECRET (required — inbound refused without it)
  telegramApiBase?: string; // default https://api.telegram.org
  // Slack
  slackBotToken?: string; // SLACK_BOT_TOKEN (xoxb-…)
  slackSigningSecret?: string; // SLACK_SIGNING_SECRET (required — inbound refused without it)
  slackApiBase?: string; // default https://slack.com/api
  /** Channel to PULL history from (name like "daily-log", or a C…/G… id). Unset
   *  → Slack is push-only. */
  slackPullChannel?: string;
  fetchImpl?: typeof fetch; // injectable for tests
}

/** One pull of a channel's history. `cursor` is stored verbatim and handed back as
 *  `since` next time — only advanced when the pull succeeded, so a failed sweep
 *  re-reads rather than skipping messages. */
export interface PullResult {
  messages: InboundMessage[];
  cursor: string;
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
}

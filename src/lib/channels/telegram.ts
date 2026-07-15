import type { ChannelAdapter, ChannelEnv, ChannelStatus, WebhookVerdict } from "./types";

/**
 * Telegram bot adapter (Loop 14). Inbound: Telegram delivers each update as a JSON
 * webhook POST; we pull the text + chat id off `update.message`. Outbound: one POST
 * to the Bot API `sendMessage`. Auth is the bot token (in the URL) plus a shared
 * secret Telegram echoes in the `X-Telegram-Bot-Api-Secret-Token` header (set when
 * you register the webhook). The secret is REQUIRED: a reply grounds an answer from
 * the record and sends it to a caller-chosen chat id, so an update we cannot verify
 * could be forged into leaking the record — an unverifiable webhook is refused.
 *
 * Register the webhook once (points Telegram at this route):
 *   curl "https://api.telegram.org/bot<token>/setWebhook?url=<host>/api/channels/telegram&secret_token=<secret>"
 */

const DEFAULT_API_BASE = "https://api.telegram.org";
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

function apiBase(env: ChannelEnv): string {
  return (env.telegramApiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
}

export const telegramAdapter: ChannelAdapter = {
  id: "telegram",
  label: "Telegram",

  configured(env: ChannelEnv): boolean {
    return Boolean(env.telegramBotToken && env.telegramBotToken.trim());
  },

  describe(env: ChannelEnv): ChannelStatus {
    const enabled = this.configured(env);
    const verified = Boolean(env.telegramWebhookSecret && env.telegramWebhookSecret.trim());
    return {
      channel: "telegram",
      label: "Telegram",
      enabled,
      verified,
      reason: !enabled
        ? "Set TELEGRAM_BOT_TOKEN to enable the Telegram bot."
        : !verified
          ? "Set TELEGRAM_WEBHOOK_SECRET and register the webhook with it — inbound updates are refused until then."
          : "",
    };
  },

  ingest({ env, headers, rawBody }): WebhookVerdict {
    if (!this.configured(env)) {
      return { error: "Telegram bot is not configured (TELEGRAM_BOT_TOKEN).", status: 503 };
    }
    // Require the shared secret: a reply grounds an answer from the record and sends
    // it to a caller-chosen chat id, so an unverifiable update is refused, never
    // answered. Telegram echoes the secret in this header when the webhook was
    // registered with secret_token=… .
    const secret = env.telegramWebhookSecret?.trim();
    if (!secret) {
      return {
        error:
          "Telegram webhook secret not set (TELEGRAM_WEBHOOK_SECRET). Register the webhook with the same " +
          "secret_token — an unverified webhook is refused so the record can't be leaked to a forged caller.",
        status: 503,
      };
    }
    if (headers.get(SECRET_HEADER) !== secret) {
      return { error: "Bad Telegram webhook secret.", status: 401 };
    }

    let update: any;
    try {
      update = JSON.parse(rawBody || "{}");
    } catch {
      return { error: "Invalid Telegram update JSON.", status: 400 };
    }

    // Handle a normal message or an edited message; ignore everything else.
    const msg = update?.message ?? update?.edited_message ?? update?.channel_post;
    if (!msg) return { ignore: "no message in update" };
    if (msg.from?.is_bot) return { ignore: "message is from a bot" };
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    const chatId = msg.chat?.id;
    if (!text || chatId === undefined || chatId === null) {
      return { ignore: "update has no text/chat" };
    }

    return {
      message: {
        channel: "telegram",
        eventId: update?.update_id == null ? undefined : `telegram:${String(update.update_id)}`,
        target: String(chatId),
        userId: String(msg.from?.id ?? chatId),
        text,
      },
    };
  },

  async send(env: ChannelEnv, target: string, text: string): Promise<void> {
    const token = env.telegramBotToken!.trim();
    const fetchImpl = env.fetchImpl ?? fetch;
    const res = await fetchImpl(`${apiBase(env)}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: target, text, disable_web_page_preview: true }),
    });
    const body = await res.text();
    let json: any = {};
    try {
      json = body ? JSON.parse(body) : {};
    } catch {
      /* surfaced below */
    }
    if (!res.ok || json?.ok === false) {
      const msg = json?.description || body || res.statusText;
      throw new Error(`Telegram sendMessage failed: ${res.status} ${msg}`);
    }
  },
};

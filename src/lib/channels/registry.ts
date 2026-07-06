import type { ChannelAdapter, ChannelEnv } from "./types";
import { telegramAdapter } from "./telegram";
import { slackAdapter } from "./slack";
import { readConfig } from "../config";

/**
 * The channel registry — one entry per transport. The webhook route resolves an
 * adapter by its `[channel]` path segment; adding a channel is dropping one file
 * here. The brain (`composeReply`) is shared, so every adapter is a thin shell.
 */
export const CHANNELS: ChannelAdapter[] = [telegramAdapter, slackAdapter];

export function getChannelAdapter(id: string | null | undefined): ChannelAdapter | null {
  const key = (id ?? "").toLowerCase();
  return CHANNELS.find((c) => c.id === key) ?? null;
}

/** Build the ChannelEnv from the Settings links, falling back to process.env. API
 *  bases are overridable so a test (or a proxy) can point the outbound call
 *  somewhere else; everything else is the bot's real credentials. */
export function channelEnv(): ChannelEnv {
  const ch = readConfig()?.channels;
  return {
    telegramBotToken: ch?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "",
    telegramWebhookSecret: ch?.telegramWebhookSecret || process.env.TELEGRAM_WEBHOOK_SECRET || "",
    telegramApiBase: process.env.TELEGRAM_API_BASE || "",
    slackBotToken: ch?.slackBotToken || process.env.SLACK_BOT_TOKEN || "",
    slackSigningSecret: ch?.slackSigningSecret || process.env.SLACK_SIGNING_SECRET || "",
    slackApiBase: process.env.SLACK_API_BASE || "",
  };
}

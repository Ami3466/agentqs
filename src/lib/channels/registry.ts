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

/** Where a channel's working credential came from. `only` builds the env from ONE
 *  side so the answer can be derived instead of assumed. */
type EnvSide = "config" | "env";

/** Build the ChannelEnv from the Settings links, falling back to process.env. API
 *  bases are overridable so a test (or a proxy) can point the outbound call
 *  somewhere else; everything else is the bot's real credentials. */
export function channelEnv(only?: EnvSide): ChannelEnv {
  const ch = only === "env" ? undefined : readConfig()?.channels;
  const env = (key: string): string => (only === "config" ? "" : process.env[key] || "");
  return {
    telegramBotToken: ch?.telegramBotToken || env("TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecret: ch?.telegramWebhookSecret || env("TELEGRAM_WEBHOOK_SECRET"),
    telegramApiBase: process.env.TELEGRAM_API_BASE || "",
    slackBotToken: ch?.slackBotToken || env("SLACK_BOT_TOKEN"),
    slackSigningSecret: ch?.slackSigningSecret || env("SLACK_SIGNING_SECRET"),
    slackApiBase: process.env.SLACK_API_BASE || "",
    slackPullChannel: ch?.slackPullChannel || env("SLACK_PULL_CHANNEL"),
  };
}

/**
 * WHERE a channel's working credential actually comes from — "saved" (the user
 * connected it in Settings) or "env" (an environment variable), null when there is
 * none. Asked of the ADAPTER, by building the env from one side at a time, so it
 * stays true for every channel instead of hardcoding one channel's field names.
 *
 * The Pipeline row used to report a flat `connected ? "env" : null`, which was
 * simply wrong for everyone who pasted their bot token into Settings — and
 * "credential: env" sends you looking for a variable that does not exist.
 */
export function channelCredentialOrigin(adapter: ChannelAdapter): "saved" | "env" | null {
  if (adapter.configured(channelEnv("config"))) return "saved";
  if (adapter.configured(channelEnv("env"))) return "env";
  return null;
}

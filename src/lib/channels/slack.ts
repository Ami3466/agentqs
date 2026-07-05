import crypto from "crypto";
import type { ChannelAdapter, ChannelEnv, ChannelStatus, WebhookVerdict } from "./types";

/**
 * Slack adapter (Loop 14) — the official Web API + Events API, same three-part
 * shape as Telegram. Inbound: Slack POSTs Events API callbacks; the first-time
 * `url_verification` handshake is echoed back, and a `message` event yields the
 * text + channel id. Outbound: `chat.postMessage` with the bot token as a bearer.
 * Requests are verified with the Slack signing secret (HMAC of `v0:ts:body`) when
 * one is set, and stale/retried deliveries are dropped so the bot never
 * double-replies.
 */

const DEFAULT_API_BASE = "https://slack.com/api";
const MAX_SKEW_S = 60 * 5; // reject signatures older than 5 minutes (replay guard)

function apiBase(env: ChannelEnv): string {
  return (env.slackApiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
}

/** Constant-time compare of the Slack request signature. Returns false on any
 *  malformed input rather than throwing. */
function validSignature(secret: string, headers: Headers, rawBody: string): boolean {
  const sig = headers.get("x-slack-signature") || "";
  const ts = headers.get("x-slack-request-timestamp") || "";
  if (!sig || !ts || !/^\d+$/.test(ts)) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_S) return false;
  const expected = "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const slackAdapter: ChannelAdapter = {
  id: "slack",
  label: "Slack",

  configured(env: ChannelEnv): boolean {
    return Boolean(env.slackBotToken && env.slackBotToken.trim());
  },

  describe(env: ChannelEnv): ChannelStatus {
    const enabled = this.configured(env);
    const verified = Boolean(env.slackSigningSecret && env.slackSigningSecret.trim());
    return {
      channel: "slack",
      label: "Slack",
      enabled,
      verified,
      reason: enabled ? "" : "Set SLACK_BOT_TOKEN to enable the Slack bot.",
    };
  },

  ingest({ env, headers, rawBody }): WebhookVerdict {
    let payload: any;
    try {
      payload = JSON.parse(rawBody || "{}");
    } catch {
      return { error: "Invalid Slack payload JSON.", status: 400 };
    }

    // The url_verification handshake carries no signature yet — answer it directly.
    if (payload?.type === "url_verification") {
      const challenge = typeof payload.challenge === "string" ? payload.challenge : "";
      return challenge ? { challenge } : { error: "Missing challenge.", status: 400 };
    }

    if (!this.configured(env)) {
      return { error: "Slack bot is not configured (SLACK_BOT_TOKEN).", status: 503 };
    }
    // Verify the request signature when a signing secret is configured.
    const secret = env.slackSigningSecret?.trim();
    if (secret && !validSignature(secret, headers, rawBody)) {
      return { error: "Bad Slack request signature.", status: 401 };
    }

    // Drop Slack's automatic retries so a slow reply never triggers a duplicate.
    if (headers.get("x-slack-retry-num")) return { ignore: "slack retry delivery" };

    if (payload?.type !== "event_callback" || !payload.event) {
      return { ignore: `unhandled slack payload type: ${payload?.type ?? "none"}` };
    }
    const ev = payload.event;
    // Only plain user messages: no bot echoes, no edits/joins/other subtypes.
    if (ev.type !== "message" && ev.type !== "app_mention") return { ignore: `event type ${ev.type}` };
    if (ev.bot_id || ev.subtype) return { ignore: "bot or non-plain message" };
    const text = typeof ev.text === "string" ? ev.text.trim() : "";
    const channel = ev.channel;
    if (!text || !channel) return { ignore: "event has no text/channel" };

    return {
      message: {
        channel: "slack",
        target: String(channel),
        userId: String(ev.user ?? channel),
        text,
      },
    };
  },

  async send(env: ChannelEnv, target: string, text: string): Promise<void> {
    const token = env.slackBotToken!.trim();
    const fetchImpl = env.fetchImpl ?? fetch;
    const res = await fetchImpl(`${apiBase(env)}/chat.postMessage`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: target, text }),
    });
    const body = await res.text();
    let json: any = {};
    try {
      json = body ? JSON.parse(body) : {};
    } catch {
      /* surfaced below */
    }
    if (!res.ok || json?.ok === false) {
      const msg = json?.error || body || res.statusText;
      throw new Error(`Slack chat.postMessage failed: ${res.status} ${msg}`);
    }
  },
};

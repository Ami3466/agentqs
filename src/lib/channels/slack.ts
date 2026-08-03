import crypto from "crypto";
import type { ChannelAdapter, ChannelConversation, ChannelEnv, ChannelStatus, InboundMessage, PullResult, WebhookVerdict } from "./types";

/**
 * Slack adapter (Loop 14) — the official Web API + Events API, same three-part
 * shape as Telegram. Inbound: Slack POSTs Events API callbacks; the first-time
 * `url_verification` handshake is echoed back, and a `message` event yields the
 * text + channel id. Outbound: `chat.postMessage` with the bot token as a bearer.
 * Requests are verified with the Slack signing secret (HMAC of `v0:ts:body`), which
 * is REQUIRED: a reply sends record-grounded text to a caller-chosen channel, so an
 * unsigned request that could be forged is refused. Stale/retried deliveries are
 * dropped so the bot never double-replies.
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


/** One authenticated Slack Web API caller, shared by pull() and conversations().
 *  Slack's error codes are opaque ("not_in_channel", "missing_scope"), so the two
 *  that actually happen are translated into the action that fixes them. */
function slackCaller(env: ChannelEnv, channelHint = "") {
  const token = env.slackBotToken?.trim();
  if (!token) throw new Error("Slack bot token is not set (SLACK_BOT_TOKEN).");
  const fetchImpl = env.fetchImpl ?? fetch;
  return async (method: string, params: Record<string, string>): Promise<any> => {
    const url = `${apiBase(env)}/${method}?${new URLSearchParams(params)}`;
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || json?.ok === false) {
      const err = json?.error || res.statusText;
      const hint =
        err === "not_in_channel"
          ? ` — invite the bot: /invite @agentqs${channelHint ? ` in #${channelHint}` : ""}`
          : err === "missing_scope"
            ? " — the bot token needs channels:history + channels:read (groups:* for a private channel, im:history for DMs); reinstall the app after adding them"
            : "";
      throw new Error(`Slack ${method} failed: ${err}${hint}`);
    }
    return json;
  };
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
      reason: !enabled
        ? "Set SLACK_BOT_TOKEN to enable the Slack bot."
        : !verified
          ? "Set SLACK_SIGNING_SECRET — inbound events are refused until then."
          : "",
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
    // Require a signed request: a reply sends record-grounded text to a caller-chosen
    // channel, so an event we cannot verify is refused, never answered. (The
    // url_verification handshake above is exempt — it only echoes Slack's challenge
    // and never touches the record.)
    const secret = env.slackSigningSecret?.trim();
    if (!secret) {
      return {
        error:
          "Slack signing secret not set (SLACK_SIGNING_SECRET). Set it (Slack app → Basic Information → " +
          "Signing Secret) — an unverified request is refused so the record can't be leaked to a forged caller.",
        status: 503,
      };
    }
    if (!validSignature(secret, headers, rawBody)) {
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
        eventId: payload.event_id
          ? `slack:${String(payload.event_id)}`
          : ev.client_msg_id
            ? `slack:${String(ev.client_msg_id)}`
            : undefined,
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

  /**
   * Pull `#channel` history since the last cursor (a Slack `ts`).
   *
   * This exists because the push path can die silently: Slack disables an Events
   * subscription that fails often enough, and from our side that is indis-
   * tinguishable from "nobody sent anything". A poll asks, so the messages sent
   * while the webhook was down are still there to collect on the next sweep.
   *
   * Two things it must get right, both learned from the GitHub-cron version of
   * this job that ran for 18 days capturing nothing:
   *
   *   • NEVER capture the bot's own posts. That job logged the bot's "Saved to
   *     your inbox…" acks as if they were journal entries, and — worse — moved
   *     the cursor past them, so its own chatter buried the real messages.
   *   • The cursor is only advanced by the CALLER, after the messages are safely
   *     in the record. A pull that lands nothing must not skip anything.
   */
  async conversations(env: ChannelEnv): Promise<ChannelConversation[]> {
    const call = slackCaller(env);
    const out: ChannelConversation[] = [];

    // im/mpim are included on purpose: a DM to the bot is the single most common
    // place "my messages vanished" turns out to mean "they went somewhere the poll
    // was never pointed at" — and that is exactly where a week of this record's logs
    // turned out to be.
    //
    // Each type needs its OWN read scope and Slack fails the WHOLE call if any one
    // is missing, so asking for all four with a token lacking (say) mpim:read
    // returns missing_scope and lists NOTHING — hiding the DMs it could read
    // perfectly well. So each type is probed on its own and the ones that answer are
    // used. Dropping a type we cannot read is fine; silently dropping one we CAN is
    // how the conversation someone is hunting for stays invisible.
    const WANTED = ["public_channel", "private_channel", "im", "mpim"] as const;
    const usable: string[] = [];
    const denied: string[] = [];
    for (const t of WANTED) {
      try {
        await call("conversations.list", { limit: "1", types: t });
        usable.push(t);
      } catch (e) {
        if (!/missing_scope/.test((e as Error).message)) throw e;
        denied.push(t);
      }
    }
    if (!usable.length) {
      throw new Error(
        "Slack conversations.list failed: missing_scope — this token cannot list anything. Add channels:read " +
          "(groups:read for private channels, im:read + mpim:read for DMs) at api.slack.com → OAuth & Permissions, " +
          "then reinstall the app to the workspace.",
      );
    }
    const types = usable.join(",");
    if (denied.length) {
      // Not fatal, but it must be VISIBLE: what we could not enumerate is exactly
      // what a search for missing messages would silently miss.
      out.push({
        id: "",
        name: `⚠ could not list ${denied.join(", ")} — token is missing ${denied.map((d) => `${d.replace("_channel", "s").replace("public", "channel")}:read`).join(", ")}`,
        kind: "public",
        member: false,
        lastMessageAt: null,
      });
    }

    let cursor = "";
    do {
      const page = await call("conversations.list", {
        limit: "200",
        types,
        exclude_archived: "true",
        ...(cursor ? { cursor } : {}),
      });
      for (const c of page.channels ?? []) {
        out.push({
          id: String(c.id),
          name: String(c.name ?? (c.is_im ? `dm:${c.user ?? "?"}` : c.id)),
          kind: c.is_im ? "dm" : c.is_mpim ? "group" : c.is_private ? "private" : "public",
          member: Boolean(c.is_member ?? c.is_im),
          lastMessageAt: null,
        });
      }
      cursor = page.response_metadata?.next_cursor ?? "";
    } while (cursor);

    // Last-activity needs one cheap history call each, so only the ones the bot can
    // actually read, and bounded — this is a diagnostic, not a crawl.
    const readable = out.filter((c) => c.member && c.id).slice(0, 40);
    await Promise.all(
      readable.map(async (c) => {
        try {
          const h = await call("conversations.history", { channel: c.id, limit: "1" });
          const ts = h.messages?.[0]?.ts;
          if (ts) c.lastMessageAt = new Date(Number(ts) * 1000).toISOString();
        } catch {
          /* unreadable (no scope / not in it) — it stays null, which is the answer */
        }
      }),
    );
    return out.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
  },

  async pull({ env, channel, since }): Promise<PullResult> {
    const call = slackCaller(env, channel);

    // A name needs resolving to an id; an id is used as-is. Slack ids are an
    // uppercase C/G/D followed by uppercase alphanumerics — a channel NAME is
    // lowercase and may contain hyphens, so the two never collide. (Matching on a
    // length threshold instead silently turned short DM ids into name lookups.)
    let channelId = channel.replace(/^#/, "").trim();
    if (!/^[CGD][A-Z0-9]{2,}$/.test(channelId)) {
      const wanted = channelId;
      let cursor = "";
      let found = "";
      do {
        const page = await call("conversations.list", {
          limit: "200",
          types: "public_channel,private_channel",
          exclude_archived: "true",
          ...(cursor ? { cursor } : {}),
        });
        found = (page.channels ?? []).find((c: any) => c?.name === wanted)?.id ?? "";
        cursor = page.response_metadata?.next_cursor ?? "";
      } while (!found && cursor);
      if (!found) throw new Error(`Slack channel #${wanted} not found — is the bot a member of it?`);
      channelId = found;
    }

    // Page forward from the cursor so a long gap (the webhook was down for a week)
    // is caught up in one sweep rather than one page per 15 minutes.
    const raw: any[] = [];
    let pageCursor = "";
    for (let page = 0; page < 20; page++) {
      const data = await call("conversations.history", {
        channel: channelId,
        limit: "200",
        ...(since ? { oldest: since } : {}),
        ...(pageCursor ? { cursor: pageCursor } : {}),
      });
      raw.push(...(data.messages ?? []));
      pageCursor = data.response_metadata?.next_cursor ?? "";
      if (!pageCursor) break;
    }

    const messages: InboundMessage[] = raw
      // Plain human messages only. `bot_id`/`app_id` is the guard that keeps our
      // own acks (and every other app's posts) out of the record.
      .filter((m) => m?.type === "message" && !m.subtype && !m.bot_id && !m.app_id)
      .filter((m) => typeof m.text === "string" && m.text.trim() !== "")
      // `oldest` is INCLUSIVE, so the cursor message itself comes back every time.
      .filter((m) => !since || Number(m.ts) > Number(since))
      .sort((a, b) => Number(a.ts) - Number(b.ts))
      .map((m) => ({
        channel: "slack",
        // Slack's ts is unique per channel and stable — the natural dedupe key, so
        // re-pulling an overlapping window can never double-capture.
        eventId: `slack:${channelId}:${m.ts}`,
        target: channelId,
        userId: String(m.user ?? ""),
        text: String(m.text).trim(),
        // Slack's ts IS the send time (epoch seconds.micros) — keep it, so a
        // backfilled week of messages keeps its real days.
        at: new Date(Number(m.ts) * 1000).toISOString(),
      }));

    return {
      messages,
      // Unchanged when nothing new arrived, so the next sweep asks the same question.
      cursor: raw.length ? String(Math.max(...raw.map((m) => Number(m.ts))).toFixed(6)) : since,
    };
  },
};

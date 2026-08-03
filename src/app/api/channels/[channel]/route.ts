import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readConfig } from "@/lib/config";
import { dataDir } from "@/lib/paths";
import { channelEnv, getChannelAdapter } from "@/lib/channels/registry";
import { composeReply } from "@/lib/reply";
import { recordSyncRun } from "@/lib/sync-runs";
import { deliveryVerdict, readChannelDeliveries, recordDelivery } from "@/lib/channel-deliveries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEDUPE_LIMIT = 1000;
/** Slack fails an Events delivery at 3s (and disables the subscription after
 *  repeated failures); Telegram gives ~60s but retries the same way. One budget,
 *  set by the strictest platform, with room for the response to travel. */
const ACK_DEADLINE_MS = 2000;

function seenWebhook(id: string | undefined): boolean {
  if (!id) return false;
  const file = path.join(dataDir(), "channel-webhooks-seen.json");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ids = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as unknown) : [];
    const list = Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : [];
    if (list.includes(id)) return true;
    list.push(id);
    fs.writeFileSync(file, JSON.stringify(list.slice(-DEDUPE_LIMIT)), { mode: 0o600 });
  } catch {
    /* best-effort: webhook processing should continue if de-dupe storage fails */
  }
  return false;
}

/**
 * One channel-agnostic webhook, `/api/channels/<channel>` (telegram · slack). The
 * platform (not a browser) calls POST, so auth is the adapter's own verification —
 * a Telegram shared secret / a Slack request signature — never the session cookie.
 * The flow is identical for every channel:
 *
 *   raw request → adapter.ingest (verify + parse) → composeReply (the shared brain:
 *   `//` memo or grounded chat) → adapter.send (reply back out).
 *
 * GET is the capability probe for the app/CLI (is this bot wired up?) and does use
 * the session cookie.
 */

export async function GET(_req: Request, { params }: { params: { channel: string } }) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const adapter = getChannelAdapter(params.channel);
  if (!adapter) {
    return NextResponse.json({ error: `Unknown channel "${params.channel}".` }, { status: 404 });
  }
  const env = channelEnv();
  const status = adapter.describe(env);
  const deliveries = readChannelDeliveries(adapter.id);
  // The probe answers "is this bot wired up?" — which is only half the question.
  // "Has anything actually ARRIVED, and what happened to it?" is the half that was
  // missing when the bot went quiet, so it ships in the same response.
  return NextResponse.json({
    ...status,
    deliveries,
    verdict: deliveryVerdict(deliveries, { configured: status.enabled, label: status.label }),
  });
}

export async function POST(req: Request, { params }: { params: { channel: string } }) {
  const adapter = getChannelAdapter(params.channel);
  if (!adapter) {
    // A typo'd webhook URL is a real way for a bot to go silent, so it is logged
    // too — under ONE fixed key (never the caller's string, which would let any
    // POST invent ledger entries), with the attempted name as the detail.
    recordDelivery("unknown", "rejected", `POSTed to unknown channel "${String(params.channel).slice(0, 40)}"`);
    return NextResponse.json({ error: `Unknown channel "${params.channel}".` }, { status: 404 });
  }

  const env = channelEnv();
  const rawBody = await req.text();
  const verdict = adapter.ingest({ env, headers: req.headers, rawBody });

  // EVERY outcome is written down, refusals included. A channel that goes quiet is
  // otherwise indistinguishable from one whose every delivery we reject — both just
  // look like an empty inbox, and that ambiguity is what made this bug invisible.
  // Platform handshake (Slack url_verification): echo the challenge, no reply.
  if (verdict.challenge !== undefined) {
    recordDelivery(adapter.id, "ignored", "url_verification handshake");
    return NextResponse.json({ challenge: verdict.challenge });
  }
  if (verdict.error) {
    recordDelivery(adapter.id, "rejected", verdict.error);
    return NextResponse.json({ error: verdict.error }, { status: verdict.status ?? 400 });
  }
  // Parsed fine but nothing to answer (bot echo, non-text event, retry): ack 200 so
  // the platform stops retrying, but do no work.
  if (verdict.ignore || !verdict.message) {
    recordDelivery(adapter.id, "ignored", verdict.ignore ?? "no message");
    return NextResponse.json({ ok: true, ignored: verdict.ignore ?? "no message" });
  }

  const inbound = verdict.message;
  if (seenWebhook(inbound.eventId)) {
    recordDelivery(adapter.id, "duplicate", "platform re-delivered a handled event");
    return NextResponse.json({ ok: true, ignored: "duplicate webhook" });
  }
  // Per-channel reply prefs from Settings: AI vs log-only, the persona, and an
  // optional model override — so a bot can answer as a different skill/model than
  // the app, or just capture everything with zero tokens.
  const prefs = readConfig()?.channels?.replies?.[adapter.id];
  const work = (async () => {
    const reply = await composeReply({
      message: inbound.text,
      channel: adapter.id,
      skill: prefs?.skill,
      ai: prefs?.ai,
      modelOverride:
        prefs?.providerId || prefs?.model
          ? { providerId: prefs.providerId, model: prefs.model }
          : null,
    });
    // Recorded BEFORE the outbound post: the message is already in the record by
    // now, and a reply that fails to send must not read as a lost capture.
    recordDelivery(adapter.id, reply.mode === "memo" ? "captured" : "replied", reply.via);
    await adapter.send(env, inbound.target, reply.text);
    recordSyncRun(adapter.id, true);
    return reply;
  })();

  // THE PLATFORM HANGS UP AT 3s. Slack retries an un-acked event three times and
  // then DISABLES the subscription outright — the bot goes quiet with nothing in
  // our logs to explain it. Composing a reply is not bounded by that budget (an
  // LLM answer takes seconds; capture used to rebuild the whole cache), so the ack
  // is raced against a deadline WELL inside it: a fast reply still returns its full
  // result (what the CLI/tests read), and a slow one finishes in the background
  // while the platform gets its 200 on time. The capture itself is already durable
  // on disk by then — composeReply appends before it answers.
  const timeout = Symbol("deadline");
  const raced = await Promise.race([
    work.catch((e) => e as Error),
    new Promise<typeof timeout>((r) => setTimeout(() => r(timeout), ACK_DEADLINE_MS)),
  ]);

  if (raced === timeout) {
    // Keep owning the outcome after the ack: an unobserved rejection would take
    // the process down, and a silent send failure would be invisible. It lands on
    // the channel's Pipeline row as its last run instead.
    void work.catch((e) => {
      const msg = (e as Error).message || "reply failed";
      console.warn(`agentqs ${adapter.id} reply failed after ack: ${msg}`);
      recordSyncRun(adapter.id, false, msg);
    });
    return NextResponse.json({ ok: true, channel: adapter.id, queued: true });
  }

  if (raced instanceof Error) {
    recordSyncRun(adapter.id, false, raced.message);
    return NextResponse.json({ error: raced.message }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    channel: adapter.id,
    mode: raced.mode,
    grounded: raced.grounded,
    sources: raced.sources,
    via: raced.via,
  });
}

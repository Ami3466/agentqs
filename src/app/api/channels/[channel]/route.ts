import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { channelEnv, getChannelAdapter } from "@/lib/channels/registry";
import { composeReply } from "@/lib/reply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One channel-agnostic webhook, `/api/channels/<channel>` (telegram · slack). The
 * platform (not a browser) calls POST, so auth is the adapter's own verification —
 * a Telegram shared secret / a Slack request signature — never the session cookie.
 * The flow is identical for every channel:
 *
 *   raw request → adapter.ingest (verify + parse) → composeReply (the shared brain:
 *   `>>` memo or grounded chat) → adapter.send (reply back out).
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
  return NextResponse.json(adapter.describe(channelEnv()));
}

export async function POST(req: Request, { params }: { params: { channel: string } }) {
  const adapter = getChannelAdapter(params.channel);
  if (!adapter) {
    return NextResponse.json({ error: `Unknown channel "${params.channel}".` }, { status: 404 });
  }

  const env = channelEnv();
  const rawBody = await req.text();
  const verdict = adapter.ingest({ env, headers: req.headers, rawBody });

  // Platform handshake (Slack url_verification): echo the challenge, no reply.
  if (verdict.challenge !== undefined) {
    return NextResponse.json({ challenge: verdict.challenge });
  }
  if (verdict.error) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status ?? 400 });
  }
  // Parsed fine but nothing to answer (bot echo, non-text event, retry): ack 200 so
  // the platform stops retrying, but do no work.
  if (verdict.ignore || !verdict.message) {
    return NextResponse.json({ ok: true, ignored: verdict.ignore ?? "no message" });
  }

  const inbound = verdict.message;
  const reply = await composeReply({ message: inbound.text, channel: adapter.id });

  try {
    await adapter.send(env, inbound.target, reply.text);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    channel: adapter.id,
    mode: reply.mode,
    grounded: reply.grounded,
    sources: reply.sources,
    via: reply.via,
  });
}

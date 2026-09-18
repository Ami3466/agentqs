import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import * as core from "@/lib/cli-core";
import { requestOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mail state, derived from config every time — the Email card renders from this,
 *  so a test result or a finished Google authorize survives a reload. */
export async function GET() {
  if (!getCurrentUser()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  return NextResponse.json(core.mailStatus());
}

/**
 * {action:"test", to}  → send a real message; the outcome is stored (`lastTest`).
 * {action:"connect", useGoogle?, captureReplies?, clientId?, clientSecret?, origin?}
 *                      → start the `gmail_send` authorize dance, return its URL.
 *
 * Mail never touches the record, so nothing here is a job: a send is one network
 * round trip with its own timeout, not a mutation that can stall the event loop.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    to?: unknown;
    useGoogle?: unknown;
    captureReplies?: unknown;
    clientId?: unknown;
    clientSecret?: unknown;
    origin?: unknown;
  };
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  try {
    if (body.action === "test") {
      if (!str(body.to)) return NextResponse.json({ error: "Missing the address to send to." }, { status: 400 });
      return NextResponse.json({ ...(await core.mailTest(str(body.to))), status: core.mailStatus() });
    }
    if (body.action === "connect") {
      // Same origin rule as /api/oauth/[source]: the browser's own origin first, the
      // PROXY headers second, never req.url (0.0.0.0:3000 inside the container).
      const origin = str(body.origin) || requestOrigin(req);
      return NextResponse.json(
        core.mailConnect(origin, {
          useGoogle: body.useGoogle === true,
          captureReplies: typeof body.captureReplies === "boolean" ? body.captureReplies : undefined,
          clientId: str(body.clientId),
          clientSecret: str(body.clientSecret),
        }),
      );
    }
    return NextResponse.json({ error: 'Unknown action. Use "test" or "connect".' }, { status: 400 });
  } catch (e) {
    // A failed test still changed state (lastTest) — hand the fresh status back with it.
    return NextResponse.json({ error: (e as Error).message, status: core.mailStatus() }, { status: 400 });
  }
}

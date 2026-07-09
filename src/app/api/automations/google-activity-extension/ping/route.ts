import { NextResponse } from "next/server";
import { recordExtensionPing } from "@/lib/ingest-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Extension heartbeat. The background service worker POSTs here on startup and
 *  on a slow alarm; the Data tab reads the stamp (via the status route) to tell
 *  "extension installed and pointed at this server" from "nothing listening",
 *  so Import buttons can say so instead of failing silently. Same origin gate as
 *  the ingest route — the extension can't carry the session cookie. */

function isAllowedOrigin(origin: string | null): boolean {
  return (
    origin !== null &&
    (origin === "https://myactivity.google.com" ||
      origin === "https://timeline.google.com" ||
      origin.startsWith("chrome-extension://"))
  );
}

function cors(origin: string | null): HeadersInit {
  return {
    "access-control-allow-origin": origin && isAllowedOrigin(origin) ? origin : "https://myactivity.google.com",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

export function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: cors(req.headers.get("origin")) });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: cors(origin) });
  }
  const body = (await req.json().catch(() => ({}))) as { version?: unknown };
  recordExtensionPing(body.version);
  return NextResponse.json({ ok: true }, { headers: cors(origin) });
}

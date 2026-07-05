import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { appendInboxItem, readRecord, rebuild } from "@/lib/record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pending bucket, read straight from the record (the source of truth). */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const inbox = readRecord(recordDir()).inbox.filter((i) => i.status === "pending");
  return NextResponse.json({
    pending: inbox.length,
    items: inbox
      .slice(-20)
      .reverse()
      .map((i) => ({ id: i.id, ts: i.ts, source: i.source, kind: i.kind, text: i.text })),
  });
}

/** Log a memo: append verbatim to the inbox, no LLM, then rebuild the cache. */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    text?: string;
    source?: string;
    kind?: string;
  };
  const text = (body.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "A memo needs some text." }, { status: 400 });
  }

  const item = appendInboxItem(
    { text, source: body.source || "memo", kind: body.kind },
    { recordDir: recordDir() },
  );
  rebuild({ recordDir: recordDir() });

  const pending = readRecord(recordDir()).inbox.filter((i) => i.status === "pending").length;
  return NextResponse.json({ ok: true, id: item.id, ts: item.ts, pending });
}

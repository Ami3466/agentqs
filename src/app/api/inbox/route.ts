import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { appendInboxItem, readInboxFromRecord, rebuild } from "@/lib/record";
import { inboxResolve } from "@/lib/cli-core";
import { MAX_INBOX_BYTES } from "@/lib/import-tree";
import { autoStructureNewItem } from "@/lib/structure-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pending bucket, read straight from the record (the source of truth). */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const inbox = readInboxFromRecord(recordDir()).filter((i) => i.status === "pending");
  // Scanner notifications (kind "notification") are data-quality findings — they
  // live on the Data quality tab (GET /api/scan), not in the capture queue, so
  // `pending` counts captures only.
  const notifications = inbox.filter((i) => i.kind === "notification");
  const captures = inbox.filter((i) => i.kind !== "notification");
  const wire = (i: (typeof inbox)[number]) => ({ id: i.id, ts: i.ts, source: i.source, kind: i.kind, text: i.text });
  return NextResponse.json({
    pending: captures.length,
    // The panel renders these in a fixed-height searchable box, so a real backlog
    // is fine to ship - cap only to keep a pathological inbox from megabyte payloads.
    items: captures.slice(-200).reverse().map(wire),
    notifications: notifications.slice(-50).reverse().map(wire),
  });
}

/** Append verbatim to the inbox, no LLM, then rebuild the cache. Handles both a
 * typed memo (`//`) and a dropped/uploaded file (source `drop`, meta.filename). */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    text?: string;
    source?: string;
    kind?: string;
    meta?: unknown;
  };
  const text = (body.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "A memo needs some text." }, { status: 400 });
  }
  // Same guards as importRaw — the web face must not land what the CLI refuses.
  if (text.includes("\u0000")) {
    return NextResponse.json({ error: "That looks like a binary file — no importer claims it, nothing landed." }, { status: 400 });
  }
  if (Buffer.byteLength(text) > MAX_INBOX_BYTES) {
    // This route lands the raw body verbatim (structuring is a separate,
    // optional step) — a megabody would sit in inbox.jsonl forever. Big clean
    // CSVs go through `agentqs import`, which merges without keeping the raw.
    return NextResponse.json(
      { error: "Text too large to land raw — import it with `agentqs import <file>` instead." },
      { status: 400 },
    );
  }

  const item = appendInboxItem(
    { text, source: body.source || "memo", kind: body.kind, meta: body.meta },
    { recordDir: recordDir() },
  );
  // Auto-structure first: when it merges, structurePending rebuilds the cache
  // itself — rebuilding here too would run the whole derivation twice per capture.
  const auto = await autoStructureNewItem(item.id); // Settings: skip the pending queue
  if (!auto || auto.structured === 0) rebuild({ recordDir: recordDir() });

  const pending =
    auto?.pending ?? readInboxFromRecord(recordDir()).filter((i) => i.status === "pending").length;
  return NextResponse.json({
    ok: true,
    id: item.id,
    ts: item.ts,
    pending,
    structured: (auto?.structured ?? 0) > 0,
  });
}

/** Missing id → 404; exists-but-wrong-state → 409 — a state conflict must not
 * read as "that id never existed" to an agent following the docs. */
function resolveError(e: unknown): NextResponse {
  const msg = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: msg }, { status: msg.startsWith("No inbox item") ? 404 : 409 });
}

/** Discard a capture of any status (status → discarded, idempotent), then
 * rebuild. `?id=<id>`. Never touches merged cells — reverting a structured
 * item's data is the Log's Reject. */
export async function DELETE(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Pass an item id to discard." }, { status: 400 });
  }
  try {
    const r = inboxResolve(id, "discard");
    return NextResponse.json({ ok: true, pending: r.pending });
  } catch (e) {
    return resolveError(e);
  }
}

/** Keep a pending capture as a reference memo (status → reference): searchable
 * and recall-able, out of the pending queue. `{id}`. */
export async function PATCH(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: string };
  if (!body.id) {
    return NextResponse.json({ error: "Pass an item id to keep." }, { status: 400 });
  }
  try {
    const r = inboxResolve(body.id, "keep");
    return NextResponse.json({ ok: true, pending: r.pending });
  } catch (e) {
    return resolveError(e);
  }
}

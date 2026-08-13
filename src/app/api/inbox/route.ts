import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { appendInboxItem, landInboxCaptures, readInboxFromRecord } from "@/lib/record";
import { inboxResolve } from "@/lib/cli-core";
import { MAX_INBOX_BYTES } from "@/lib/import-tree";
import { extractPdfText, looksPdf, MAX_PDF_BYTES, PDF_MIME, PDF_SCANNED_NOTE } from "@/lib/pdf-text";
import { autoStructureNewItem } from "@/lib/structure-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** base64 inflates by 4/3; the rest is slack for the JSON envelope + meta. */
const MAX_BASE64_CHARS = Math.ceil(MAX_PDF_BYTES / 3) * 4;
const MAX_BODY_BYTES = MAX_BASE64_CHARS + 64 * 1024;

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

/** Append verbatim to the inbox, no LLM, then land it in the cache. Handles a
 * typed memo (`//`), a dropped/uploaded file (source `drop`, meta.filename), and a
 * dropped PDF (`pdfBase64`) — the browser ships the BYTES and the text layer is
 * extracted HERE, so no PDF parser ever reaches the client bundle. */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // The ceiling has to bite BEFORE req.json() buffers the whole body — a PDF
  // arrives base64 (≈ +33%), and nothing valid on this route is bigger than the
  // largest legal PDF payload plus its JSON wrapper.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Too large to land raw (over ${MAX_PDF_BYTES} bytes) — import it with \`agentqs import <file>\` instead.` },
      { status: 413 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as {
    text?: string;
    pdfBase64?: string;
    source?: string;
    kind?: string;
    meta?: unknown;
  };
  let text = (body.text ?? "").trim();
  let meta = body.meta;

  if (body.pdfBase64) {
    // Cheap length check BEFORE decoding — a client that lied about (or omitted)
    // content-length must still not get 200MB of bytes materialized.
    if (body.pdfBase64.length > MAX_BASE64_CHARS) {
      return NextResponse.json(
        { error: `PDF too large (over ${MAX_PDF_BYTES} bytes) — import it with \`agentqs import <file>\` instead.` },
        { status: 413 },
      );
    }
    const bytes = Buffer.from(body.pdfBase64, "base64");
    if (!bytes.length) {
      return NextResponse.json({ error: "Empty PDF — nothing to extract." }, { status: 400 });
    }
    if (bytes.length > MAX_PDF_BYTES) {
      return NextResponse.json(
        { error: `PDF too large (over ${MAX_PDF_BYTES} bytes) — import it with \`agentqs import <file>\` instead.` },
        { status: 413 },
      );
    }
    if (!looksPdf(bytes)) {
      return NextResponse.json({ error: "That isn't a PDF (no %PDF- header), nothing landed." }, { status: 400 });
    }
    let pdf;
    try {
      pdf = await extractPdfText(bytes);
    } catch (e) {
      // Encrypted / corrupt: the reason travels verbatim to the dropzone flash.
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    if (pdf.scanned) {
      // NEVER the generic binary line — the user must learn why a readable file
      // landed nothing. No OCR, by design.
      return NextResponse.json(
        { error: `${PDF_SCANNED_NOTE} (${pdf.pages} page(s)), nothing landed.` },
        { status: 400 },
      );
    }
    text = pdf.text;
    // What lands is TEXT (so structure/search/undo work unchanged); the meta
    // remembers the original.
    meta = {
      ...(typeof body.meta === "object" && body.meta ? (body.meta as Record<string, unknown>) : {}),
      mime: PDF_MIME,
      pages: pdf.pages,
      ...(pdf.truncated ? { truncated: true } : {}),
    };
  }

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
    { text, source: body.source || "memo", kind: body.kind, meta },
    { recordDir: recordDir() },
  );
  // Auto-structure first: when it merges, structurePending rebuilds the cache
  // itself — rebuilding here too would run the whole derivation twice per capture.
  const auto = await autoStructureNewItem(item.id); // Settings: skip the pending queue
  if (!auto || auto.structured === 0) landInboxCaptures([item], { recordDir: recordDir() });

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

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { appendInboxItems, captureSummary, inboxItemId, readInboxFromRecord } from "@/lib/record";
import { inboxResolve } from "@/lib/cli-core";
import { INBOX_JOB, readSyncJob, startJobAndWait } from "@/lib/sync-jobs";
import { MAX_INBOX_BYTES } from "@/lib/import-tree";
import { extractPdfText, looksPdf, MAX_PDF_BYTES, PDF_MIME, PDF_SCANNED_NOTE } from "@/lib/pdf-text";
import { landCapture } from "@/lib/structure-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** base64 inflates by 4/3; the rest is slack for the JSON envelope + meta. */
const MAX_BASE64_CHARS = Math.ceil(MAX_PDF_BYTES / 3) * 4;
const MAX_BODY_BYTES = MAX_BASE64_CHARS + 64 * 1024;

/** Pending bucket, read straight from the record (the source of truth).
 *  `?job=1` answers with the inbox job instead — what a caller polls after a 202. */
export async function GET(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (new URL(req.url).searchParams.get("job")) {
    return NextResponse.json({ job: readSyncJob(INBOX_JOB) });
  }
  const inbox = readInboxFromRecord(recordDir()).filter((i) => i.status === "pending");
  // Scanner notifications (kind "notification") are data-quality findings — they
  // live on the Data quality tab (GET /api/scan), not in the capture queue, so
  // `pending` counts captures only.
  const notifications = inbox.filter((i) => i.kind === "notification");
  const captures = inbox.filter((i) => i.kind !== "notification");
  // `captureSummary`, not the raw body: an image capture IS its file, as a base64
  // data URL, and shipping 200 of those made this endpoint hand the browser back
  // every photo it had ever been given so a panel could clamp it to two lines.
  const wire = (i: (typeof inbox)[number]) => ({ id: i.id, ts: i.ts, source: i.source, kind: i.kind, text: captureSummary(i) });
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
    // Deliberately NOT worded as a PDF limit: an image posts its whole file here
    // too (as a base64 data URL in `text`), and telling someone their photo failed
    // a PDF ceiling — then pointing them at a CSV importer — is two lies in one
    // sentence. The routes that own big files are named instead.
    return NextResponse.json(
      {
        error:
          `Too large to post (over ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB of request body). ` +
          "Import a file with `agentqs import <file>`, or photos with `agentqs photos import <folder>`.",
      },
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
    //
    // An image is stored as a base64 data URL, so this ceiling on the STORED TEXT
    // is a ceiling of about 18MB on the file itself (base64 inflates by 4/3). Say
    // that in the file's own terms, and point at the importer that owns photos —
    // `agentqs import` does not.
    const isImage = (body.kind ?? "") === "image" || text.startsWith("data:image/");
    return NextResponse.json(
      {
        error: isImage
          ? `That image is too large to land as a capture (over ~${Math.floor((MAX_INBOX_BYTES * 3) / 4 / 1024 / 1024)}MB of file, since it is stored base64-encoded). ` +
            "Import photos with `agentqs photos import <folder>` — it keeps the original on disk and indexes it."
          : "Text too large to land raw — import it with `agentqs import <file>` instead.",
      },
      { status: 400 },
    );
  }

  // The APPEND is inline and bounded — one line on the end of inbox.jsonl, and the
  // caller needs the id back. Everything after it (the cache patch and, when the
  // setting is on, the LLM auto-structure) goes on the record job queue, so this
  // request thread can never be held by a merge.
  const capture = { text, source: body.source || "memo", kind: body.kind, meta };
  const { items, added } = appendInboxItems([capture], { recordDir: recordDir() });
  if (!added) {
    // A dropped file is keyed by its CONTENT, so re-dropping the same file is a
    // duplicate by design. It is not an error and it is certainly not a 500 (which
    // is what it used to be).
    const id = inboxItemId(capture);
    const existing = readInboxFromRecord(recordDir()).find((i) => i.id === id);
    // …unless you had DISCARDED it. Then dropping it again is you asking for it
    // back, and an inert "already have that" is the file silently vanishing: it
    // never reaches the pending queue and the dropzone says nothing happened.
    // Restoring goes through the normal resolve path, so the cache patch and the
    // undo trail are the same as any other status change.
    if (existing?.status === "discarded") {
      const { job, result, error } = await startJobAndWait(INBOX_JOB, async () => ({
        result: inboxResolve(id, "restore"),
      }));
      if (error) return resolveError(error);
      if (!result) return NextResponse.json({ ok: true, duplicate: true, revived: true, id, queued: true, job }, { status: 202 });
      return NextResponse.json({ ok: true, duplicate: true, revived: true, id, pending: result.pending, structured: false });
    }
    // pending / reference / structured: leave it exactly as it is. Re-landing it
    // would overwrite a status the item has since earned.
    return NextResponse.json({
      ok: true,
      duplicate: true,
      id,
      pending: readInboxFromRecord(recordDir()).filter((i) => i.status === "pending").length,
      structured: false,
    });
  }
  const item = items[0];
  const landed = await landCapture(item, { recordDir: recordDir() });

  const pending =
    landed.structured?.pending ?? readInboxFromRecord(recordDir()).filter((i) => i.status === "pending").length;
  return NextResponse.json({
    ok: true,
    id: item.id,
    ts: item.ts,
    pending,
    structured: (landed.structured?.structured ?? 0) > 0,
    ...(landed.queued ? { queued: true } : {}),
  });
}

/** Missing id → 404; exists-but-wrong-state → 409 — a state conflict must not
 * read as "that id never existed" to an agent following the docs. */
function resolveError(e: unknown): NextResponse {
  const msg = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: msg }, { status: msg.startsWith("No inbox item") ? 404 : 409 });
}

/** Keep/discard through the record job queue. Both rewrite inbox.jsonl and patch
 *  the cache — small, but "small" is what the structure path was assumed to be too,
 *  and the request thread is not the place to find out. The queue also serializes
 *  them against an import, so two synchronous SQLite writers never overlap. Fast
 *  work still answers with its real result and status code. */
async function resolveAsJob(run: () => { pending: number }): Promise<NextResponse> {
  const { job, result, error } = await startJobAndWait(INBOX_JOB, async () => ({ result: run() }));
  if (error) return resolveError(error);
  if (!result) return NextResponse.json({ ok: true, queued: true, job }, { status: 202 });
  return NextResponse.json({ ok: true, pending: result.pending });
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
  return resolveAsJob(() => inboxResolve(id, "discard"));
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
  return resolveAsJob(() => inboxResolve(body.id!, "keep"));
}

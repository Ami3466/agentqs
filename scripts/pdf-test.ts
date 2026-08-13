#!/usr/bin/env tsx
/**
 * Ships-when proof for: A PDF IS DATA, NOT A DEAD END.
 *
 * Dropping a PDF used to fail on every face at once — the dropzone read it with
 * `f.text()`, saw NUL bytes and skipped it; /api/inbox rejected the NUL; importRaw
 * threw "Binary file — no importer claims it"; the folder walk filed it as residue;
 * and the Drive pull returned "binary (application/pdf) — not extracted" while the
 * README, the module header and the API catalog all promised it worked.
 *
 * One brain (src/lib/pdf-text.ts) now extracts the text layer and every face lands
 * TEXT, so structure/search/undo need no PDF awareness. The other half of the
 * contract is just as important: a SCANNED PDF (no text layer) is refused WITH ITS
 * REASON on every face — never a silent skip, never the generic binary line.
 *
 * Fixtures are built here, byte for byte, by a tiny PDF writer: deterministic, no
 * network, no checked-in blobs. Drives production code against a temp
 * AGENTQS_DATA_DIR. Run: npm run pdf:test
 */
import fs from "fs";
import os from "os";
import path from "path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-pdf-"));
process.env.AGENTQS_DATA_DIR = dataDir;

import { extractPdfText, looksPdf, MAX_PDF_BYTES, PDF_SCANNED_NOTE } from "../src/lib/pdf-text";
import { importTree } from "../src/lib/import-tree";
import { importRaw } from "../src/lib/cli-core";
import { pullDriveFile } from "../src/lib/drive-import";
import { readInboxFromRecord } from "../src/lib/record";
import { recordDir } from "../src/lib/paths";
import type { FetchLike } from "../src/lib/importers/plugin";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// ---- fixtures: a real PDF, written by hand ----------------------------------
/**
 * A minimal but VALID PDF: catalog → pages → one page object per content stream,
 * with a real xref table at the right byte offsets. No dependency, and the same
 * input always produces the same bytes.
 */
function buildPdf(pageStreams: string[]): Buffer {
  const objs: string[] = [];
  // Object numbers: 1 catalog, 2 pages, 3 font, then (page, content) pairs.
  const kids = pageStreams.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageStreams.length} >>`);
  objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  for (const content of pageStreams) {
    const pageNo = objs.length + 1;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNo + 1} 0 R >>`,
    );
    objs.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function textPage(lines: string[]): string {
  const body = lines.map((l, i) => `${i ? "0 -24 Td " : ""}(${l}) Tj`).join(" ");
  return `BT /F1 18 Tf 72 720 Td ${body} ET`;
}

/** Two pages with a real text layer. */
const TEXT_PDF = buildPdf([
  textPage(["Statement 2026-07-01", "Total 1234.56 USD"]),
  textPage(["Page two line"]),
]);
/** A page that draws a grey box and NOTHING else — a scan, as far as text goes. */
const SCANNED_PDF = buildPdf(["0.5 0.5 0.5 rg 72 600 200 100 re f"]);
/** Right magic, ruined body — the encrypted/corrupt class. */
const CORRUPT_PDF = Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), Buffer.alloc(512, 0x41)]);

const EXPECTED = "Statement 2026-07-01\nTotal 1234.56 USD\n\nPage two line";

async function main(): Promise<void> {
  // ---- 1. the brain ---------------------------------------------------------
  console.log("\nextractPdfText (pure over bytes, offline)");
  check("looksPdf on the magic bytes", looksPdf(TEXT_PDF));
  check("looksPdf ignores a text file that merely says %PDF-", !looksPdf(Buffer.from("see %PDF- spec\n")));
  const pdf = await extractPdfText(TEXT_PDF);
  check("text extracted verbatim", pdf.text === EXPECTED, JSON.stringify(pdf.text));
  check("page count is real", pdf.pages === 2, `pages=${pdf.pages}`);
  check("pages joined by a blank line", pdf.text.includes("USD\n\nPage two"), JSON.stringify(pdf.text.slice(-30)));
  check("no NUL survives (the record's guard would reject it)", !pdf.text.includes("\u0000"));
  check("not flagged scanned", !pdf.scanned);

  const scanned = await extractPdfText(SCANNED_PDF);
  check("a scan reports scanned:true with empty text", scanned.scanned === true && scanned.text === "", JSON.stringify(scanned));
  check("a scan still reports its page count", scanned.pages === 1, `pages=${scanned.pages}`);

  let corruptErr = "";
  try {
    await extractPdfText(CORRUPT_PDF);
  } catch (e) {
    corruptErr = e instanceof Error ? e.message : String(e);
  }
  check("a corrupt PDF throws a readable Error", /PDF/i.test(corruptErr) && corruptErr.length < 240, corruptErr);

  const clipped = await extractPdfText(TEXT_PDF, { maxChars: 20 });
  check("maxChars truncates and SAYS so", clipped.truncated === true && clipped.text.length === 20, JSON.stringify(clipped));

  const before = Buffer.from(TEXT_PDF);
  await extractPdfText(TEXT_PDF);
  check("the caller's bytes survive extraction (pdf.js gets a copy)", TEXT_PDF.equals(before));

  // ---- 2. importRaw — `agentqs import statement.pdf` -------------------------
  console.log("\nimportRaw lands the TEXT, not the bytes");
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-pdffix-"));
  const textPdfPath = path.join(fixtures, "statement.pdf");
  const scannedPdfPath = path.join(fixtures, "scan.pdf");
  fs.writeFileSync(textPdfPath, TEXT_PDF);
  fs.writeFileSync(scannedPdfPath, SCANNED_PDF);

  const raw = await importRaw({ file: textPdfPath });
  const landed = readInboxFromRecord(recordDir()).find((i) => i.id === raw.inboxId);
  check("import succeeded", !!raw.inboxId && !raw.structured, raw.note);
  check("the extracted text is what landed", landed?.text === EXPECTED, JSON.stringify(landed?.text));
  check("it is a pending capture like any other", landed?.status === "pending", landed?.status);
  const meta = (landed?.meta ?? {}) as Record<string, unknown>;
  check("meta remembers the original", meta.filename === "statement.pdf" && meta.mime === "application/pdf", JSON.stringify(meta));
  check("meta carries the page count", meta.pages === 2, String(meta.pages));
  check("the note names the pages", raw.note.includes("2 page"), raw.note);

  // ---- 3. a scan is refused WITH ITS REASON, and nothing lands ---------------
  console.log("\na scanned PDF fails loudly, never silently");
  const inboxBefore = readInboxFromRecord(recordDir()).length;
  let scanErr = "";
  try {
    await importRaw({ file: scannedPdfPath });
  } catch (e) {
    scanErr = e instanceof Error ? e.message : String(e);
  }
  check("throws the scanned reason", scanErr.includes(PDF_SCANNED_NOTE), scanErr);
  check("never the generic binary line", !/Binary file/i.test(scanErr), scanErr);
  check("nothing landed", readInboxFromRecord(recordDir()).length === inboxBefore);

  // ---- 4. import-tree buckets a .pdf ----------------------------------------
  console.log("\nimportTree: a PDF is an importable file, not residue");
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-pdftree-"));
  fs.writeFileSync(path.join(tree, "report.pdf"), TEXT_PDF);
  fs.writeFileSync(path.join(tree, "scanned.pdf"), SCANNED_PDF);
  fs.writeFileSync(path.join(tree, "broken.pdf"), CORRUPT_PDF);
  const report = await importTree(tree);
  const byPath = new Map(report.outcomes.map((o) => [o.path, o]));
  check("text PDF lands in the inbox", byPath.get("report.pdf")?.bucket === "inbox", byPath.get("report.pdf")?.detail);
  check("the outcome names the pages", !!byPath.get("report.pdf")?.detail.includes("2 page"), byPath.get("report.pdf")?.detail);
  check(
    "scanned PDF is ignored WITH the reason, not residue",
    byPath.get("scanned.pdf")?.bucket === "ignored" && !!byPath.get("scanned.pdf")?.detail.includes(PDF_SCANNED_NOTE),
    `${byPath.get("scanned.pdf")?.bucket}: ${byPath.get("scanned.pdf")?.detail}`,
  );
  check(
    "an unreadable PDF is residue with its reason",
    byPath.get("broken.pdf")?.bucket === "residue" && !!byPath.get("broken.pdf")?.detail.includes("PDF"),
    `${byPath.get("broken.pdf")?.bucket}: ${byPath.get("broken.pdf")?.detail}`,
  );
  const bucketSum = Object.values(report.buckets).reduce((a, b) => a + b, 0);
  check("accounting still honest (every file in exactly one bucket)", bucketSum === report.files, `${bucketSum}/${report.files}`);
  const treeItem = readInboxFromRecord(recordDir()).find(
    (i) => ((i.meta ?? {}) as Record<string, unknown>).filename === "report.pdf",
  );
  check("the folder walk landed the same text", treeItem?.text === EXPECTED, JSON.stringify(treeItem?.text));
  check("re-import adds nothing twice", (await importTree(tree)).buckets.inbox === 0);

  // ---- 5. pullDriveFile — read-on-request, nothing lands ---------------------
  console.log("\npullDriveFile extracts application/pdf (read-only)");
  const DRIVE: Record<string, { name: string; mimeType: string; body: Buffer }> = {
    d_text: { name: "statement.pdf", mimeType: "application/pdf", body: TEXT_PDF },
    d_scan: { name: "scan.pdf", mimeType: "application/pdf", body: SCANNED_PDF },
  };
  let mediaCalls = 0;
  const fakeDrive: FetchLike = (async (input: string | URL) => {
    const url = new URL(String(input));
    const id = decodeURIComponent(url.pathname.split("/files/")[1] ?? "");
    const f = DRIVE[id];
    if (!f) return new Response("{}", { status: 404 });
    if (url.searchParams.get("alt") === "media") {
      mediaCalls++;
      return new Response(f.body, { status: 200, headers: { "Content-Type": f.mimeType } });
    }
    return new Response(JSON.stringify({ id, name: f.name, mimeType: f.mimeType, size: f.body.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as FetchLike;

  const inboxBeforePull = readInboxFromRecord(recordDir()).length;
  const pulled = await pullDriveFile("tok", "d_text", fakeDrive);
  check("text comes back, not a binary stub", pulled.text === EXPECTED && !pulled.binary, JSON.stringify(pulled.text));
  check("the note names the pages", !!pulled.note?.includes("2 page"), pulled.note);
  check("bytes are the PDF's real length", pulled.bytes === TEXT_PDF.length, String(pulled.bytes));
  check("the bytes were actually downloaded", mediaCalls === 1, `alt=media calls=${mediaCalls}`);

  const pulledScan = await pullDriveFile("tok", "d_scan", fakeDrive);
  check(
    "a scanned PDF says WHY it has no text",
    !pulledScan.text && !!pulledScan.note?.includes(PDF_SCANNED_NOTE),
    pulledScan.note,
  );
  check(
    "a Drive pull lands NOTHING in the record",
    readInboxFromRecord(recordDir()).length === inboxBeforePull,
    `${inboxBeforePull} → ${readInboxFromRecord(recordDir()).length}`,
  );

  // ---- 6. the ceilings are real ---------------------------------------------
  console.log("\nceilings");
  check("MAX_PDF_BYTES is a sane single ceiling", MAX_PDF_BYTES === 25 * 1024 * 1024, String(MAX_PDF_BYTES));
  const fatPdf = path.join(fixtures, "fat.pdf");
  fs.writeFileSync(fatPdf, TEXT_PDF);
  // Pad past the ceiling without holding 25MB of text in memory twice.
  fs.appendFileSync(fatPdf, Buffer.alloc(MAX_PDF_BYTES, 0x20));
  let fatErr = "";
  try {
    await importRaw({ file: fatPdf });
  } catch (e) {
    fatErr = e instanceof Error ? e.message : String(e);
  }
  check("an oversize PDF is refused before it is parsed", fatErr.includes("PDF too large"), fatErr);

  fs.rmSync(fixtures, { recursive: true, force: true });
  fs.rmSync(tree, { recursive: true, force: true });
}

void main()
  .catch((e) => {
    console.error("checks threw:", e);
    failures++;
  })
  .finally(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
    process.exit(failures ? 1 : 0);
  });

/**
 * PDF → text, the ONE brain. Every face that can be handed a PDF (the dropzone
 * via POST /api/inbox, `agentqs import <file>`, the folder walk, and the
 * read-on-request Drive pull) calls THIS, so a PDF means the same thing
 * everywhere and no face invents its own answer.
 *
 * Pure over its input bytes: no fs, no network, no record — a test can drive it
 * offline against a fixture. The heavy dependency (`unpdf`, which carries a
 * pdf.js build) is DYNAMICALLY imported inside the function, the same discipline
 * `better-sqlite3` gets in src/lib/importers/files/registry.ts: nothing at module
 * scope may drag a serverless-sized parser into a browser bundle or into a server
 * page's graph that only wanted the constants.
 *
 * What comes back is TEXT, which is why the rest of the pipeline (structure,
 * search, undo) needs no PDF awareness at all.
 *
 * NOT here: OCR. A scanned PDF has no text layer, so it extracts to nothing —
 * that is reported as `scanned`, and every caller must say so in words
 * (PDF_SCANNED_NOTE). A silent skip, or the generic "binary file" message, is a
 * bug: the user watched a PDF land nowhere with no reason given.
 */

// The browser-safe half of the contract lives in a zero-dependency leaf so the
// dropzone can import the ceiling WITHOUT webpack emitting a pdf.js chunk into
// static/. Re-exported here so server callers have one import for all of it.
export { MAX_PDF_BYTES, PDF_MIME, PDF_SCANNED_NOTE, looksPdfName } from "./pdf-limits";

export interface PdfText {
  /** Readable text, pages joined by a blank line. Empty when `scanned`. */
  text: string;
  pages: number;
  /** Text hit `maxChars` and was cut — the tail is NOT in `text`. */
  truncated?: boolean;
  /** No text layer at all (a scan / photo of a page). `text` is empty. */
  scanned?: boolean;
}

/** Text is cut here. ~2M chars is several hundred dense pages; past that a PDF
 *  needs a dedicated importer, not a memo nobody can read. */
const DEFAULT_MAX_CHARS = 2_000_000;

/** `%PDF-` magic. Deliberately a PREFIX test, not a scan of the head: a text file
 *  that merely mentions "%PDF-" must keep landing as text. */
export function looksPdf(head: Buffer | Uint8Array): boolean {
  if (!head || head.length < 5) return false;
  // 0x25 % 0x50 P 0x44 D 0x46 F 0x2d -
  return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d;
}

/** Strip what must never reach the record: NUL and the other C0 controls (the
 *  inbox NUL guard would reject the whole capture), plus the zero-width and
 *  soft-hyphen junk pdf.js emits from ligature-heavy fonts. Tabs and newlines
 *  survive — they are the only layout a text extraction can honestly keep. */
function clean(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, "")
    // Lone surrogates survive JSON but corrupt any later utf8 round-trip.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/[ \t\u00A0]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** pdf.js failures are internal ("XRefParseException", a bare PasswordException) —
 *  turn them into one line a user can act on, which every face surfaces verbatim. */
function readableError(e: unknown): Error {
  const name = (e as { name?: string })?.name ?? "";
  const raw = e instanceof Error ? e.message : String(e);
  if (name === "PasswordException" || /password/i.test(raw)) {
    return new Error("Password-protected PDF — unlock it first, nothing was extracted.");
  }
  if (name === "InvalidPDFException" || /invalid pdf/i.test(raw)) {
    return new Error("Corrupt PDF — the file structure could not be read, nothing was extracted.");
  }
  return new Error(`Could not read the PDF — ${raw.replace(/\s+/g, " ").slice(0, 200)}.`);
}

/**
 * Extract a PDF's text layer. Throws a readable Error for an encrypted or corrupt
 * file; returns `scanned: true` with empty text when the file parses fine but
 * holds no text at all.
 */
export async function extractPdfText(
  bytes: Uint8Array | Buffer,
  opts: { maxChars?: number } = {},
): Promise<PdfText> {
  if (!bytes || bytes.length === 0) throw new Error("Empty PDF — nothing to extract.");
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  // pdf.js takes OWNERSHIP of the buffer it is given (it transfers/detaches it),
  // so hand it a private copy — the caller still needs its bytes afterwards (to
  // size, hash, or report the file).
  const data = new Uint8Array(bytes.length);
  data.set(bytes);

  let pages = 0;
  let runs: string[] = [];
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(data);
    const out = await extractText(doc, { mergePages: false });
    pages = out.totalPages;
    runs = Array.isArray(out.text) ? out.text : [String(out.text)];
  } catch (e) {
    throw readableError(e);
  }

  const text = runs.map((p) => clean(p)).filter(Boolean).join("\n\n");
  if (!text) return { text: "", pages, scanned: true };
  if (text.length > maxChars) return { text: text.slice(0, maxChars), pages, truncated: true };
  return { text, pages };
}

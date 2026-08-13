/**
 * The PDF facts a BROWSER is allowed to know — deliberately a zero-dependency
 * leaf, because the dropzone imports it.
 *
 * Splitting these out of src/lib/pdf-text.ts is not tidiness, it is the bundle:
 * pdf-text.ts dynamically imports `unpdf`, and webpack, seeing that import from a
 * client component's graph, emits a 1.6MB pdf.js chunk into `static/` that the
 * browser can never have a use for (the parse happens on the server, always).
 * Importing THIS file instead costs two constants.
 *
 * pdf-text.ts re-exports everything here, so server code has one import to reach
 * the whole PDF contract and there is still exactly one definition of each value.
 */

/**
 * A single PDF ceiling, shared by every face. A PDF is parsed IN MEMORY by
 * pdf.js, so the bytes cannot be unbounded — and over HTTP the dropzone posts
 * them base64 (≈ +33%), which is exactly the payload this keeps sane. The
 * EXTRACTED text is then still subject to MAX_INBOX_BYTES like any other capture:
 * a 20MB PDF usually extracts to a few hundred KB, so the two ceilings are
 * measuring different things and both apply.
 */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

export const PDF_MIME = "application/pdf";

/** The one wording for "there was nothing to extract". Faces append their own
 *  "nothing landed" clause; the REASON is always this, never a generic skip. */
export const PDF_SCANNED_NOTE = "scanned PDF — no text layer, nothing to extract";

/** Name/mime test for faces that only have metadata (the browser dropzone has a
 *  File, not its bytes). Bytes, when we have them, are still what decides
 *  (`looksPdf` in pdf-text.ts). */
export function looksPdfName(name: string, mime?: string): boolean {
  return mime === PDF_MIME || /\.pdf$/i.test(name);
}

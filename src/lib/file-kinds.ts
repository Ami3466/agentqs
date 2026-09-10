/**
 * WHAT KIND OF FILE IS THIS — the one vocabulary, shared by the browser and the
 * server.
 *
 * A zero-dependency leaf for the same reason `pdf-limits.ts` is one: the dropzone
 * is a client component, so anything it imports is bundled for the browser. Nothing
 * here touches `fs`, `path` or any brain.
 *
 * It exists because the answer used to be written twice and the two copies did not
 * agree. The dropzone routed a drop to its image branch on MIME ALONE
 * (`f.type.startsWith("image/")`) while the PDF branch beside it matched name OR
 * mime — so an iPhone `.HEIC`, a file dragged off a network share, anything the
 * browser hands over with an empty `type`, and any uppercase extension all MISSED
 * the image branch, fell through to the text branch, were read with `f.text()`,
 * tripped the binary guard and were reported as a bare "skipped" with no reason.
 * From the user's side the photo simply vanished — and it never reached the server,
 * which is why a record with 138 log entries held not one image capture.
 *
 * A file's kind is decided by its EXTENSION OR its MIME type, never by mime alone:
 * the browser's mime is a guess it is allowed to decline to make.
 */
import { looksPdfName } from "./pdf-limits";

/** Raster formats that land as an image capture (the picture itself is the body). */
export const IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "heic",
  "heif",
  "bmp",
  "tif",
  "tiff",
] as const;

/** Extensions whose contents are text, whatever the mime says. */
export const TEXT_EXTENSIONS = [
  "csv",
  "tsv",
  "tab",
  "psv",
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "ndjson",
  "log",
  "ics",
  "vcf",
  "xml",
  "html",
  "htm",
  "yaml",
  "yml",
] as const;

/** Lowercase extension without the dot, or "" — no `path` import, so the browser
 *  can use it too. Case-insensitive on purpose: `PHOTO.JPG` is a photo. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

const IMAGE_SET: ReadonlySet<string> = new Set<string>(IMAGE_EXTENSIONS);
const TEXT_SET: ReadonlySet<string> = new Set<string>(TEXT_EXTENSIONS);

/** Is this a picture? Name OR mime — the same contract as `looksPdfName`, which is
 *  the asymmetry this fixes. An empty/absent mime must never be the deciding vote. */
export function looksImageName(name: string, mime?: string): boolean {
  if (mime && mime.startsWith("image/")) return true;
  return IMAGE_SET.has(extensionOf(name));
}

/** Is this text? Name OR mime, same rule. */
export function looksTextualName(name: string, mime?: string): boolean {
  if (mime && (mime.startsWith("text/") || mime === "application/json")) return true;
  return TEXT_SET.has(extensionOf(name));
}

/**
 * WHICH branch a dropped file takes — the whole routing decision, as a pure
 * function of the two things a browser gives us. Extracted so it can be asserted
 * directly: it used to live inline in the dropzone's loop, where the only way to
 * find out that a `.HEIC` with an empty mime took the TEXT branch was for someone
 * to drop one and watch it disappear.
 *
 * Image first: a picture is never text, and "image/*" and a PDF cannot collide.
 */
export function captureRouteFor(name: string, mime?: string): "image" | "pdf" | "text" {
  if (looksImageName(name, mime)) return "image";
  if (looksPdfName(name, mime)) return "pdf";
  return "text";
}

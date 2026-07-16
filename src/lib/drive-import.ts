import type { AppConfig } from "./config";
import { readConfig, writeConfig } from "./config";
import { netFetch, type FetchLike } from "./importers/plugin";

/**
 * Google Drive as a READABLE data source — the pull-on-request sibling of the
 * Drive BACKUP target (src/lib/backup.ts). Backup is data going OUT (an encrypted
 * archive the app itself creates, `drive.file` scope). This is data coming IN, on
 * demand: you point agentqs at a folder you fill (email exports, message dumps,
 * PDFs) and it reads a file only when a question needs it — nothing is auto-synced
 * and nothing lands in the record. Because it reads files the app did NOT create,
 * it needs the broader `drive.readonly` scope, so it carries its OWN OAuth grant
 * (`drive_import`), never the backup's `drive.file` one.
 *
 * The record stays lean by design: the folder is the archive, agentqs holds no
 * copy. `listDriveFolder` is the table of contents; `pullDriveFile` fetches one
 * file's text when asked. Everything here is pure over an injected `fetchImpl`, so
 * the whole list → resolve → pull path runs offline against a fixture.
 */

const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

/** A hard ceiling on a single pull. A raw folder can hold gigabyte exports; a chat
 *  turn cannot read one, and downloading it would stall the request for minutes.
 *  Over this, `pullDriveFile` returns metadata + a note instead of the bytes. */
export const MAX_PULL_BYTES = 5 * 1024 * 1024;

/** One entry in a folder listing — the manifest row. `size` is bytes for a real
 *  file (folders and Google-native docs report none). */
export interface DriveFileEntry {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: number;
  isFolder: boolean;
}

/** A pulled file. `text` is present when the content was extractable (text-like or
 *  a Google Doc/Sheet exported to plain text); `binary` marks a file whose bytes
 *  we won't inline (an image, an archive) — the agent gets the metadata and a note,
 *  not megabytes of base64. `truncated` = the file was over MAX_PULL_BYTES. */
export interface DrivePull {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  text?: string;
  binary?: boolean;
  truncated?: boolean;
  note?: string;
}

// ---- config -------------------------------------------------------------------

/** Where the raw-import folder is remembered. Kept out of `backup` (that is data
 *  going OUT); this is a data-IN integration, so it gets its own top-level key. */
export interface DriveImportConfig {
  folderId?: string;
  folderName?: string; // label shown in the UI / CLI (what the folder is called in Drive)
}

export function driveImportConfig(cfg: AppConfig | null = readConfig()): DriveImportConfig {
  return cfg?.driveImport ?? {};
}

/** Persist the chosen folder. Passing an empty id clears it (disconnects the folder
 *  without touching the OAuth grant). */
export function setDriveImportFolder(folderId: string, folderName?: string): DriveImportConfig {
  const cfg = readConfig();
  if (!cfg) throw new Error("Not initialized — run setup first.");
  const next: DriveImportConfig = folderId.trim()
    ? { folderId: folderId.trim(), folderName: folderName?.trim() || undefined }
    : {};
  cfg.driveImport = next;
  writeConfig(cfg);
  return next;
}

// ---- Drive REST ---------------------------------------------------------------

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function driveText(url: string, token: string, fetchImpl: FetchLike): Promise<{ res: Response; body: string }> {
  const res = await netFetch(url, { headers: bearer(token) }, fetchImpl);
  const body = await res.text();
  return { res, body };
}

function driveError(res: Response, body: string): Error {
  let detail = body.trim();
  try {
    const err = (JSON.parse(body) as { error?: { message?: string } }).error;
    if (err?.message) detail = err.message;
  } catch {
    /* not JSON — keep the raw text */
  }
  return new Error(`Drive HTTP ${res.status}: ${detail.replace(/\s+/g, " ").slice(0, 200) || "no body"}`);
}

/** Prove the grant and name the account — the cheap `source test` probe, and the
 *  "connected as …" line. */
export async function driveImportAbout(token: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const { res, body } = await driveText(`${DRIVE_API}/about?fields=user(emailAddress)`, token, fetchImpl);
  if (!res.ok) throw driveError(res, body);
  const who = JSON.parse(body || "{}") as { user?: { emailAddress?: string } };
  return who.user?.emailAddress ?? "unknown account";
}

function entryFromApi(f: Record<string, unknown>): DriveFileEntry {
  const mimeType = String(f.mimeType ?? "");
  const rawSize = f.size;
  return {
    id: String(f.id ?? ""),
    name: String(f.name ?? ""),
    mimeType,
    modifiedTime: f.modifiedTime ? String(f.modifiedTime) : undefined,
    size: rawSize != null && Number.isFinite(Number(rawSize)) ? Number(rawSize) : undefined,
    isFolder: mimeType === DRIVE_FOLDER_MIME,
  };
}

/**
 * List a folder's immediate children (newest first). Follows Drive's paging to the
 * end — a folder with 400 exports must not silently return the first 100. Excludes
 * trashed items. When `folderId` is empty, lists the account's folders at the top
 * level, so the user can find the id to point at.
 */
export async function listDriveFolder(
  token: string,
  folderId: string,
  fetchImpl: FetchLike = fetch,
): Promise<DriveFileEntry[]> {
  const q = folderId.trim()
    ? `'${folderId.trim()}' in parents and trashed=false`
    : `mimeType='${DRIVE_FOLDER_MIME}' and trashed=false`;
  const out: DriveFileEntry[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 100; page++) {
    const url =
      `${DRIVE_API}/files?q=${encodeURIComponent(q)}` +
      `&orderBy=modifiedTime desc&pageSize=200` +
      `&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size)` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const { res, body } = await driveText(url, token, fetchImpl);
    if (!res.ok) throw driveError(res, body);
    const parsed = JSON.parse(body || "{}") as { files?: Record<string, unknown>[]; nextPageToken?: string };
    for (const f of parsed.files ?? []) out.push(entryFromApi(f));
    if (!parsed.nextPageToken) return out;
    pageToken = parsed.nextPageToken;
  }
  return out; // 100 pages × 200 = 20k entries; a real raw folder never reaches this
}

/** Resolve a user's query to one entry: an exact id, else a case-insensitive name
 *  match (exact name wins over a unique substring). Returns the match, or a list of
 *  candidates when the query is ambiguous / not found so the caller can report them. */
export function resolveDriveFile(
  entries: DriveFileEntry[],
  query: string,
): { file: DriveFileEntry } | { candidates: DriveFileEntry[] } {
  const q = query.trim();
  const byId = entries.find((e) => e.id === q);
  if (byId) return { file: byId };
  const lower = q.toLowerCase();
  const exact = entries.filter((e) => e.name.toLowerCase() === lower);
  if (exact.length === 1) return { file: exact[0] };
  const partial = entries.filter((e) => e.name.toLowerCase().includes(lower));
  if (partial.length === 1) return { file: partial[0] };
  return { candidates: (exact.length ? exact : partial).slice(0, 20) };
}

/** Google-native editor types have no downloadable bytes — they must be EXPORTED.
 *  Maps the common ones to a text-ish export format; anything else stays null and
 *  is treated as opaque. */
function exportMimeFor(mimeType: string): string | null {
  if (mimeType === "application/vnd.google-apps.document") return "text/plain";
  if (mimeType === "application/vnd.google-apps.spreadsheet") return "text/csv";
  if (mimeType === "application/vnd.google-apps.presentation") return "text/plain";
  return null;
}

/** Bytes we can hand to a model as text. Everything else (images, zips, native
 *  binaries) is returned as metadata + a note, never inlined. */
function isTextual(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/csv" ||
    /(?:\+xml|\+json)$/.test(mimeType) ||
    mimeType === "application/x-ndjson" ||
    mimeType === "message/rfc822" || // .eml — a single raw email
    mimeType === "application/mbox"
  );
}

/**
 * Pull one file's content by id. Google-native docs are exported to plain text /
 * CSV; text-like files are decoded UTF-8; anything binary comes back as a
 * described stub (name, mime, size) so the agent knows it exists without a
 * megabyte of base64. A file over MAX_PULL_BYTES is refused with a note, not
 * silently clipped.
 */
export async function pullDriveFile(
  token: string,
  fileId: string,
  fetchImpl: FetchLike = fetch,
  meta?: Pick<DriveFileEntry, "name" | "mimeType" | "size">,
): Promise<DrivePull> {
  // Resolve name/mime/size if the caller didn't already list it.
  let name = meta?.name ?? "";
  let mimeType = meta?.mimeType ?? "";
  let size = meta?.size;
  if (!mimeType) {
    const { res, body } = await driveText(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`,
      token,
      fetchImpl,
    );
    if (!res.ok) throw driveError(res, body);
    const f = JSON.parse(body || "{}") as Record<string, unknown>;
    name = String(f.name ?? "");
    mimeType = String(f.mimeType ?? "");
    size = f.size != null ? Number(f.size) : undefined;
  }

  const base: DrivePull = { id: fileId, name, mimeType, bytes: size ?? 0 };
  if (size != null && size > MAX_PULL_BYTES) {
    return { ...base, binary: !isTextual(mimeType), truncated: true, note: `over ${MAX_PULL_BYTES} bytes — not pulled` };
  }

  const exportMime = exportMimeFor(mimeType);
  if (exportMime) {
    const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`;
    const { res, body } = await driveText(url, token, fetchImpl);
    if (!res.ok) throw driveError(res, body);
    return { ...base, bytes: Buffer.byteLength(body), text: body };
  }

  if (!isTextual(mimeType)) {
    return { ...base, binary: true, note: `binary (${mimeType || "unknown type"}) — not extracted` };
  }

  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`;
  const { res, body } = await driveText(url, token, fetchImpl);
  if (!res.ok) throw driveError(res, body);
  return { ...base, bytes: Buffer.byteLength(body), text: body };
}

import fs from "fs";
import os from "os";
import path from "path";
import type { FetchLike } from "./importers/plugin";

/**
 * Granola — meeting notes, transcripts and AI summaries.
 *
 * Granola ships no public OAuth app, but its desktop client already holds a login
 * on this machine, and its own API accepts that session:
 *
 *   ~/Library/Application Support/Granola/supabase.json → workos_tokens.refresh_token
 *   POST /v1/refresh-access-token   → a 6h bearer access token
 *   POST /v2/get-documents          → the meeting documents
 *   POST /v1/get-document-panels    → the AI-generated notes (ProseMirror JSON)
 *   POST /v1/get-document-transcript→ the verbatim transcript segments
 *
 * Same posture as the WHOOP importer (reverse-engineered app login): the credential
 * we persist is the long-lived *refresh* token, never the 6-hour access token, so a
 * connected source keeps syncing without the desktop app running. Access tokens are
 * cached in-process for their lifetime rather than re-minted per request.
 *
 * The plaintext `supabase.json` is what recent builds still write alongside the
 * encrypted `.enc` twin; if a future build drops it, the user can paste the refresh
 * token by hand and everything below is unchanged.
 */

const API = "https://api.granola.ai";
const CLIENT_VERSION = "6.4.0";

function headers(token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `Granola/${CLIENT_VERSION}`,
    "X-Client-Version": CLIENT_VERSION,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** POST JSON to the Granola API. Its errors come back as `{message}` or bare text. */
async function post<T>(
  endpoint: string,
  body: unknown,
  fetchImpl: FetchLike,
  token?: string,
): Promise<T> {
  const res = await fetchImpl(`${API}${endpoint}`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).trim().slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`${endpoint} → ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

// ---- Auth -----------------------------------------------------------------

/** Where the desktop client keeps its session, per platform. */
export function granolaCredentialPath(homedir: string = os.homedir()): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(homedir, "AppData", "Roaming"), "Granola", "supabase.json");
  }
  if (process.platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", "Granola", "supabase.json");
  }
  return path.join(homedir, ".config", "Granola", "supabase.json");
}

/** Read the desktop client's refresh token. Returns undefined when Granola isn't
 *  installed, isn't signed in, or writes only the encrypted twin. */
export function discoverGranolaRefreshToken(file = granolaCredentialPath()): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const outer = JSON.parse(raw) as { workos_tokens?: unknown };
    // `workos_tokens` is a JSON *string* in the file, but tolerate a plain object.
    const tokens = (
      typeof outer.workos_tokens === "string"
        ? JSON.parse(outer.workos_tokens)
        : outer.workos_tokens
    ) as { refresh_token?: unknown } | undefined;
    const token = tokens?.refresh_token;
    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

interface RefreshResponse {
  access_token?: string;
  expires_in?: number;
}

/** access token + the epoch ms it stops being usable, keyed by refresh token. */
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Trade the long-lived refresh token for a bearer access token, cached for its
 *  lifetime (minus a minute of slack) so a multi-request sync mints exactly one. */
export async function granolaAccessToken(
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
  now: number = Date.now(),
): Promise<string> {
  const cached = accessTokenCache.get(refreshToken);
  if (cached && cached.expiresAt > now) return cached.token;

  const res = await post<RefreshResponse>("/v1/refresh-access-token", { refresh_token: refreshToken }, fetchImpl);
  const token = res.access_token;
  if (!token) throw new Error("refresh-access-token returned no access_token — reconnect Granola.");
  const ttlMs = Math.max(60, (res.expires_in ?? 3600) - 60) * 1000;
  accessTokenCache.set(refreshToken, { token, expiresAt: now + ttlMs });
  return token;
}

/** Test seam — drop cached access tokens so a fixture run re-mints. */
export function resetGranolaAuthCache(): void {
  accessTokenCache.clear();
}

// ---- API ------------------------------------------------------------------

export interface GranolaCalendarEvent {
  summary?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; displayName?: string; self?: boolean }>;
}

export interface GranolaDoc {
  id: string;
  title?: string | null;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  type?: string | null;
  valid_meeting?: boolean;
  notes_markdown?: string | null;
  notes_plain?: string | null;
  overview?: string | null;
  summary?: string | null;
  google_calendar_event?: GranolaCalendarEvent | null;
}

export interface GranolaPanel {
  id: string;
  title?: string | null;
  content?: ProseMirrorNode | null;
}

export interface GranolaTranscriptSegment {
  text?: string;
  source?: string; // "microphone" = you, "system" = everyone else
  start_timestamp?: string;
  end_timestamp?: string;
}

const PAGE = 100;
const MAX_PAGES = 50; // 5k documents — a backstop, not a real limit

/** Every non-deleted document, newest first. */
export async function listGranolaDocuments(
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<GranolaDoc[]> {
  const out: GranolaDoc[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await post<{ docs?: GranolaDoc[] }>(
      "/v2/get-documents",
      { limit: PAGE, offset: page * PAGE },
      fetchImpl,
      token,
    );
    const docs = res.docs ?? [];
    out.push(...docs.filter((d) => !d.deleted_at));
    if (docs.length < PAGE) break;
  }
  return out;
}

export async function getGranolaPanels(
  documentId: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<GranolaPanel[]> {
  const res = await post<GranolaPanel[] | { panels?: GranolaPanel[] }>(
    "/v1/get-document-panels",
    { document_id: documentId },
    fetchImpl,
    token,
  );
  return Array.isArray(res) ? res : (res.panels ?? []);
}

export async function getGranolaTranscript(
  documentId: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<GranolaTranscriptSegment[]> {
  const res = await post<GranolaTranscriptSegment[] | { segments?: GranolaTranscriptSegment[] }>(
    "/v1/get-document-transcript",
    { document_id: documentId },
    fetchImpl,
    token,
  );
  return Array.isArray(res) ? res : (res.segments ?? []);
}

// ---- Normalize ------------------------------------------------------------

export interface ProseMirrorNode {
  type?: string;
  text?: string;
  attrs?: { level?: number };
  content?: ProseMirrorNode[];
}

/** Granola's AI notes are a ProseMirror doc. Flatten to markdown-ish plain text:
 *  headings become `##`, list items `-`, everything else a paragraph line. */
export function panelToText(node: ProseMirrorNode | null | undefined, depth = 0): string {
  if (!node) return "";
  const kids = node.content ?? [];
  const inline = (n: ProseMirrorNode): string =>
    n.type === "text" ? (n.text ?? "") : (n.content ?? []).map(inline).join("");

  switch (node.type) {
    case "text":
      return node.text ?? "";
    case "heading":
      return `${"#".repeat(Math.min(6, Math.max(1, node.attrs?.level ?? 3)))} ${kids.map(inline).join("")}`;
    case "paragraph":
      return kids.map(inline).join("");
    case "listItem":
      return kids
        .map((k) => panelToText(k, depth + 1))
        .filter(Boolean)
        .map((line, i) => (i === 0 ? `${"  ".repeat(depth)}- ${line}` : line))
        .join("\n");
    case "bulletList":
    case "orderedList":
    case "doc":
    case "blockquote":
      return kids
        .map((k) => panelToText(k, node.type === "doc" ? depth : depth))
        .filter(Boolean)
        .join("\n");
    default:
      return kids.map((k) => panelToText(k, depth)).filter(Boolean).join("\n");
  }
}

/** "Me: …" / "Them: …" lines — Granola tags audio by capture device, not speaker. */
export function transcriptToText(segments: GranolaTranscriptSegment[]): string {
  const lines: string[] = [];
  let lastWho = "";
  for (const s of segments) {
    const text = (s.text ?? "").trim();
    if (!text) continue;
    const who = s.source === "microphone" ? "Me" : "Them";
    // Collapse consecutive segments from the same side into one line.
    if (who === lastWho) lines[lines.length - 1] += ` ${text}`;
    else {
      lines.push(`${who}: ${text}`);
      lastWho = who;
    }
  }
  return lines.join("\n");
}

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** No meeting — and no runaway recording worth trusting — spans more than a day. */
export const MAX_MEETING_MINUTES = 24 * 60;

function spanMinutes(start: string | undefined, end: string | undefined): number {
  if (!start || !end) return 0;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 0;
}

/** The calendar block, when it looks like one. Granola's own onboarding document
 *  ships a week-long placeholder block, so an implausible span is no evidence at
 *  all — not a 10,000-minute meeting. */
export function calendarMinutes(doc: GranolaDoc): number {
  const ev = doc.google_calendar_event;
  const m = spanMinutes(ev?.start?.dateTime, ev?.end?.dateTime);
  return m > 0 && m <= MAX_MEETING_MINUTES ? m : 0;
}

/** How long the meeting actually ran. The transcript is what happened — a 30-minute
 *  block that overran to 46 minutes *was* 46 minutes — so it outranks the calendar's
 *  plan, and the calendar only stands in when nothing was recorded. */
export function meetingMinutes(doc: GranolaDoc, segments: GranolaTranscriptSegment[]): number {
  const first = segments.find((s) => s.start_timestamp)?.start_timestamp;
  const last = [...segments].reverse().find((s) => s.end_timestamp)?.end_timestamp;
  const recorded = spanMinutes(first, last);
  if (recorded > 0 && recorded <= MAX_MEETING_MINUTES) return recorded;
  return calendarMinutes(doc);
}

/** A meeting happened if it was recorded, or if a real calendar block held it.
 *  Everything else Granola stores — its onboarding doc, a scratchpad — is a note:
 *  still worth indexing, but not a meeting and not a minute of meeting time. */
export function isMeeting(doc: GranolaDoc, segments: GranolaTranscriptSegment[]): boolean {
  return segments.length > 0 || calendarMinutes(doc) > 0;
}

export function attendeeNames(doc: GranolaDoc): string[] {
  const list = doc.google_calendar_event?.attendees ?? [];
  return list
    .filter((a) => !a.self)
    .map((a) => (a.displayName ?? a.email ?? "").trim())
    .filter(Boolean);
}

/** The best prose Granola holds for a meeting: the AI panel, else the user's own
 *  notes, else the one-line overview. */
export function meetingNotes(doc: GranolaDoc, panels: GranolaPanel[]): string {
  const fromPanels = panels
    .map((p) => {
      const body = panelToText(p.content).trim();
      if (!body) return "";
      const heading = (p.title ?? "").trim();
      return heading && !body.startsWith("#") ? `## ${heading}\n${body}` : body;
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (fromPanels) return fromPanels;
  const own = (doc.notes_markdown || doc.notes_plain || "").trim();
  if (own) return own;
  return (doc.overview || doc.summary || "").trim();
}

export function meetingTitle(doc: GranolaDoc): string {
  return (doc.title || doc.google_calendar_event?.summary || "Untitled meeting").trim();
}

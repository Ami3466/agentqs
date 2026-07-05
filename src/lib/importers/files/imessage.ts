import fs from "fs";
import os from "os";
import path from "path";
import type { DailyTable } from "../plugin";
import type { FileImporter, FileImportContext, FileImportResult } from "../file-plugin";

/**
 * iMessage / Messages history — a Tier-2 file importer. macOS keeps every message
 * in `~/Library/Messages/chat.db` (SQLite), one row per message in `message` with
 * a `date`, an `is_from_me` flag, and the text. `date` is a Core Foundation
 * absolute time relative to 2001-01-01: NANOSECONDS on modern macOS (10.13+),
 * SECONDS on older builds — we detect which by magnitude. Rolls up per day:
 *
 *   date, messages, sent, received
 *
 * `chat.db` needs Full Disk Access. The reader copies the (WAL-locked) DB to a
 * temp dir and opens the copy read-only. Deterministic given DB + window.
 */

// Seconds between the Unix epoch and the CF absolute-time epoch (2001-01-01).
const CF_EPOCH_OFFSET_S = 978_307_200;

interface MsgRow {
  date: number; // CF absolute time — ns on modern macOS, s on older
  is_from_me: number;
}

/** CF `date` → YYYY-MM-DD, auto-detecting nanosecond vs second encoding. */
export function messageDateToDay(date: number): string {
  const seconds = Math.abs(date) > 1e12 ? date / 1e9 : date; // ns vs s heuristic
  return new Date((seconds + CF_EPOCH_OFFSET_S) * 1000).toISOString().slice(0, 10);
}

/** Roll raw message rows up into the wide per-day daily table. */
export function normalizeMessages(rows: MsgRow[], from: string, to: string): DailyTable {
  const header = ["date", "messages", "sent", "received"];
  const perDay = new Map<string, { messages: number; sent: number; received: number }>();
  for (const r of rows) {
    const day = messageDateToDay(r.date);
    if (day < from || day > to) continue;
    const bucket = perDay.get(day) ?? { messages: 0, sent: 0, received: 0 };
    bucket.messages += 1;
    if (r.is_from_me) bucket.sent += 1;
    else bucket.received += 1;
    perDay.set(day, bucket);
  }
  const rowsOut = [...perDay.keys()].sort().map((day) => {
    const b = perDay.get(day)!;
    return [day, String(b.messages), String(b.sent), String(b.received)];
  });
  return { header, rows: rowsOut };
}

async function openChatDbCopy(src: string) {
  if (!fs.existsSync(src)) throw new Error(`Messages chat.db not found at ${src}`);
  const { default: Database } = await import("better-sqlite3");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-imessage-"));
  const dest = path.join(tmpDir, "chat.db");
  fs.copyFileSync(src, dest);
  for (const ext of ["-wal", "-shm"]) {
    if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, dest + ext);
  }
  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  try {
    return { db: new Database(dest, { readonly: true, fileMustExist: true }), cleanup };
  } catch (e) {
    cleanup();
    throw new Error(`${src} is not a readable Messages chat.db (${(e as Error).message})`);
  }
}

export async function readImessage(
  file: string,
  from: string,
  to: string,
): Promise<FileImportResult> {
  const { db, cleanup } = await openChatDbCopy(file);
  try {
    const hasMessage = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message'")
      .get();
    if (!hasMessage) throw new Error("no 'message' table (is this a Messages chat.db?)");
    // Bound the scan to the window in the DB's own units (ns since 2001-01-01).
    const fromNs = (Date.parse(`${from}T00:00:00Z`) / 1000 - CF_EPOCH_OFFSET_S) * 1e9;
    const toNs = ((Date.parse(`${to}T00:00:00Z`) + 86_400_000) / 1000 - CF_EPOCH_OFFSET_S) * 1e9;
    const rows = db
      .prepare("SELECT date, is_from_me FROM message WHERE date >= ? AND date < ?")
      .all(fromNs, toNs) as MsgRow[];
    const table = normalizeMessages(rows, from, to);
    return { table, meta: { messagesScanned: rows.length, daysWithData: table.rows.length } };
  } finally {
    db.close();
    cleanup();
  }
}

function imessageDefaultPaths(): string[] {
  const home = os.homedir();
  const paths: string[] = [];
  if (process.platform === "darwin") paths.push(path.join(home, "Library/Messages/chat.db"));
  paths.push("/host/messages/chat.db"); // Docker: mount ~/Library/Messages at /host/messages:ro
  return paths;
}

export const imessageImporter: FileImporter = {
  id: "imessage",
  name: "iMessage history",
  detail: "messages sent & received per day",
  connectHint: "Reads ~/Library/Messages/chat.db (needs Full Disk Access for your terminal).",
  live: true,
  primaryMetric: "messages",
  unit: "messages",
  defaultPaths: imessageDefaultPaths,
  read(ctx: FileImportContext): Promise<FileImportResult> {
    return readImessage(ctx.path, ctx.from, ctx.to);
  },
};

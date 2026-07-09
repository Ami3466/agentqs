import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { SCHEMA_VERSION, createEmpty } from "./db";
import { dbPath, recordDir } from "./paths";

/**
 * The git record — the source of truth. Plain text, one shape per stream, so a
 * human (or a diff) can read it and any importer in any language can append to
 * it. The SQLite cache is rebuilt from these files and nothing else.
 *
 *   record/
 *     daily/<source>.csv   wide CSV, first column `date`, one row per day.
 *                          Melted into (date, source=<stem>, metric=<col>).
 *     inbox.jsonl          one raw capture per line (pending bucket).
 *     sessions.jsonl       one mentor/therapy session per line (typed store).
 *
 * Rebuild is pure and deterministic: same record bytes in → same DB bytes out.
 */

export interface DailyRow {
  date: string;
  source: string;
  metric: string;
  valueNum: number | null;
  valueText: string;
}

export interface InboxItem {
  id: string;
  ts: string;
  source: string;
  kind: string;
  text: string;
  meta: unknown;
  status: string;
}

export interface SessionItem {
  id: string;
  date: string | null;
  startedAt: string;
  endedAt: string | null;
  skill: string;
  title: string | null;
  summary: string | null;
  transcript: string | null;
  insights: string[];
  commitments: string[];
}

export interface EventItem {
  id: string;
  date: string;
  ts: string;
  source: string;
  title: string | null;
  text: string;
  url: string | null;
  meta: unknown;
}

export interface RecordData {
  daily: DailyRow[];
  inbox: InboxItem[];
  sessions: SessionItem[];
  events: EventItem[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---- Parsers --------------------------------------------------------------

/** Numeric only when the whole trimmed cell is a finite number; else null. */
export function parseNumber(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Minimal RFC-4180 CSV: quotes, escaped quotes, embedded delimiters/newlines.
 * The delimiter is configurable (comma default) so tab/semicolon exports parse
 * with the same quote-aware state machine. */
export function parseCsv(
  text: string,
  delimiter = ",",
): { header: string[]; rows: string[][] } {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // strip BOM
  const n = text.length;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    records.push(row);
    row = [];
  };
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === delimiter) {
      endField();
      i++;
    } else if (c === "\r") {
      i++;
    } else if (c === "\n") {
      endRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field.length > 0 || row.length > 0) endRow();
  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0] === ""));
  const header = (nonEmpty.shift() ?? []).map((h) => h.trim());
  return { header, rows: nonEmpty };
}

/** Iterate a text file line by line without materializing it as one string —
 *  events.jsonl can exceed V8's ~512MB string cap, where a whole-file
 *  readFileSync(..., "utf8") throws "Cannot create a string longer than
 *  0x1fffffe8 characters". Chunks split only at newline BYTES (0x0a never occurs
 *  inside a multi-byte UTF-8 sequence), so decoding stays byte-exact. */
function forEachFileLine(file: string, onLine: (line: string, idx: number) => void): void {
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(16 * 1024 * 1024);
    let carry = Buffer.alloc(0);
    let idx = 0;
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl === -1) {
        carry = Buffer.from(data);
        continue;
      }
      // `data` may alias the reused chunk buffer, so the partial tail is copied.
      carry = Buffer.from(data.subarray(lastNl + 1));
      for (const line of data.subarray(0, lastNl).toString("utf8").split("\n")) {
        onLine(line.endsWith("\r") ? line.slice(0, -1) : line, idx);
        idx += 1;
      }
    }
    if (carry.length) {
      const line = carry.toString("utf8");
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line, idx);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  const out: Array<Record<string, unknown>> = [];
  let skipped = 0;
  let firstBad = 0;
  forEachFileLine(file, (line, idx) => {
    const t = line.trim();
    if (t === "") return;
    try {
      out.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      // A truncated line (interrupted append, crash mid-write) must not brick
      // every reader of the record — skip it, keep everything else. Skipping is
      // deterministic, so the rebuild guarantee holds.
      skipped += 1;
      if (!firstBad) firstBad = idx + 1;
    }
  });
  if (skipped) {
    console.warn(
      `${path.basename(file)}: skipped ${skipped} unparseable line${skipped === 1 ? "" : "s"} (first at line ${firstBad}).`,
    );
  }
  return out;
}

// ---- Readers (per stream) -------------------------------------------------

/** The one daily CSV the readers skip: a Takeout-derived browser_history.csv
 *  superseded by the extension's higher-fidelity browser_history_scrape.csv —
 *  reading both would double-count the same visits. Everything else in daily/
 *  is a real source: `_texts` / `_semantic` sidecars carry journal text and
 *  timeline metrics that the journal, FTS index and embeddings all consume.
 *  Shared by readDaily, recordHash and the sources registry so the record, its
 *  hash and the UI never disagree about what counts as a source. */
export function shouldSkipDailyCsvRead(dir: string, file: string): boolean {
  return (
    file === "browser_history.csv" &&
    fs.existsSync(path.join(dir, "browser_history_scrape.csv"))
  );
}

function readDaily(dir: string): DailyRow[] {
  const out: DailyRow[] = [];
  if (!fs.existsSync(dir)) return out;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .filter((f) => !shouldSkipDailyCsvRead(dir, f))
    .sort();
  for (const file of files) {
    const source = file.replace(/\.csv$/i, "");
    const { header, rows } = parseCsv(
      fs.readFileSync(path.join(dir, file), "utf8"),
    );
    if (header.length === 0) continue;
    // Canonical order: by date (first column), stable on ties.
    const dated = rows
      .map((r, idx) => ({ r, idx }))
      .sort(
        (a, b) =>
          cmp((a.r[0] ?? "").trim(), (b.r[0] ?? "").trim()) || a.idx - b.idx,
      );
    for (const { r } of dated) {
      const date = (r[0] ?? "").trim();
      if (date === "") continue;
      for (let c = 1; c < header.length; c++) {
        const metric = header[c];
        if (metric === "") continue;
        const raw = (r[c] ?? "").trim();
        if (raw === "") continue;
        out.push({ date, source, metric, valueText: raw, valueNum: parseNumber(raw) });
      }
    }
  }
  return out;
}

function readInbox(dir: string): InboxItem[] {
  const raw = readJsonl(path.join(dir, "inbox.jsonl"));
  return raw
    .map((o) => ({
      id: String(o.id),
      ts: String(o.ts ?? ""),
      source: String(o.source ?? "unknown"),
      kind: String(o.kind ?? "text"),
      text: String(o.text ?? ""),
      meta: o.meta ?? null,
      status: String(o.status ?? "pending"),
    }))
    .sort((a, b) => cmp(a.ts, b.ts) || cmp(a.id, b.id));
}

/** Normalize one parsed events.jsonl object, or null when it isn't an event.
 *  Shared by readEvents and the streaming rebuild so both agree on the shape. */
function eventFromJsonlObject(o: Record<string, unknown>): EventItem | null {
  const ts = String(o.ts ?? o.time ?? "");
  const date = String(o.date ?? ts.slice(0, 10));
  const e: EventItem = {
    id: String(o.id),
    date,
    ts: ts || `${date}T00:00:00.000Z`,
    source: String(o.source ?? "event"),
    title: str(o.title),
    text: String(o.text ?? o.action ?? o.title ?? ""),
    url: str(o.url),
    meta: o.meta ?? null,
  };
  return e.id && e.date && e.text ? e : null;
}

function readEvents(dir: string): EventItem[] {
  const raw = readJsonl(path.join(dir, "events.jsonl"));
  return raw
    .map(eventFromJsonlObject)
    .filter((e): e is EventItem => e !== null)
    .sort((a, b) => cmp(a.date, b.date) || cmp(a.ts, b.ts) || cmp(a.id, b.id));
}

export function readEventsFromRecord(dir: string): EventItem[] {
  return readEvents(dir);
}

/** Read the raw inbox (record/inbox.jsonl) — the pending capture bucket. Exposed for
 *  the semantic index, which embeds each memo's text. */
/** Read the daily stream alone (record/daily/*.csv). Exposed for consumers that
 *  don't need inbox/sessions/events — reading everything via readRecord would
 *  parse the (potentially huge) events.jsonl for nothing. */
export function readDailyFromRecord(dir: string): DailyRow[] {
  return readDaily(path.join(dir, "daily"));
}

export function readInboxFromRecord(dir: string): InboxItem[] {
  return readInbox(dir);
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

/** Read the typed session store (record/sessions.jsonl) — the synthesis layer,
 * stored separately from the daily table. Used by the chat route for continuity
 * (it reads these summaries/insights/commitments, never raw transcripts) and by
 * the sessions API for the sidebar. */
export function readSessionsFromRecord(dir: string): SessionItem[] {
  const raw = readJsonl(path.join(dir, "sessions.jsonl"));
  return raw
    .map((o) => ({
      id: String(o.id),
      date: str(o.date),
      startedAt: String(o.started_at ?? o.startedAt ?? ""),
      endedAt: str(o.ended_at ?? o.endedAt),
      skill: String(o.skill ?? "mentor"),
      title: str(o.title),
      summary: str(o.summary),
      transcript: str(o.transcript),
      insights: Array.isArray(o.insights) ? o.insights.map(String) : [],
      commitments: Array.isArray(o.commitments) ? o.commitments.map(String) : [],
    }))
    .sort((a, b) => cmp(a.startedAt, b.startedAt) || cmp(a.id, b.id));
}

export function readRecord(dir: string): RecordData {
  return {
    daily: readDaily(path.join(dir, "daily")),
    inbox: readInbox(dir),
    sessions: readSessionsFromRecord(dir),
    events: readEvents(dir),
  };
}

/** sha256 fingerprint of the whole record — stable across machines/runs. */
export function recordHash(dir: string): string {
  const h = crypto.createHash("sha256");
  if (!fs.existsSync(dir)) return h.update("").digest("hex");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (
        path.basename(path.dirname(full)) === "daily" &&
        shouldSkipDailyCsvRead(path.dirname(full), path.basename(full))
      ) {
        continue;
      }
      else files.push(full);
    }
  };
  walk(dir);
  files.sort();
  for (const f of files) {
    const rel = path.relative(dir, f).split(path.sep).join("/");
    h.update(rel, "utf8");
    h.update("\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

// ---- Writers --------------------------------------------------------------

export interface AppendInboxInput {
  /**
   * Stable id, for a capture an importer can produce again. Re-appending it is a
   * no-op, which is what makes re-running an import idempotent — the same guarantee
   * `appendEvents` gives. Omit it for a live capture: two identical memos typed a
   * minute apart are two captures, not one, so those keep a random uuid.
   */
  id?: string;
  text: string;
  source?: string; // memo | drop | chat | telegram | ...  (default: memo)
  kind?: string; // text | csv | file | ...                (default: text)
  meta?: unknown;
  ts?: string; // capture time override (demo/backfill); defaults to now
  /**
   * Lifecycle status (default "pending"). Both the inbox panel and the Structure
   * step act only on "pending", but every reader — FTS and the embedding index —
   * indexes an inbox item whatever its status. So an importer landing a finished
   * reference document (a Spotify taste profile, a saved-tracks list) passes
   * "reference": searchable and recall-able, but never queued as pending work and
   * never fed to the structuring LLM.
   */
  status?: string;
}

function buildInboxItem(input: AppendInboxInput, id: string): InboxItem {
  return {
    id,
    ts: input.ts || new Date().toISOString(),
    source: input.source?.trim() || "memo",
    kind: input.kind?.trim() || "text",
    text: input.text,
    meta: input.meta ?? null,
    status: input.status?.trim() || "pending",
  };
}

function serializeInboxItem(item: InboxItem): string {
  return JSON.stringify({
    id: item.id,
    ts: item.ts,
    source: item.source,
    kind: item.kind,
    text: item.text,
    ...(item.meta == null ? {} : { meta: item.meta }),
    status: item.status,
  });
}

/**
 * Append raw captures to record/inbox.jsonl — the pending bucket. The record is
 * the source of truth; the caller rebuilds the SQLite cache afterwards. No LLM,
 * no parsing: whatever the user typed lands verbatim, status `pending`.
 * Inputs carrying an `id` already on file are skipped, so an importer that hands
 * out stable ids can re-run over the same export without duplicating captures.
 */
export function appendInboxItems(
  inputs: AppendInboxInput[],
  opts: { recordDir?: string; dataDir?: string } = {},
): { added: number; total: number; items: InboxItem[] } {
  const rDir = opts.recordDir ?? recordDir(opts.dataDir);
  fs.mkdirSync(rDir, { recursive: true });
  const file = path.join(rDir, "inbox.jsonl");
  const existing = jsonlIdsFor(file);
  const lines: string[] = [];
  const items: InboxItem[] = [];
  for (const input of inputs) {
    const id = input.id?.trim() || crypto.randomUUID();
    if (existing.has(id)) continue;
    existing.add(id);
    const item = buildInboxItem(input, id);
    items.push(item);
    lines.push(serializeInboxItem(item));
  }
  appendJsonlLines(file, lines, existing);
  return { added: lines.length, total: existing.size, items };
}

/** One capture. Returns the item as it now stands on disk — a duplicate `id` is a
 *  no-op, not an error, so callers can append blind. */
export function appendInboxItem(
  input: AppendInboxInput,
  opts: { recordDir?: string; dataDir?: string } = {},
): InboxItem {
  const { items } = appendInboxItems([input], opts);
  return items[0] ?? buildInboxItem(input, input.id!.trim());
}

export interface AppendSessionInput {
  skill: string;
  startedAt?: string;
  endedAt?: string | null;
  date?: string | null;
  title?: string | null;
  summary?: string | null;
  transcript?: string | null;
  insights?: string[];
  commitments?: string[];
  id?: string;
}

/**
 * Append one finished session to record/sessions.jsonl — the typed session store
 * and synthesis layer, kept separate from record/daily/*.csv. A session is only
 * written after it's synthesized ({summary, insights, commitments} extracted), so
 * the record holds the distilled memory the agent later reads for continuity.
 * The full transcript is stored too but the agent never reads it back — only the
 * synthesis. Caller rebuilds the SQLite cache afterwards (so it lands on the
 * Journal timeline). Trailing-newline guarded like the inbox writer.
 */
export function appendSession(
  input: AppendSessionInput,
  opts: { recordDir?: string; dataDir?: string } = {},
): SessionItem {
  const rDir = opts.recordDir ?? recordDir(opts.dataDir);
  fs.mkdirSync(rDir, { recursive: true });

  const startedAt = input.startedAt || new Date().toISOString();
  const item: SessionItem = {
    id: input.id || crypto.randomUUID(),
    date: input.date ?? startedAt.slice(0, 10),
    startedAt,
    endedAt: input.endedAt ?? new Date().toISOString(),
    skill: input.skill?.trim() || "mentor",
    title: input.title ?? null,
    summary: input.summary ?? null,
    transcript: input.transcript ?? null,
    insights: input.insights ?? [],
    commitments: input.commitments ?? [],
  };

  const line = JSON.stringify({
    id: item.id,
    date: item.date,
    started_at: item.startedAt,
    ended_at: item.endedAt,
    skill: item.skill,
    ...(item.title == null ? {} : { title: item.title }),
    ...(item.summary == null ? {} : { summary: item.summary }),
    ...(item.transcript == null ? {} : { transcript: item.transcript }),
    insights: item.insights,
    commitments: item.commitments,
  });

  const file = path.join(rDir, "sessions.jsonl");
  ensureTrailingNewline(file);
  fs.appendFileSync(file, `${line}\n`);
  return item;
}

export interface AppendEventInput {
  id?: string;
  date?: string;
  ts?: string;
  source: string;
  title?: string | null;
  text: string;
  url?: string | null;
  meta?: unknown;
}

/** Dedup ids for an append-only jsonl stream (events.jsonl, inbox.jsonl), cached
 *  per file identity (path + size). events.jsonl can reach hundreds of MB and the
 *  extension POSTs one batch per scraped page — re-reading it per batch made long
 *  imports quadratic and indistinguishable from a hung server. One scan per process
 *  (or per external rewrite), then O(batch). */
const jsonlIdCache = new Map<string, { size: number; ids: Set<string> }>();

function jsonlIdsFor(file: string): Set<string> {
  let size = -1;
  try {
    size = fs.statSync(file).size;
  } catch {
    jsonlIdCache.delete(file);
    return new Set();
  }
  const cached = jsonlIdCache.get(file);
  if (cached && cached.size === size) return cached.ids;
  const ids = new Set<string>();
  forEachFileLine(file, (line) => {
    // Both jsonl writers serialize id first, so the fast regex covers our own lines;
    // JSON.parse only runs for foreign/hand-edited ones.
    const quick = line.match(/^\{"id":"([^"]+)"/);
    if (quick) {
      ids.add(quick[1]);
      return;
    }
    const t = line.trim();
    if (!t) return;
    try {
      const id = (JSON.parse(t) as { id?: unknown }).id;
      if (typeof id === "string") ids.add(id);
    } catch {
      /* unparseable line carries no id */
    }
  });
  jsonlIdCache.set(file, { size, ids });
  return ids;
}

/** Append lines to a jsonl stream and keep its id cache valid for the next batch
 *  (`ids` already holds the new ids — it IS the cached set). */
function appendJsonlLines(file: string, lines: string[], ids: Set<string>): void {
  if (!lines.length) return;
  ensureTrailingNewline(file);
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
  try {
    jsonlIdCache.set(file, { size: fs.statSync(file).size, ids });
  } catch {
    jsonlIdCache.delete(file);
  }
}

/** Append a newline iff the file's LAST BYTE isn't one — without reading the whole
 *  file (the old whole-file read cost 500MB+ of I/O per appended batch). */
function ensureTrailingNewline(file: string): void {
  if (!fs.existsSync(file)) return;
  const fd = fs.openSync(file, "r");
  let last = -1;
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return;
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    last = b[0];
  } finally {
    fs.closeSync(fd);
  }
  if (last !== 0x0a) fs.appendFileSync(file, "\n");
}

export function appendEvents(
  inputs: AppendEventInput[],
  opts: { recordDir?: string; dataDir?: string } = {},
): { added: number; total: number; items: EventItem[] } {
  const rDir = opts.recordDir ?? recordDir(opts.dataDir);
  fs.mkdirSync(rDir, { recursive: true });
  const file = path.join(rDir, "events.jsonl");
  const existing = jsonlIdsFor(file);
  const lines: string[] = [];
  const items: EventItem[] = [];
  for (const input of inputs) {
    const ts = input.ts || (input.date ? `${input.date}T00:00:00.000Z` : new Date().toISOString());
    const date = input.date || ts.slice(0, 10);
    const id =
      input.id ||
      crypto
        .createHash("sha256")
        .update([input.source, date, ts, input.title ?? "", input.text, input.url ?? ""].join("\0"))
        .digest("hex")
        .slice(0, 24);
    if (existing.has(id)) continue;
    existing.add(id);
    items.push({
      id,
      date,
      ts,
      source: input.source,
      title: input.title ?? null,
      text: input.text,
      url: input.url ?? null,
      meta: input.meta ?? null,
    });
    lines.push(JSON.stringify({
      id,
      date,
      ts,
      source: input.source,
      ...(input.title == null ? {} : { title: input.title }),
      text: input.text,
      ...(input.url == null ? {} : { url: input.url }),
      ...(input.meta == null ? {} : { meta: input.meta }),
    }));
  }
  appendJsonlLines(file, lines, existing);
  return { added: lines.length, total: existing.size, items };
}

/** Best-effort incremental insert of freshly appended events into the derived
 *  SQLite cache, so a long-running import shows up in the journal/graphs without
 *  a full rebuild per batch (a full rebuild re-parses the whole events.jsonl —
 *  far too heavy to run 100+ times per import). No-op when the cache doesn't
 *  exist yet; the next full rebuild converges the cache exactly. */
/** One event's keyword-search body. The date + source lead so "2015" or "spotify"
 *  match too. The fast-path SQL in rebuild() mirrors this expression exactly. */
function eventSearchBody(e: EventItem): string {
  return `${e.date} ${e.source}\n${e.title ? `${e.title}\n` : ""}${e.text}`;
}

export function insertEventsIntoCache(
  items: EventItem[],
  opts: { dataDir?: string } = {},
): number {
  const file = dbPath(opts.dataDir);
  if (!items.length || !fs.existsSync(file)) return 0;
  try {
    const db = new Database(file);
    try {
      const ins = db.prepare(
        "INSERT OR IGNORE INTO events (id,date,ts,source,title,text,url,meta) VALUES (?,?,?,?,?,?,?,?)",
      );
      // FTS5 has no uniqueness, so a search row is added only when the events
      // insert actually landed — otherwise re-posted batches would duplicate it.
      const insSearch = db.prepare("INSERT INTO search (ref,kind,body) VALUES (?,?,?)");
      let n = 0;
      const tx = db.transaction(() => {
        for (const e of items) {
          const r = ins.run(
            e.id,
            e.date,
            e.ts,
            e.source,
            e.title,
            e.text,
            e.url,
            e.meta == null ? null : JSON.stringify(e.meta),
          );
          n += r.changes;
          if (r.changes > 0) insSearch.run(`event:${e.id}`, "event", eventSearchBody(e));
        }
      });
      tx();
      return n;
    } finally {
      db.close();
    }
  } catch {
    return 0; // stale schema / locked cache — the final rebuild catches up
  }
}

/** Drop events a source landed in record/events.jsonl. Used two ways: with no
 *  window, when the source is removed (its events leave with its daily CSV); with
 *  a `{from,to}` window, when a source's records are re-derived each sync (Granola
 *  re-summarizes a meeting) so the fresh pull can replace the window in place —
 *  events outside the window are untouched. Rewrites the file once, preserving
 *  lines it can't parse. Returns how many events were dropped. */
export function removeEventsBySource(
  source: string,
  opts: { recordDir?: string; dataDir?: string; from?: string; to?: string } = {},
): number {
  const rDir = opts.recordDir ?? recordDir(opts.dataDir);
  const file = path.join(rDir, "events.jsonl");
  if (!fs.existsSync(file)) return 0;
  const { from, to } = opts;
  // Streamed line-by-line into a temp file (events.jsonl can exceed the ~512MB
  // string cap), swapped in atomically only when something was removed.
  const tmp = `${file}.rewrite.tmp`;
  const out = fs.openSync(tmp, "w");
  let removed = 0;
  let kept = 0;
  try {
    forEachFileLine(file, (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        const o = JSON.parse(t) as Record<string, unknown>;
        const date = String(o.date ?? (o.ts ? String(o.ts).slice(0, 10) : ""));
        const inWindow = (!from || date >= from) && (!to || date <= to);
        if (String(o.source ?? "") === source && inWindow) {
          removed++;
          return;
        }
      } catch {
        /* keep unparseable lines untouched */
      }
      kept++;
      fs.writeSync(out, `${t}\n`);
    });
  } finally {
    fs.closeSync(out);
  }
  if (!removed) {
    fs.rmSync(tmp, { force: true });
    return 0;
  }
  if (kept) fs.renameSync(tmp, file);
  else {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(file, { force: true });
  }
  jsonlIdCache.delete(file); // rewritten — the append dedup cache must rescan
  return removed;
}

/** Patch inbox items in place by id (e.g. mark `structured` / `discarded`).
 * Rewrites the whole file once, preserving every other field on each line and
 * any lines it can't parse. Returns how many items matched a patch. */
export function updateInboxItems(
  patches: Array<{ id: string; status?: string; meta?: unknown }>,
  opts: { recordDir?: string; dataDir?: string } = {},
): number {
  const rDir = opts.recordDir ?? recordDir(opts.dataDir);
  const file = path.join(rDir, "inbox.jsonl");
  if (!fs.existsSync(file)) return 0;
  const byId = new Map(patches.map((p) => [p.id, p]));
  const out: string[] = [];
  let updated = 0;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (t === "") continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      out.push(t); // keep unparseable lines untouched
      continue;
    }
    const patch = byId.get(String(obj.id));
    if (patch) {
      if (patch.status !== undefined) obj.status = patch.status;
      if (patch.meta !== undefined) obj.meta = patch.meta;
      updated++;
    }
    out.push(JSON.stringify(obj));
  }
  fs.writeFileSync(file, out.length ? out.join("\n") + "\n" : "", "utf8");
  return updated;
}

/** Delete a session from the record by id. Rewrites sessions.jsonl without the
 *  matching line (preserving every other line, parseable or not). Returns true when
 *  a session was removed. The caller rebuilds so it leaves the cache + timeline. */
export function removeSessionFromRecord(
  id: string,
  opts: { recordDir?: string; dataDir?: string } = {},
): boolean {
  const rDir = opts.recordDir ?? recordDir(opts.dataDir);
  const file = path.join(rDir, "sessions.jsonl");
  if (!fs.existsSync(file)) return false;
  const out: string[] = [];
  let removed = false;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (t === "") continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (String(obj.id) === id) {
        removed = true;
        continue;
      }
    } catch {
      /* keep unparseable lines */
    }
    out.push(t);
  }
  if (removed) fs.writeFileSync(file, out.length ? out.join("\n") + "\n" : "", "utf8");
  return removed;
}

/** One CSV cell, quoted only when it must be (delimiter, quote, or newline). */
function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize a wide table back to RFC-4180 CSV text (trailing newline). */
export function serializeCsv(header: string[], rows: string[][]): string {
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return lines.join("\n") + "\n";
}

export interface AppliedCell {
  d: string; // date
  m: string; // metric
  p: string | null; // value before this write (null = the cell didn't exist)
  v?: string; // value this write set ("" = the cell was cleared; absent on items structured before it was recorded)
  s?: string; // source override — a column merge touches two sources, so cells carry their own
}

export interface DailyMergeResult {
  file: string;
  source: string;
  rows: number; // total date-rows in the file after the merge
  metrics: string[]; // metric columns the incoming data actually wrote
  dates: string[]; // distinct dates the incoming data touched
  cells: number; // non-empty incoming metric cells applied (= daily rows added)
  applied: AppliedCell[]; // cells whose value actually changed, in write order — replay in reverse to undo
}

/** date → {metric: value} plus the metric column order, as read from one daily CSV. */
interface DailyTable {
  metricOrder: string[];
  table: Map<string, Map<string, string>>;
}

function loadDailyTable(file: string): DailyTable {
  const metricOrder: string[] = [];
  const seen = new Set<string>();
  const table = new Map<string, Map<string, string>>();
  if (!fs.existsSync(file)) return { metricOrder, table };
  const { header, rows } = parseCsv(fs.readFileSync(file, "utf8"));
  for (let c = 1; c < header.length; c++) {
    const m = header[c].trim();
    if (m && !seen.has(m)) {
      seen.add(m);
      metricOrder.push(m);
    }
  }
  for (const r of rows) {
    const date = (r[0] ?? "").trim();
    if (!date) continue;
    const row = table.get(date) ?? new Map<string, string>();
    for (let c = 1; c < header.length; c++) {
      const m = header[c].trim();
      const v = (r[c] ?? "").trim();
      if (m && v !== "") row.set(m, v);
    }
    table.set(date, row);
  }
  return { metricOrder, table };
}

/**
 * Merge a wide table (`incoming.header[0]` = date, rest = metrics) into
 * `record/daily/<source>.csv` — the generic path every structured import uses.
 * Existing metrics are unioned in first-seen order; a date+metric already present
 * is overwritten by a non-empty incoming value, blanks never clobber. Rows are
 * re-sorted by date. Deterministic: same inputs → byte-identical file.
 */
export function mergeDailyCsv(
  recordDir: string,
  source: string,
  incoming: { header: string[]; rows: string[][] },
): DailyMergeResult {
  const dailyDir = path.join(recordDir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  const file = path.join(dailyDir, `${source}.csv`);

  // Load the current file (if any) into date → {metric: value}.
  const { metricOrder, table } = loadDailyTable(file);
  const seen = new Set<string>(metricOrder);
  const addMetric = (m: string) => {
    if (m && !seen.has(m)) {
      seen.add(m);
      metricOrder.push(m);
    }
  };

  // Apply the incoming rows.
  const touchedMetrics: string[] = [];
  const touchedM = new Set<string>();
  const touchedD = new Set<string>();
  const applied: AppliedCell[] = [];
  let cells = 0;
  for (const r of incoming.rows) {
    const date = (r[0] ?? "").trim();
    if (!date) continue;
    const row = table.get(date) ?? new Map<string, string>();
    for (let c = 1; c < incoming.header.length; c++) {
      const m = (incoming.header[c] ?? "").trim();
      const v = (r[c] ?? "").trim();
      if (!m || v === "") continue;
      addMetric(m);
      const prev = row.get(m);
      if (prev !== v) applied.push({ d: date, m, p: prev ?? null, v });
      row.set(m, v);
      if (!touchedM.has(m)) {
        touchedM.add(m);
        touchedMetrics.push(m);
      }
      cells++;
    }
    table.set(date, row);
    touchedD.add(date);
  }

  const header = ["date", ...metricOrder];
  const dates = [...table.keys()].sort(cmp);
  const outRows = dates.map((d) => {
    const row = table.get(d)!;
    return [d, ...metricOrder.map((m) => row.get(m) ?? "")];
  });
  fs.writeFileSync(file, serializeCsv(header, outRows), "utf8");

  return {
    file,
    source,
    rows: dates.length,
    metrics: touchedMetrics,
    dates: [...touchedD].sort(cmp),
    cells,
    applied,
  };
}

// ---- Edits ------------------------------------------------------------------

export type DailyEdit =
  | { op: "set"; source: string; metric: string; date: string; value: string } // "" clears the cell
  | { op: "revertSet"; source: string; metric: string; date: string; value: string; expected: string } // conditional undo
  | { op: "deleteColumn"; source: string; metric: string }
  | { op: "deleteRow"; date: string }; // removes the date across every source

export interface DailyEditResult {
  sets: number;
  clears: number;
  deletedColumns: number;
  deletedRows: number;
}

export function revertEditsFromAppliedMeta(meta: unknown): DailyEdit[] {
  if (!meta || typeof meta !== "object") return [];
  const o = meta as { source?: unknown; applied?: unknown };
  if (typeof o.source !== "string" || !Array.isArray(o.applied)) return [];
  const edits: DailyEdit[] = [];
  for (const c of [...o.applied].reverse()) {
    if (!c || typeof c !== "object") continue;
    const cell = c as { d?: unknown; m?: unknown; p?: unknown; v?: unknown; s?: unknown };
    if (typeof cell.d !== "string" || typeof cell.m !== "string" || typeof cell.v !== "string") continue;
    edits.push({
      op: "revertSet",
      source: typeof cell.s === "string" && cell.s ? cell.s : o.source,
      metric: cell.m,
      date: cell.d,
      value: typeof cell.p === "string" ? cell.p : "",
      expected: cell.v,
    });
  }
  return edits;
}

/** Sources become filenames under record/daily — keep them to the same slug shape
 *  the importers produce so an edit can never write outside the daily dir. */
function safeSource(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 40);
  return s || "manual";
}

/** Serialize a DailyTable back to its CSV, dropping metrics/dates that no longer
 *  hold any value; an empty table deletes the file. */
function writeDailyTable(file: string, t: DailyTable): void {
  const liveMetrics = t.metricOrder.filter((m) =>
    [...t.table.values()].some((row) => row.has(m)),
  );
  const dates = [...t.table.keys()]
    .filter((d) => liveMetrics.some((m) => t.table.get(d)!.has(m)))
    .sort(cmp);
  if (!liveMetrics.length || !dates.length) {
    if (fs.existsSync(file)) fs.rmSync(file);
    return;
  }
  const header = ["date", ...liveMetrics];
  const rows = dates.map((d) => {
    const row = t.table.get(d)!;
    return [d, ...liveMetrics.map((m) => row.get(m) ?? "")];
  });
  fs.writeFileSync(file, serializeCsv(header, rows), "utf8");
}

/**
 * Apply manual edits to the daily record — the write path behind the Journal
 * table's Edit mode and the Log's reject-revert. Cells set/cleared in order, so
 * replaying a merge's `applied` list in reverse restores the pre-merge state.
 * The caller rebuilds the SQLite cache afterwards.
 */
export function applyDailyEdits(
  edits: DailyEdit[],
  opts: { recordDir?: string; dataDir?: string } = {},
): DailyEditResult {
  const rDir = opts.recordDir ?? recordDir(opts.dataDir);
  const dailyDir = path.join(rDir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });

  const touched = new Map<string, DailyTable>();
  const dirty = new Set<string>();
  const fileOf = (source: string) => path.join(dailyDir, `${source}.csv`);
  const load = (source: string): DailyTable => {
    let t = touched.get(source);
    if (!t) {
      t = loadDailyTable(fileOf(source));
      touched.set(source, t);
    }
    return t;
  };
  const allSources = (): string[] =>
    fs
      .readdirSync(dailyDir)
      .filter((f) => f.toLowerCase().endsWith(".csv"))
      .map((f) => f.replace(/\.csv$/i, ""));

  const result: DailyEditResult = { sets: 0, clears: 0, deletedColumns: 0, deletedRows: 0 };

  for (const e of edits) {
    if (e.op === "set") {
      const date = e.date.trim();
      const metric = e.metric.trim();
      const value = e.value.trim();
      if (!date || !metric) continue;
      const t = load(safeSource(e.source));
      if (value === "") {
        if (t.table.get(date)?.delete(metric)) {
          dirty.add(safeSource(e.source));
          result.clears++;
        }
        continue;
      }
      const source = safeSource(e.source);
      const t2 = load(source);
      const current = t2.table.get(date)?.get(metric);
      if (current === value) continue;
      if (!t2.metricOrder.includes(metric)) t2.metricOrder.push(metric);
      const row = t2.table.get(date) ?? new Map<string, string>();
      row.set(metric, value);
      t2.table.set(date, row);
      dirty.add(source);
      result.sets++;
    } else if (e.op === "revertSet") {
      const date = e.date.trim();
      const metric = e.metric.trim();
      const value = e.value.trim();
      const expected = e.expected.trim();
      if (!date || !metric) continue;
      const t = load(safeSource(e.source));
      if ((t.table.get(date)?.get(metric) ?? "") !== expected) continue;
      if (value === "") {
        if (t.table.get(date)?.delete(metric)) {
          dirty.add(safeSource(e.source));
          result.clears++;
        }
        continue;
      }
      if (t.table.get(date)?.get(metric) === value) continue;
      if (!t.metricOrder.includes(metric)) t.metricOrder.push(metric);
      const row = t.table.get(date) ?? new Map<string, string>();
      row.set(metric, value);
      t.table.set(date, row);
      dirty.add(safeSource(e.source));
      result.sets++;
    } else if (e.op === "deleteColumn") {
      const metric = e.metric.trim();
      const t = load(safeSource(e.source));
      const i = t.metricOrder.indexOf(metric);
      if (i >= 0) {
        t.metricOrder.splice(i, 1);
        dirty.add(safeSource(e.source));
        result.deletedColumns++;
      }
      for (const row of t.table.values()) {
        if (row.delete(metric)) dirty.add(safeSource(e.source));
      }
    } else {
      const date = e.date.trim();
      if (!date) continue;
      let removed = false;
      for (const source of new Set([...allSources(), ...touched.keys()])) {
        if (load(source).table.delete(date)) {
          dirty.add(source);
          removed = true;
        }
      }
      if (removed) result.deletedRows++;
    }
  }

  for (const source of dirty) writeDailyTable(fileOf(source), load(source));
  return result;
}

// ---- Rebuild --------------------------------------------------------------

export interface RebuildOptions {
  dataDir?: string;
  recordDir?: string;
  dbPath?: string;
}

export interface RebuildResult {
  dbPath: string;
  recordHash: string;
  daily: number;
  inbox: number;
  sessions: number;
  events: number;
}

/**
 * Rebuild the SQLite cache from the record, deterministically. Builds in memory
 * with a fixed insertion order, then `VACUUM INTO` a fresh file for a canonical
 * on-disk layout — two runs over the same record produce byte-identical DBs.
 */
export function rebuild(opts: RebuildOptions = {}): RebuildResult {
  const rDir = opts.recordDir ?? recordDir(opts.dataDir);
  const outPath = opts.dbPath ?? dbPath(opts.dataDir);

  // events.jsonl can reach hundreds of MB; parsing it dominates every rebuild.
  // When it is byte-identical to what the previous cache was built from (stamped
  // in meta), its rows are copied table-to-table from that cache instead — the
  // daily/inbox/sessions streams that actually changed still rebuild from text.
  const eventsFile = path.join(rDir, "events.jsonl");
  let eventsStamp = "absent";
  try {
    const st = fs.statSync(eventsFile);
    eventsStamp = `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    /* no events yet */
  }
  let copyEventsFrom: string | null = null;
  let copiedEventRows = 0;
  if (fs.existsSync(outPath)) {
    try {
      const prev = new Database(outPath, { readonly: true, fileMustExist: true });
      try {
        const meta = new Map(
          (prev.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>).map(
            (r) => [r.key, r.value],
          ),
        );
        if (meta.get("schema_version") === String(SCHEMA_VERSION) && meta.get("events_stamp") === eventsStamp) {
          copiedEventRows = (prev.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
          copyEventsFrom = outPath;
        }
      } finally {
        prev.close();
      }
    } catch {
      /* unreadable previous cache — full parse below */
    }
  }

  const record: RecordData = {
    daily: readDailyFromRecord(rDir),
    inbox: readInboxFromRecord(rDir),
    sessions: readSessionsFromRecord(rDir),
    events: [], // never held in RAM — streamed into a staging table below
  };
  const hash = recordHash(rDir);

  // The build DB is file-backed: SQLite's bounded page cache instead of the whole
  // cache in RAM (a million-event record OOMs an in-memory build). Events stream
  // from events.jsonl into a staging table, and both the canonical `events` insert
  // and the search index copy out of it in sorted order — so the full parse and
  // the fast path run the exact same SQL.
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const buildPath = `${outPath}.build-${process.pid}`;
  fs.rmSync(buildPath, { force: true });
  const db = createEmpty(buildPath);
  if (copyEventsFrom) db.exec(`ATTACH DATABASE '${copyEventsFrom.replace(/'/g, "''")}' AS prev`);

  let eventRows = copiedEventRows;
  if (!copyEventsFrom) {
    db.exec(
      "CREATE TABLE events_stage (id TEXT, date TEXT, ts TEXT, source TEXT, title TEXT, text TEXT, url TEXT, meta TEXT)",
    );
    const insStage = db.prepare("INSERT INTO events_stage VALUES (?,?,?,?,?,?,?,?)");
    if (fs.existsSync(eventsFile)) {
      db.exec("BEGIN");
      forEachFileLine(eventsFile, (line) => {
        const t = line.trim();
        if (t === "") return;
        let o: Record<string, unknown>;
        try {
          o = JSON.parse(t) as Record<string, unknown>;
        } catch {
          return; // same skip-bad-lines semantics as readJsonl
        }
        const e = eventFromJsonlObject(o);
        if (!e) return;
        insStage.run(e.id, e.date, e.ts, e.source, e.title, e.text, e.url, e.meta == null ? null : JSON.stringify(e.meta));
        eventRows += 1;
        if (eventRows % 50_000 === 0) {
          db.exec("COMMIT");
          db.exec("BEGIN");
        }
      });
      db.exec("COMMIT");
    }
  }
  const insertAll = db.transaction((rec: RecordData) => {
    const insDaily = db.prepare(
      "INSERT OR REPLACE INTO daily (date,source,metric,value_num,value_text) VALUES (?,?,?,?,?)",
    );
    for (const d of rec.daily)
      insDaily.run(d.date, d.source, d.metric, d.valueNum, d.valueText);

    const insInbox = db.prepare(
      "INSERT INTO raw_inbox (id,ts,source,kind,text,meta,status) VALUES (?,?,?,?,?,?,?)",
    );
    for (const it of rec.inbox)
      insInbox.run(
        it.id,
        it.ts,
        it.source,
        it.kind,
        it.text,
        it.meta == null ? null : JSON.stringify(it.meta),
        it.status,
      );

    const insSes = db.prepare(
      "INSERT INTO sessions (id,date,started_at,ended_at,skill,title,summary,transcript,insights,commitments) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    for (const s of rec.sessions)
      insSes.run(
        s.id,
        s.date,
        s.startedAt,
        s.endedAt,
        s.skill,
        s.title,
        s.summary,
        s.transcript,
        JSON.stringify(s.insights),
        JSON.stringify(s.commitments),
      );

    // Same canonical order on both paths, so a fast-path build and a full parse
    // produce byte-identical caches (rebuild:verify asserts this).
    const eventsSrc = copyEventsFrom ? "prev.events" : "events_stage";
    db.exec(`INSERT INTO events SELECT id,date,ts,source,title,text,url,meta FROM ${eventsSrc} ORDER BY date, ts, id`);

    const insSearch = db.prepare(
      "INSERT INTO search (ref,kind,body) VALUES (?,?,?)",
    );
    for (const d of rec.daily) {
      if (d.valueNum != null || d.valueText.trim().length < 8) continue;
      insSearch.run(`daily:${d.date}:${d.source}:${d.metric}`, "daily", `${d.source}.${d.metric}\n${d.valueText}`);
    }
    for (const s of rec.sessions) {
      const body = [s.title, s.summary, ...s.insights, ...s.commitments, s.transcript]
        .filter(Boolean)
        .join("\n");
      insSearch.run(`session:${s.id}`, "session", body);
    }
    // Skip image captures — their body is a base64 data URL, not searchable text.
    for (const it of rec.inbox) {
      if (it.kind === "image") continue;
      insSearch.run(`inbox:${it.id}`, "inbox", it.text);
    }
    // Events (imports, scrapes, listening history) join the same keyword index so
    // search reaches the whole timeline. This SELECT must mirror eventSearchBody
    // (the incremental insert path) exactly.
    db.exec(
      `INSERT INTO search (ref,kind,body)
       SELECT 'event:' || id, 'event',
              date || ' ' || source || char(10) ||
              CASE WHEN title IS NOT NULL AND title != '' THEN title || char(10) ELSE '' END || text
       FROM ${eventsSrc} ORDER BY date, ts, id`,
    );

    const insMeta = db.prepare("INSERT INTO meta (key,value) VALUES (?,?)");
    insMeta.run("schema_version", String(SCHEMA_VERSION));
    insMeta.run("record_hash", hash);
    insMeta.run("daily_rows", String(rec.daily.length));
    insMeta.run("inbox_rows", String(rec.inbox.length));
    insMeta.run("session_rows", String(rec.sessions.length));
    insMeta.run("event_rows", String(eventRows));
    insMeta.run("events_stamp", eventsStamp);
  });
  insertAll(record);
  if (copyEventsFrom) db.exec("DETACH DATABASE prev");
  else db.exec("DROP TABLE events_stage");

  // VACUUM into a sibling temp file, then rename over the old cache: readers
  // (the running app) never observe a missing or half-written DB, even when the
  // write takes seconds on a large record.
  const tmpPath = `${outPath}.rebuild-${process.pid}`;
  for (const p of [tmpPath, `${outPath}-wal`, `${outPath}-shm`, `${outPath}-journal`])
    if (fs.existsSync(p)) fs.rmSync(p);
  try {
    db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
    fs.rmSync(buildPath, { force: true });
  }
  fs.renameSync(tmpPath, outPath);

  return {
    dbPath: outPath,
    recordHash: hash,
    daily: record.daily.length,
    inbox: record.inbox.length,
    sessions: record.sessions.length,
    events: eventRows,
  };
}

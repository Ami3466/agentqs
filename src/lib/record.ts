import crypto from "crypto";
import fs from "fs";
import path from "path";
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

export interface RecordData {
  daily: DailyRow[];
  inbox: InboxItem[];
  sessions: SessionItem[];
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

function readJsonl(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const out: Array<Record<string, unknown>> = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const t = line.trim();
    if (t === "") return;
    try {
      out.push(JSON.parse(t) as Record<string, unknown>);
    } catch (e) {
      throw new Error(
        `${path.basename(file)}: invalid JSON on line ${idx + 1}: ${(e as Error).message}`,
      );
    }
  });
  return out;
}

// ---- Readers (per stream) -------------------------------------------------

function readDaily(dir: string): DailyRow[] {
  const out: DailyRow[] = [];
  if (!fs.existsSync(dir)) return out;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
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

/** Read the raw inbox (record/inbox.jsonl) — the pending capture bucket. Exposed for
 *  the semantic index, which embeds each memo's text. */
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
  text: string;
  source?: string; // memo | drop | chat | telegram | ...  (default: memo)
  kind?: string; // text | csv | file | ...                (default: text)
  meta?: unknown;
}

/**
 * Append one raw capture to record/inbox.jsonl — the pending bucket. The record
 * is the source of truth; the caller rebuilds the SQLite cache afterwards. No
 * LLM, no parsing: whatever the user typed lands verbatim, status `pending`.
 * A trailing newline is guaranteed so lines never run together on re-append.
 */
export function appendInboxItem(
  input: AppendInboxInput,
  opts: { recordDir?: string; dataDir?: string } = {},
): InboxItem {
  const rDir = opts.recordDir ?? recordDir(opts.dataDir);
  fs.mkdirSync(rDir, { recursive: true });

  const item: InboxItem = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    source: input.source?.trim() || "memo",
    kind: input.kind?.trim() || "text",
    text: input.text,
    meta: input.meta ?? null,
    status: "pending",
  };

  const line = JSON.stringify({
    id: item.id,
    ts: item.ts,
    source: item.source,
    kind: item.kind,
    text: item.text,
    ...(item.meta == null ? {} : { meta: item.meta }),
    status: item.status,
  });

  const file = path.join(rDir, "inbox.jsonl");
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) fs.appendFileSync(file, "\n");
  }
  fs.appendFileSync(file, `${line}\n`);
  return item;
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
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) fs.appendFileSync(file, "\n");
  }
  fs.appendFileSync(file, `${line}\n`);
  return item;
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

export interface DailyMergeResult {
  file: string;
  source: string;
  rows: number; // total date-rows in the file after the merge
  metrics: string[]; // metric columns the incoming data actually wrote
  dates: string[]; // distinct dates the incoming data touched
  cells: number; // non-empty incoming metric cells applied (= daily rows added)
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

  const table = new Map<string, Map<string, string>>();
  const metricOrder: string[] = [];
  const seen = new Set<string>();
  const addMetric = (m: string) => {
    if (m && !seen.has(m)) {
      seen.add(m);
      metricOrder.push(m);
    }
  };

  // Load the current file (if any) into date → {metric: value}.
  if (fs.existsSync(file)) {
    const { header, rows } = parseCsv(fs.readFileSync(file, "utf8"));
    for (let c = 1; c < header.length; c++) addMetric(header[c].trim());
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
  }

  // Apply the incoming rows.
  const touchedMetrics: string[] = [];
  const touchedM = new Set<string>();
  const touchedD = new Set<string>();
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
  };
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
}

/**
 * Rebuild the SQLite cache from the record, deterministically. Builds in memory
 * with a fixed insertion order, then `VACUUM INTO` a fresh file for a canonical
 * on-disk layout — two runs over the same record produce byte-identical DBs.
 */
export function rebuild(opts: RebuildOptions = {}): RebuildResult {
  const rDir = opts.recordDir ?? recordDir(opts.dataDir);
  const outPath = opts.dbPath ?? dbPath(opts.dataDir);
  const record = readRecord(rDir);
  const hash = recordHash(rDir);

  const db = createEmpty();
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

    const insSearch = db.prepare(
      "INSERT INTO search (ref,kind,body) VALUES (?,?,?)",
    );
    for (const s of rec.sessions) {
      const body = [s.title, s.summary, ...s.insights, ...s.commitments, s.transcript]
        .filter(Boolean)
        .join("\n");
      insSearch.run(`session:${s.id}`, "session", body);
    }
    for (const it of rec.inbox) insSearch.run(`inbox:${it.id}`, "inbox", it.text);

    const insMeta = db.prepare("INSERT INTO meta (key,value) VALUES (?,?)");
    insMeta.run("schema_version", String(SCHEMA_VERSION));
    insMeta.run("record_hash", hash);
    insMeta.run("daily_rows", String(rec.daily.length));
    insMeta.run("inbox_rows", String(rec.inbox.length));
    insMeta.run("session_rows", String(rec.sessions.length));
  });
  insertAll(record);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  for (const p of [outPath, `${outPath}-wal`, `${outPath}-shm`, `${outPath}-journal`])
    if (fs.existsSync(p)) fs.rmSync(p);
  db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
  db.close();

  return {
    dbPath: outPath,
    recordHash: hash,
    daily: record.daily.length,
    inbox: record.inbox.length,
    sessions: record.sessions.length,
  };
}

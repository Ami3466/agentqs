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

/** Minimal RFC-4180 CSV: quotes, escaped quotes, embedded commas/newlines. */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
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
    } else if (c === ",") {
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

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

function readSessions(dir: string): SessionItem[] {
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
    sessions: readSessions(dir),
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

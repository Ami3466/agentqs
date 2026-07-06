import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { recordDir as recordDirFor, vecPath } from "./paths";
import { autoIndexEnabled, embeddingEnabled, readConfig } from "./config";
import { readInboxFromRecord, readSessionsFromRecord, recordHash } from "./record";
import { blobToVector, cosine, vectorToBlob } from "./embed";
import { getTextEmbedder } from "./embedder";

/**
 * The semantic index (Batch C). sqlite-vec + a real LOCAL text-embedding model wired
 * into "find days that felt like this" — default-on, zero setup, no key, private.
 *
 * The record's free text (every inbox memo + every session synthesis) is embedded by
 * the local neural model (embedder.ts → all-MiniLM-L6-v2, hash fallback offline) and
 * stored as vectors so a query is matched by *meaning*, not keywords. Two backends
 * behind one API:
 *
 *   - sqlite-vec (default): the vectors live in a vec0 virtual table and KNN runs in
 *     SQLite. This is the "sqlite-vec embeddings" path from the plan.
 *   - a pure-JS cosine fallback: if the sqlite-vec loadable extension can't load on
 *     the host, the same vectors (also stored as BLOBs) are ranked in JS.
 *
 * The index is a SEPARATE derived file (paths.vecPath) from the byte-deterministic
 * main cache, and self-heals: it stamps the model id + record hash and rebuilds
 * whenever either changes (a new memo, a finished session, a model swap). FTS5 still
 * covers exact keyword recall; this covers "vibe". Server-only (fs + sqlite).
 */

// ---- Backend open ---------------------------------------------------------

interface VecDb {
  db: Database.Database;
  vec: boolean; // did the sqlite-vec extension load?
}

/** Open a vec-index connection, loading the sqlite-vec extension when available.
 *  Uses the default rollback journal (not WAL) so a build leaves no -wal/-shm
 *  sidecars to rename around. */
function openVec(file: string): VecDb {
  const db = new Database(file);
  let vec = false;
  try {
    sqliteVec.load(db);
    db.prepare("SELECT vec_version()").get();
    vec = true;
  } catch {
    vec = false; // fall back to JS cosine over the stored BLOBs
  }
  return { db, vec };
}

const ITEMS_DDL = `
CREATE TABLE IF NOT EXISTS items (
  rowid  INTEGER PRIMARY KEY,
  ref    TEXT NOT NULL,        -- inbox:<id> | session:<id>
  kind   TEXT NOT NULL,        -- memo | session
  date   TEXT NOT NULL,        -- ISO day the item belongs to
  text   TEXT NOT NULL,        -- the source text (for the snippet)
  vector BLOB NOT NULL         -- float32[dim], also kept for the JS fallback
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// ---- What gets indexed ----------------------------------------------------

export interface IndexItem {
  ref: string;
  kind: "memo" | "session";
  date: string;
  text: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Collect the record's free text into embeddable items, deterministically ordered
 *  so the index rebuilds identically. Memos + session synthesis (never raw daily
 *  numbers, which SQL already answers). */
export function collectItems(recordDir: string): IndexItem[] {
  const out: IndexItem[] = [];

  for (const it of readInboxFromRecord(recordDir)) {
    const text = it.text.trim();
    if (!text) continue;
    out.push({ ref: `inbox:${it.id}`, kind: "memo", date: (it.ts || "").slice(0, 10), text });
  }

  for (const s of readSessionsFromRecord(recordDir)) {
    const text = [s.title, s.summary, ...s.insights, ...s.commitments]
      .filter(Boolean)
      .join(". ")
      .trim();
    if (!text) continue;
    out.push({
      ref: `session:${s.id}`,
      kind: "session",
      date: s.date || (s.startedAt || "").slice(0, 10),
      text,
    });
  }

  out.sort((a, b) => cmp(a.date, b.date) || cmp(a.ref, b.ref));
  return out;
}

// ---- Build ----------------------------------------------------------------

export interface BuildResult {
  vecFile: string;
  count: number;
  backend: "sqlite-vec" | "js-cosine";
  model: string;
  recordHash: string;
}

/**
 * (Re)build the semantic index from the record. Writes to a temp file then renames
 * over the target so a crash mid-build can't leave a half-written index. Stamps the
 * model id + record hash so `ensureIndex` can tell when it's stale.
 */
export async function buildIndex(
  opts: { recordDir?: string; vecFile?: string } = {},
): Promise<BuildResult> {
  const rDir = opts.recordDir ?? recordDirFor();
  const target = opts.vecFile ?? vecPath();
  // Unique temp name so two concurrent first-run builds can't clobber each other.
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const items = collectItems(rDir);
  const hash = recordHash(rDir);
  const embedder = await getTextEmbedder();
  const vectors = await embedder.embed(items.map((it) => it.text));

  const { db, vec } = openVec(tmp);
  try {
    db.exec(ITEMS_DDL);
    if (vec) {
      db.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[${embedder.dim}])`);
    }
    const insItem = db.prepare(
      "INSERT INTO items (rowid, ref, kind, date, text, vector) VALUES (?,?,?,?,?,?)",
    );
    const insVec = vec ? db.prepare("INSERT INTO vec_items (rowid, embedding) VALUES (?,?)") : null;

    const insertAll = db.transaction((rows: IndexItem[]) => {
      rows.forEach((it, i) => {
        const blob = vectorToBlob(vectors[i]);
        insItem.run(i, it.ref, it.kind, it.date, it.text, blob);
        insVec?.run(BigInt(i), blob);
      });
      const setMeta = db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)");
      setMeta.run("model", embedder.id);
      setMeta.run("dim", String(embedder.dim));
      setMeta.run("record_hash", hash);
      setMeta.run("count", String(rows.length));
      setMeta.run("backend", vec ? "sqlite-vec" : "js-cosine");
    });
    insertAll(items);
  } finally {
    db.close();
  }

  // renameSync atomically replaces target on POSIX; clear any legacy WAL sidecars.
  for (const p of [`${target}-wal`, `${target}-shm`]) if (fs.existsSync(p)) fs.rmSync(p);
  fs.renameSync(tmp, target);

  return {
    vecFile: target,
    count: items.length,
    backend: vec ? "sqlite-vec" : "js-cosine",
    model: embedder.id,
    recordHash: hash,
  };
}

// ---- Status + ensure ------------------------------------------------------

export interface IndexStatus {
  built: boolean;
  count: number;
  stale: boolean; // record changed or model swapped since the last build
  model: string;
  backend: "sqlite-vec" | "js-cosine" | null;
}

function readMeta(file: string): Record<string, string> | null {
  if (!fs.existsSync(file)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Is the index present, and does it match the current record + model? */
export async function indexStatus(
  opts: { recordDir?: string; vecFile?: string } = {},
): Promise<IndexStatus> {
  const rDir = opts.recordDir ?? recordDirFor();
  const file = opts.vecFile ?? vecPath();
  const modelId = (await getTextEmbedder()).id;
  const meta = readMeta(file);
  if (!meta) return { built: false, count: 0, stale: true, model: modelId, backend: null };
  const stale = meta.model !== modelId || meta.record_hash !== recordHash(rDir);
  return {
    built: true,
    count: Number(meta.count ?? 0),
    stale,
    model: meta.model ?? modelId,
    backend: (meta.backend as IndexStatus["backend"]) ?? null,
  };
}

/** Build the index on first use and whenever the record/model changes. This is the
 *  "default-on, background-index on first run" behaviour — callers just call it.
 *  Settings can turn auto-indexing off; then only an explicit `buildIndex` (the
 *  "Reindex now" button / CLI) refreshes the index. */
export async function ensureIndex(
  opts: { recordDir?: string; vecFile?: string } = {},
): Promise<BuildResult | null> {
  if (!autoIndexEnabled(readConfig())) return null;
  const status = await indexStatus(opts);
  if (status.built && !status.stale) return null;
  return buildIndex(opts);
}

// ---- Search ---------------------------------------------------------------

export interface SemanticHit {
  ref: string;
  kind: "memo" | "session";
  date: string;
  snippet: string;
  score: number; // cosine similarity in [0,1]-ish (higher = closer)
}

function snippetOf(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

export interface SearchOptions {
  recordDir?: string;
  vecFile?: string;
  limit?: number; // distinct days returned (default 5)
  ensure?: boolean; // (re)build the index first if missing/stale (default true)
  minScore?: number; // drop weak matches (default 0.05)
}

/**
 * Semantic search over the record: embed the query, find the nearest memos/sessions,
 * and collapse them to the best-matching *days* (one hit per date). Runs with NO AI
 * key — the local model + sqlite-vec do all the work. Returns [] when the record has
 * no embeddable text yet.
 */
export async function semanticSearch(query: string, opts: SearchOptions = {}): Promise<SemanticHit[]> {
  const q = query.trim();
  if (!q) return [];
  // Settings kill-switch: embeddings off → no vectors, callers fall back to keywords.
  if (!embeddingEnabled(readConfig())) return [];
  const file = opts.vecFile ?? vecPath();
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 25));
  const minScore = opts.minScore ?? 0.05;

  if (opts.ensure !== false) await ensureIndex({ recordDir: opts.recordDir, vecFile: file });
  if (!fs.existsSync(file)) return [];

  const embedder = await getTextEmbedder();
  const qvec = (await embedder.embed([q]))[0];
  if (!qvec || qvec.every((x) => x === 0)) return [];

  const candidates = limit * 8;
  const { db, vec } = openVec(file);
  let raw: { ref: string; kind: string; date: string; text: string; score: number }[] = [];
  try {
    if (vec) {
      // vec0 KNN requires the neighbour count as a literal `LIMIT` or a `k = ?`
      // constraint (a bound LIMIT isn't accepted) — do the search in a CTE, then join.
      const rows = db
        .prepare(
          `WITH knn AS (
             SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? AND k = ?
           )
           SELECT i.ref AS ref, i.kind AS kind, i.date AS date, i.text AS text, knn.distance AS distance
           FROM knn JOIN items i ON i.rowid = knn.rowid
           ORDER BY knn.distance`,
        )
        .all(vectorToBlob(qvec), candidates) as {
        ref: string;
        kind: string;
        date: string;
        text: string;
        distance: number;
      }[];
      // Unit vectors → L2² = 2 - 2·cos, so cos = 1 - d²/2.
      raw = rows.map((r) => ({ ...r, score: 1 - (r.distance * r.distance) / 2 }));
    } else {
      const rows = db.prepare("SELECT ref, kind, date, text, vector FROM items").all() as {
        ref: string;
        kind: string;
        date: string;
        text: string;
        vector: Buffer;
      }[];
      raw = rows
        .map((r) => ({
          ref: r.ref,
          kind: r.kind,
          date: r.date,
          text: r.text,
          score: cosine(qvec, blobToVector(r.vector)),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, candidates);
    }
  } finally {
    db.close();
  }

  // Collapse to the best hit per day — "days that felt like this".
  const byDay = new Map<string, { ref: string; kind: string; date: string; text: string; score: number }>();
  for (const r of raw) {
    if (r.score < minScore) continue;
    const prev = byDay.get(r.date);
    if (!prev || r.score > prev.score) byDay.set(r.date, r);
  }

  return [...byDay.values()]
    .sort((a, b) => b.score - a.score || cmp(b.date, a.date))
    .slice(0, limit)
    .map((r) => ({
      ref: r.ref,
      kind: r.kind as "memo" | "session",
      date: r.date,
      snippet: snippetOf(r.text),
      score: Math.round(Math.max(0, r.score) * 1000) / 1000,
    }));
}

// ---- Recall orchestration (the "find days that felt like this" answer) ----

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
// Low-signal words in a recall query (the ask, not the feeling) — stripped when we
// decide whether the query has enough content of its own.
const RECALL_STOP = new Set([
  "find", "show", "list", "search", "me", "my", "the", "a", "an", "other", "similar",
  "day", "days", "time", "times", "moment", "moments", "that", "this", "these", "those",
  "felt", "feel", "feels", "feeling", "like", "when", "did", "have", "i", "was", "were",
  "to", "of", "for", "about", "and", "or", "remind", "reminds", "reminded", "same", "way",
]);

/** The text to actually embed for a recall query: drop the "find days that felt like…"
 *  framing, and if what's left is too thin (e.g. a bare "find days that felt like this"
 *  that leans on context), fall back to the previous user turn. */
export function recallQueryText(
  message: string,
  history?: { role: string; content: string }[],
): string {
  const stripped = message
    .replace(/^[^:—-]*(:|—|-)\s*/, (m) => (/(felt|feel|like|days?|similar|find)/i.test(m) ? "" : m))
    .trim();
  const base = stripped || message;
  const content = (base.toLowerCase().match(TOKEN_RE) ?? []).filter((w) => !RECALL_STOP.has(w));
  if (content.length >= 2) return base;

  // Thin query → borrow the most recent user turn for the "this" it refers to.
  const priorUser = [...(history ?? [])].reverse().find((m) => m.role === "user");
  if (priorUser?.content && priorUser.content.trim() !== message.trim()) {
    return `${base} ${priorUser.content}`.trim();
  }
  return base;
}

export interface RecallAnswer {
  text: string;
  hits: SemanticHit[];
  sources: string[]; // "memos" / "sessions" — for the grounded badge
  query: string;
}

/** Human-readable date, e.g. "Jun 4, 2026". Falls back to the raw string. */
function niceDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Answer a semantic-recall message ("find days that felt like this") entirely from the
 * local index — no AI key. Returns null when there's nothing embeddable yet or no
 * match cleared the bar, so the caller can fall through to its other paths.
 */
export async function answerRecall(
  message: string,
  history?: { role: string; content: string }[],
  opts: SearchOptions = {},
): Promise<RecallAnswer | null> {
  const query = recallQueryText(message, history);
  const hits = await semanticSearch(query, { ...opts, limit: opts.limit ?? 5 });
  if (!hits.length) return null;

  const kinds = new Set(hits.map((h) => (h.kind === "session" ? "sessions" : "memos")));
  const lines = hits.map((h) => `- ${niceDate(h.date)} — "${h.snippet}"`);
  const text =
    `Days that felt like that, closest first:\n${lines.join("\n")}\n\n` +
    `Matched by meaning against your ${[...kinds].join(" and ")} — not just keywords.`;
  return { text, hits, sources: [...kinds].sort(), query };
}

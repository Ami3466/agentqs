import path from "path";

/**
 * Resolved data directory where agentqs writes config, the git record, and the
 * SQLite cache. Local default: ./data · Docker default: /data (set in the image).
 */
export function dataDir(): string {
  const dir = process.env.AGENTQS_DATA_DIR || path.join(process.cwd(), "data");
  return path.resolve(dir);
}

export function configPath(dir: string = dataDir()): string {
  return path.join(dir, "config.json");
}

/**
 * The git record — plain-text source of truth. Committed to the user's private
 * repo. Everything under here rebuilds the SQLite cache.
 *   record/daily/<source>.csv  · record/inbox.jsonl  · record/sessions.jsonl
 */
export function recordDir(dir: string = dataDir()): string {
  return path.join(dir, "record");
}

/** The derived SQLite cache. Rebuildable from the record; never committed. */
export function dbPath(dir: string = dataDir()): string {
  return path.join(dir, "agentqs.db");
}

/**
 * The local semantic index — sqlite-vec embeddings over the record's free text
 * (memos + session synthesis). A SEPARATE derived file from the main cache on
 * purpose: the main cache is byte-deterministic (rebuild:verify asserts it), so the
 * embedding store is kept out of that guarantee. Rebuildable from the record; never
 * committed.
 */
export function vecPath(dir: string = dataDir()): string {
  return path.join(dir, "agentqs-vec.db");
}

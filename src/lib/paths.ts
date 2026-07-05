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

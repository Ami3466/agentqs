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

/**
 * Photo thumbnails — small derived previews (sharp → webp), keyed by photo id. Live
 * under the data dir (gitignored): the ORIGINALS never leave the machine, and even
 * these thumbnails stay out of git/cloud. The committed part is only the metadata in
 * record/photos.jsonl.
 */
export function photoThumbDir(dir: string = dataDir()): string {
  return path.join(dir, "photos", "thumbs");
}

/**
 * The photo semantic index — CLIP image embeddings in sqlite-vec for text→image
 * recall. A SEPARATE derived file from the text index and the main cache; never
 * committed, rebuildable from the thumbnails + record.
 */
export function photoVecPath(dir: string = dataDir()): string {
  return path.join(dir, "agentqs-photos-vec.db");
}

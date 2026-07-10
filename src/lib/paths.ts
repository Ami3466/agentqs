import path from "path";
import fs from "fs";
import os from "os";

/** How much of a store a dir holds: 2 = has the record, 1 = only a config,
 *  0 = not a store. A bare directory (leftover mkdir, sync artifact) is NOT a store. */
export function storeRank(dir: string): number {
  if (fs.existsSync(path.join(dir, "record"))) return 2;
  if (fs.existsSync(path.join(dir, "config.json"))) return 1;
  return 0;
}

/**
 * The platform app-data location — the default home for the store. Chosen
 * because no file-sync engine (iCloud Desktop & Documents, Dropbox, OneDrive,
 * Google Drive) ever manages it: sync engines evict file contents, rename
 * conflicting files to "X 2" and resurrect deleted dirs from cloud state, any
 * of which silently corrupts or splits a store that lives in their domain.
 * Multi-device sync of the record goes through its own git repo instead.
 */
export function defaultStoreDir(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "agentqs");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "agentqs");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "agentqs");
}

/**
 * Resolved data directory where agentqs writes config, the git record, and the
 * SQLite cache. Resolution order:
 *   1. AGENTQS_DATA_DIR (Docker sets /data in the image)
 *   2. the app-data store (defaultStoreDir) once initialized
 *   3. legacy checkout-local stores: ./data.nosync, then ./data
 *   4. nothing initialized anywhere -> defaultStoreDir (new installs land safe)
 * Within 2-3 the dir holding MORE of a store wins (a record outranks a lone
 * config, which outranks a bare dir) and earlier candidates win ties — so a
 * sync-engine artifact ./data (empty, or a resurrected stale snapshot) can
 * never shadow the real store, or every face of the app silently splits
 * across two stores. ./data.nosync outranks ./data on ties for the same
 * reason: it only ever exists as the iCloud escape hatch, and iCloud is
 * exactly what resurrects stale ./data snapshots.
 */
let warnedShadow = false;

export function dataDir(): string {
  if (process.env.AGENTQS_DATA_DIR) return path.resolve(process.env.AGENTQS_DATA_DIR);
  const candidates = [defaultStoreDir(), path.join(process.cwd(), "data.nosync"), path.join(process.cwd(), "data")];
  let best = "";
  let bestRank = 0;
  for (const dir of candidates) {
    const rank = storeRank(dir);
    if (rank > bestRank) {
      best = dir;
      bestRank = rank;
    }
  }
  if (!best) return defaultStoreDir();
  const shadowed = candidates.find((dir) => dir !== best && storeRank(dir) > 0 && !sameStore(dir, best));
  if (shadowed && !warnedShadow) {
    warnedShadow = true;
    console.warn(`agentqs: ignoring store at ${shadowed} (sync-engine artifact?) in favor of ${best}`);
  }
  return path.resolve(best);
}

function sameStore(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
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
 * The detail store — every point behind the daily rollups. Streams too dense for
 * the one-row-per-day record (per-minute heart rate, every browser visit) live
 * here as plain SQL tables, attached read-only under the `detail` schema so chat
 * and `agentqs query` can correlate them at full grain. `heart_rate` is derived
 * (rebuilt from record/whoop/hr/*.csv on every rebuild); other tables (e.g.
 * chrome_visits) are landed directly by their importers. Never committed.
 * Files named hires.db predate the rename and keep working as-is.
 */
export function detailPath(dir: string = dataDir()): string {
  const preferred = path.join(dir, "detail.db");
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(dir, "hires.db");
  return fs.existsSync(legacy) ? legacy : preferred;
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

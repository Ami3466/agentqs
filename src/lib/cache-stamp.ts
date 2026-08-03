import fs from "fs";
import path from "path";

/**
 * The one fingerprint of the derived SQLite cache — size + mtime of the file and
 * its WAL sidecar. Every read view (coverage, journal, sources, pipeline) is a
 * PURE function of that file, so an unchanged stamp means an unchanged answer.
 *
 * Two things ride on it: the in-process memos that stop a tab switch re-running a
 * quarter-million-row pivot, and the HTTP ETag that lets the browser skip the
 * body entirely (a 15 MB journal payload becomes a 304 with no work on either
 * side). Both must derive it the SAME way, or a cached page and a memoized
 * report could disagree about whether the record moved.
 */
export function cacheStamp(file: string): string {
  return `${fileStamp(file)}|${fileStamp(`${file}-wal`)}`;
}

/** size:mtime of one file, or "-" when it isn't there. The atom every stamp below
 *  is built from.
 *
 *  Nanosecond mtime, not millisecond: an ETag has no expiry of its own, so two
 *  writes that landed in the same millisecond at the same byte length would hand
 *  the client a 304 for data that HAD changed, and it would stay wrong until the
 *  next write. Filesystems record ns; there is no reason to throw it away. */
export function fileStamp(file: string): string {
  try {
    const st = fs.statSync(file, { bigint: true });
    return `${st.size}:${st.mtimeNs}`;
  } catch {
    return "-";
  }
}

/** ETag for a read view: the cache fingerprint plus whatever else shapes the
 *  payload (the window, the day it was asked on). Weak, because the JSON is
 *  semantically — not byte — identical across processes. */
export function viewEtag(file: string, ...parts: Array<string | number | boolean>): string {
  return `W/"${cacheStamp(file)}|${parts.join("|")}"`;
}

/**
 * Fingerprint of the LIVE store state beside the cache — the config (credentials,
 * schedules, saved views) and the sync ledgers.
 *
 * The Pipeline and Sources views answer "what is connected, when did it last run,
 * is it due?", which moves without a single row of the record changing. Stamping
 * those views on the cache alone would hand back a 304 while a sync visibly
 * progressed, and the tab would read as frozen. This is the extra input that keeps
 * their ETags honest.
 */
export function storeStamp(dataDir: string): string {
  return ["config.json", "sync-runs.json", "sync-jobs.json"]
    .map((name) => fileStamp(path.join(dataDir, name)))
    .join(",");
}

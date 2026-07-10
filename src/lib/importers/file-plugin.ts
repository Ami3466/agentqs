import fs from "fs";
import os from "os";
import path from "path";
import { mergeDailyCsv, type DailyMergeResult } from "../record";
import { recordDir } from "../paths";
import type { DailyTable } from "./plugin";

/**
 * File-importer plugins — the Tier-2 sibling of the API plugin contract
 * (./plugin.ts). Where an API source has a `credential → fetch a window`, a file
 * source reads a local file on *your* machine (a Chrome History SQLite, an iPhone
 * backup) that a remote/Docker instance can't reach. Everything downstream is the
 * same record contract:
 *
 *   local file → read a window → normalize into a wide daily table
 *   → merge into record/daily/<id>.csv → rebuild.
 *
 * The write is the same idempotent `mergeDailyCsv`, so a file source lands in the
 * exact same daily table the mentor reasons over. Because the reader touches the
 * local filesystem it runs from the CLI / local daemon, never from the server —
 * the record it produces reaches a cloud replica through git (the sync layer).
 */

export interface FileImportContext {
  path: string; // local file (or backup dir) to read
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
}

export interface FileImportResult {
  table: DailyTable;
  meta?: Record<string, unknown>;
}

export interface FileImporter {
  id: string; // source stem → record/daily/<id>.csv
  name: string; // display name
  detail: string; // one-line description for the Pipeline tab / CLI
  /** false = stub adapter (real read path, but not the full extraction yet). */
  live: boolean;
  /** The metric column the Pipeline-tab headline / sparkline reads. */
  primaryMetric: string;
  unit?: string;
  /** Default OS locations to probe when `--path` is omitted (platform-aware). */
  defaultPaths(): string[];
  /** Read the local file and normalize a window into the wide daily table. */
  read(ctx: FileImportContext): Promise<FileImportResult>;
}

export interface FileImportSummary extends DailyMergeResult {
  id: string;
  name: string;
  path: string;
  from: string;
  to: string;
  daysWithData: number;
  meta?: Record<string, unknown>;
}

/**
 * Run one file importer end to end: read → normalize → merge into
 * record/daily/<id>.csv. Rebuilding the SQLite cache is the caller's job (CLI /
 * daemon), exactly like the API plugins.
 */
export async function importFile(
  importer: FileImporter,
  ctx: FileImportContext,
  dir: string = recordDir(),
): Promise<FileImportSummary> {
  const result = await importer.read(ctx);
  const merge = mergeDailyCsv(dir, importer.id, result.table);
  return {
    ...merge,
    id: importer.id,
    name: importer.name,
    path: ctx.path,
    from: ctx.from,
    to: ctx.to,
    daysWithData: merge.dates.length,
    meta: result.meta,
  };
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve which local file to read: an explicit `--path` wins (expanded, must
 * exist); otherwise probe the importer's platform default locations and take the
 * first that exists. Returns null when nothing is found so the caller can print
 * the probed paths.
 */
export function resolveFilePath(importer: FileImporter, explicit?: string): string | null {
  if (explicit && explicit.trim()) {
    const p = path.resolve(expandHome(explicit.trim()));
    return fs.existsSync(p) ? p : null;
  }
  for (const cand of importer.defaultPaths()) {
    const p = expandHome(cand);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

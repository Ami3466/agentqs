import fs from "fs";
import path from "path";
import { dataDir } from "./paths";

/**
 * Sync-run health ledger — the missing truth signal of the data pipeline.
 *
 * Every sync attempt (manual, Data-tab lazy sync, `sync --due` from a
 * scheduler) records its outcome here, success AND failure, so "is this
 * automation actually working" is answerable from the CLI, the API and the
 * Data tab instead of failures vanishing into a launchd log nobody reads.
 *
 * Derived state under the data dir (never part of the record): losing it only
 * loses run history, and a corrupt file degrades to "no history".
 */

export interface SyncRunRecord {
  at: string; // ISO time of the attempt
  ok: boolean;
  error?: string; // first line of the failure, for row display
}

export interface SyncRunsState {
  runs: Record<string, SyncRunRecord>; // per source id — most recent attempt
  /** Last `sync --due` sweep (the scheduler heartbeat), regardless of results. */
  dueRunAt?: string;
}

export function syncRunsFile(dir: string = dataDir()): string {
  return path.join(dir, "sync-runs.json");
}

export function readSyncRuns(dir: string = dataDir()): SyncRunsState {
  try {
    const raw = JSON.parse(fs.readFileSync(syncRunsFile(dir), "utf8")) as SyncRunsState;
    return { runs: raw.runs && typeof raw.runs === "object" ? raw.runs : {}, dueRunAt: raw.dueRunAt };
  } catch {
    return { runs: {} };
  }
}

function writeSyncRuns(state: SyncRunsState, dir: string = dataDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(syncRunsFile(dir), JSON.stringify(state, null, 2));
  } catch {
    /* the ledger is best-effort — a read-only disk must never fail a sync */
  }
}

export function recordSyncRun(id: string, ok: boolean, error?: string, dir: string = dataDir()): void {
  const state = readSyncRuns(dir);
  state.runs[id] = {
    at: new Date().toISOString(),
    ok,
    ...(error ? { error: error.split("\n")[0].slice(0, 300) } : {}),
  };
  writeSyncRuns(state, dir);
}

/** Stamp the scheduler heartbeat — proves `sync --due` sweeps are reaching us. */
export function recordDueRun(dir: string = dataDir()): void {
  const state = readSyncRuns(dir);
  state.dueRunAt = new Date().toISOString();
  writeSyncRuns(state, dir);
}

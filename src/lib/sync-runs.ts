import fs from "fs";
import path from "path";
import { dataDir } from "./paths";

/**
 * Sync-run health ledger — the missing truth signal of the data pipeline.
 *
 * Every sync attempt (manual, Pipeline-tab lazy sync, `sync --due` from a
 * scheduler) records its outcome here, success AND failure, so "is this
 * automation actually working" is answerable from the CLI, the API and the
 * Pipeline tab instead of failures vanishing into a launchd log nobody reads.
 *
 * Derived state under the data dir (never part of the record): losing it only
 * loses run history, and a corrupt file degrades to "no history".
 */

export interface SyncRunRecord {
  at: string; // ISO time of the attempt
  ok: boolean;
  error?: string; // first line of the failure, for row display
}

/**
 * DID THE FIRST IMPORT ACTUALLY FINISH?
 *
 * "Is this a first import?" used to mean "is the record empty?" — and a backfill merges
 * each year as it lands. So a twelve-year walk that died on chunk 2 (a blip, a 429) left
 * last year's rows behind, and the NEXT sync saw rows, concluded the history was already
 * imported, topped up the last 7 days and reported ok. The other eleven years were never
 * fetched again by any code path: an interrupted backfill was indistinguishable from a
 * finished one.
 *
 * So the walk writes down where it got to. `cursor` = how far back so far; `done` = it
 * reached the floor. Derived state, like the rest of this ledger: losing it only costs a
 * re-walk (which is idempotent), never data.
 */
export interface BackfillState {
  cursor?: string; // ISO date the walk has reached
  done?: boolean; // the walk reached the floor — the history is all in
  at?: string; // when it finished
}

export interface SyncRunsState {
  runs: Record<string, SyncRunRecord>; // per source id — most recent attempt
  /** Last `sync --due` sweep (the scheduler heartbeat), regardless of results. */
  dueRunAt?: string;
  /** Per source id — how far its history walk has got. See BackfillState. */
  backfill?: Record<string, BackfillState>;
}

export function syncRunsFile(dir: string = dataDir()): string {
  return path.join(dir, "sync-runs.json");
}

export function readSyncRuns(dir: string = dataDir()): SyncRunsState {
  try {
    const raw = JSON.parse(fs.readFileSync(syncRunsFile(dir), "utf8")) as SyncRunsState;
    return {
      runs: raw.runs && typeof raw.runs === "object" ? raw.runs : {},
      dueRunAt: raw.dueRunAt,
      backfill: raw.backfill && typeof raw.backfill === "object" ? raw.backfill : {},
    };
  } catch {
    return { runs: {}, backfill: {} };
  }
}

/** How far this source's history walk has got. */
export function readBackfillState(id: string, dir: string = dataDir()): BackfillState {
  return readSyncRuns(dir).backfill?.[id] ?? {};
}

export function writeBackfillState(id: string, state: BackfillState, dir: string = dataDir()): void {
  const s = readSyncRuns(dir);
  const prev = s.backfill?.[id] ?? {};
  writeSyncRuns({ ...s, backfill: { ...(s.backfill ?? {}), [id]: { ...prev, ...state } } }, dir);
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

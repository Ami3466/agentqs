import fs from "fs";
import path from "path";
import { dataDir } from "./paths";

/**
 * Background sync jobs — imports run server-side, not inside one HTTP request,
 * so closing or refreshing the page never kills an import and every surface
 * (UI poll, pipeline, CLI) reads the same live progress.
 *
 * One job per source at a time; jobs across sources run through a single
 * serial queue so concurrent rebuilds never race the record. State lives in
 * `<dataDir>/sync-jobs.json` (derived, never part of the record): the LAST job
 * per source, running ones included. A `running`/`queued` job whose heartbeat
 * went silent (server restarted mid-sync) reads back as an error — a job may
 * never look "running" forever.
 */

export type SyncJobStatus = "queued" | "running" | "ok" | "error";

export interface SyncJob {
  id: string; // source id
  status: SyncJobStatus;
  phase: string; // human phase label ("fetching your data")
  pct: number; // 0..100 — determinate progress for the UI bar
  startedAt: string;
  updatedAt: string; // heartbeat — a silent running job is an interrupted one
  finishedAt?: string;
  error?: string;
  days?: number; // summary on ok
  dailyRows?: number;
}

/** Summary a job runner resolves with — shown in the row when the bar completes. */
export interface SyncJobSummary {
  days?: number;
  dailyRows?: number;
}

export type JobProgress = (phase: string, pct: number) => void;

interface JobsFile {
  jobs: Record<string, SyncJob>;
}

const HEARTBEAT_MS = 20_000;
const STALE_MS = 120_000; // heartbeat silent this long → the server died mid-job

function jobsFile(dir: string): string {
  return path.join(dir, "sync-jobs.json");
}

function readFile(dir: string): JobsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(jobsFile(dir), "utf8")) as JobsFile;
    return { jobs: raw.jobs && typeof raw.jobs === "object" ? raw.jobs : {} };
  } catch {
    return { jobs: {} };
  }
}

function writeFile(state: JobsFile, dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(jobsFile(dir), JSON.stringify(state, null, 2));
  } catch {
    /* best-effort, like the sync-run ledger — a read-only disk must not fail a sync */
  }
}

function isActive(job: SyncJob | null | undefined): job is SyncJob {
  return Boolean(job && (job.status === "queued" || job.status === "running"));
}

function markInterruptedIfStale(job: SyncJob): SyncJob {
  if (!isActive(job)) return job;
  const beat = new Date(job.updatedAt).getTime();
  if (Number.isFinite(beat) && Date.now() - beat < STALE_MS) return job;
  return {
    ...job,
    status: "error",
    finishedAt: new Date().toISOString(),
    error: "Interrupted — the app restarted mid-sync. Run it again.",
  };
}

/** All last-known jobs, stale running ones surfaced as interrupted errors. */
export function readSyncJobs(dir: string = dataDir()): Record<string, SyncJob> {
  const state = readFile(dir);
  let dirty = false;
  for (const [id, job] of Object.entries(state.jobs)) {
    const fixed = markInterruptedIfStale(job);
    if (fixed !== job) {
      state.jobs[id] = fixed;
      dirty = true;
    }
  }
  if (dirty) writeFile(state, dir);
  return state.jobs;
}

export function readSyncJob(id: string, dir: string = dataDir()): SyncJob | null {
  return readSyncJobs(dir)[id] ?? null;
}

/** Land the outcome of a sync that did NOT come from this queue — the scheduler
 *  (`sync --due`), the CLI, MCP. The Pipeline row renders the JOB, so without
 *  this a web sync that failed once stays on screen as "failed" forever, even
 *  after the nightly scheduler synced the source successfully. A job the queue
 *  owns (queued/running) is never touched. */
export function noteSyncOutcome(
  id: string,
  ok: boolean,
  error?: string,
  summary: SyncJobSummary = {},
  dir: string = dataDir(),
): void {
  if (isActive(readSyncJob(id, dir))) return; // the queue is running it; it writes the outcome
  const at = new Date().toISOString();
  patchJob(dir, id, {
    status: ok ? "ok" : "error",
    phase: ok ? "synced" : "failed",
    pct: 100,
    startedAt: at,
    finishedAt: at,
    error: ok ? undefined : error,
    ...summary,
  });
}

function patchJob(dir: string, id: string, patch: Partial<SyncJob>): SyncJob {
  const state = readFile(dir);
  const next: SyncJob = {
    ...(state.jobs[id] ?? {
      id,
      status: "queued",
      phase: "queued",
      pct: 0,
      startedAt: new Date().toISOString(),
    }),
    ...patch,
    updatedAt: new Date().toISOString(),
  } as SyncJob;
  state.jobs[id] = next;
  writeFile(state, dir);
  return next;
}

/** Bump every active job's heartbeat — the runner calls this on an interval so
 *  a long fetch (or a job queued behind one) never reads as interrupted. */
function heartbeat(dir: string): void {
  const state = readFile(dir);
  let dirty = false;
  const now = new Date().toISOString();
  for (const job of Object.values(state.jobs)) {
    if (isActive(job)) {
      job.updatedAt = now;
      dirty = true;
    }
  }
  if (dirty) writeFile(state, dir);
}

// The live queue survives Next.js dev HMR via globalThis; the FILE is the truth
// every reader (route poll, pipeline, CLI) uses — the queue only orders work.
interface JobsRuntime {
  chain: Promise<void>;
  beat: ReturnType<typeof setInterval> | null;
  active: number;
}

function runtime(): JobsRuntime {
  const g = globalThis as { __agentqsSyncJobs?: JobsRuntime };
  g.__agentqsSyncJobs ??= { chain: Promise.resolve(), beat: null, active: 0 };
  return g.__agentqsSyncJobs;
}

/**
 * Start (or join) a background sync for `id`. If a job for this source is
 * already queued/running, returns it instead of starting a second one.
 * `run` receives a progress callback and resolves with the summary; its
 * outcome lands in the job file — the caller does NOT await the work.
 */
export function startSyncJob(
  id: string,
  run: (progress: JobProgress) => Promise<SyncJobSummary>,
  dir: string = dataDir(),
): SyncJob {
  const existing = readSyncJob(id, dir);
  if (isActive(existing)) return existing;

  const job = patchJob(dir, id, {
    id,
    status: "queued",
    phase: "waiting for its turn",
    pct: 0,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    error: undefined,
    days: undefined,
    dailyRows: undefined,
  });

  const rt = runtime();
  rt.active += 1;
  rt.beat ??= setInterval(() => heartbeat(dir), HEARTBEAT_MS);
  rt.chain = rt.chain.then(async () => {
    patchJob(dir, id, { status: "running", phase: "starting", pct: 5 });
    try {
      const summary = await run((phase, pct) => {
        patchJob(dir, id, { phase, pct: Math.max(0, Math.min(99, Math.round(pct))) });
      });
      patchJob(dir, id, {
        status: "ok",
        phase: "done",
        pct: 100,
        finishedAt: new Date().toISOString(),
        days: summary.days,
        dailyRows: summary.dailyRows,
      });
    } catch (e) {
      patchJob(dir, id, {
        status: "error",
        phase: "failed",
        pct: 100,
        finishedAt: new Date().toISOString(),
        error: ((e as Error).message || "Sync failed.").split("\n")[0].slice(0, 300),
      });
    } finally {
      rt.active -= 1;
      if (rt.active <= 0 && rt.beat) {
        clearInterval(rt.beat);
        rt.beat = null;
        rt.active = 0;
      }
    }
  });
  return job;
}

/** Await the queue draining — tests and the CLI use this; routes never do. */
export async function waitForSyncJobs(): Promise<void> {
  await runtime().chain;
}

import { ingestServerActive } from "./ingest-server";

/**
 * In-process sync scheduler — the app fulfills its own "hourly/daily/weekly"
 * promise while the server runs, instead of depending on a hand-written
 * crontab/launchd line on every machine (the external dependency that fails
 * silently). `sync --due` stays as the headless-mode equivalent; both paths run
 * the same syncDue(), so cadence, skipping and the run ledger are identical.
 *
 * Singleton per machine: only the process that owns the ingest listener port
 * runs sweeps, so two dev servers never double-sync. Every sweep stamps the
 * heartbeat (sync-runs.ts) the pipeline report shows.
 */

// Sweep frequency ≠ sync frequency: each sweep only runs sources whose OWN
// interval says they're due, so frequent sweeps are cheap (a config+fs read).
const SWEEP_EVERY_MS = 15 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 60 * 1000; // let the server settle before syncing

let timer: NodeJS.Timeout | null = null;

async function sweep(): Promise<void> {
  if (!ingestServerActive()) return; // another agentqs process owns scheduling
  try {
    const { syncDue } = await import("./sync-due");
    const r = await syncDue();
    if (r.due > 0) {
      console.log(
        `agentqs scheduler: ${r.synced.length} synced, ${r.failed.length} failed` +
          (r.failed.length ? ` (${r.failed.map((f) => f.id).join(", ")} — see Pipeline tab / agentqs pipeline)` : ""),
      );
    }
  } catch (e) {
    console.warn(`agentqs scheduler sweep failed: ${(e as Error).message}`);
  }
  // Outbound daily nudges ("how was your day?") ride the same sweep, isolated so a
  // channel outage never stalls the sync sweep above.
  try {
    const { sweepNudges } = await import("./nudges");
    const n = await sweepNudges();
    if (n.sent.length || n.failed.length) {
      console.log(
        `agentqs nudges: ${n.sent.length} sent` +
          (n.failed.length ? `, ${n.failed.length} failed (${n.failed.map((f) => f.id).join(", ")})` : ""),
      );
    }
  } catch (e) {
    console.warn(`agentqs nudge sweep failed: ${(e as Error).message}`);
  }
}

/** Idempotent; called from instrumentation.ts once per server process. */
export function startSyncScheduler(): void {
  if (timer) return;
  if (process.env.AGENTQS_NO_SCHEDULER === "1") return; // explicit off-switch
  const first = setTimeout(() => {
    void sweep();
    timer = setInterval(() => void sweep(), SWEEP_EVERY_MS);
    timer.unref();
  }, FIRST_SWEEP_DELAY_MS);
  first.unref(); // never hold a shutting-down process open
  timer = first;
}

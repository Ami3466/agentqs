/** Next instrumentation hook — runs once per server process (dev AND start).
 *  Boots the standalone ingest listener (extension imports survive dev
 *  recompiles) and the in-process sync scheduler (source intervals work with
 *  ZERO external cron/launchd setup while the app runs). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startIngestServer } = await import("./lib/ingest-server");
    startIngestServer();
    const { startSyncScheduler } = await import("./lib/scheduler");
    startSyncScheduler();
  }
}

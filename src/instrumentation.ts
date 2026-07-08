/** Next instrumentation hook — runs once per server process (dev AND start).
 *  Boots the standalone ingest listener so extension imports survive dev
 *  recompiles; see src/lib/ingest-server.ts for the why. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startIngestServer } = await import("./lib/ingest-server");
    startIngestServer();
  }
}

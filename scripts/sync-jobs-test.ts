#!/usr/bin/env tsx
/**
 * Background sync jobs — the machinery that lets an import survive a page
 * refresh: jobs persist to <dataDir>/sync-jobs.json, run through one serial
 * queue, report live phase/percent, land success AND failure, and a job whose
 * heartbeat went silent (server died mid-sync) reads back as interrupted.
 * Also drives a REAL sync (rescuetime fixture) through startSyncJob →
 * cli-core.syncSource to prove the route wiring records progress + the run
 * ledger. Deterministic, temp data dir, no network. Run: npm run jobs:test
 */
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-jobs-"));
process.env.AGENTQS_DATA_DIR = root;

import Database from "better-sqlite3";
import { noteSyncOutcome, readSyncJobs, startSyncJob, waitForSyncJobs } from "../src/lib/sync-jobs";
import { readSyncRuns } from "../src/lib/sync-runs";
import { syncSource } from "../src/lib/cli-core";
import { parseCsv, rebuild } from "../src/lib/record";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\nSync jobs — background imports that survive refreshes\n");

  // 1. A job runs to completion, phases + summary persisted to disk.
  const phases: string[] = [];
  startSyncJob("alpha", async (progress) => {
    progress("fetching", 20);
    phases.push("fetching");
    await sleep(20);
    progress("merging", 80);
    phases.push("merging");
    return { days: 7, dailyRows: 42 };
  });
  const live = readSyncJobs()[ "alpha"];
  check("job visible on disk immediately", Boolean(live), live?.status);
  await waitForSyncJobs();
  const done = readSyncJobs()["alpha"];
  check("job lands ok with summary", done?.status === "ok" && done.days === 7 && done.dailyRows === 42,
    `${done?.status} days=${done?.days}`);
  check("phases reported in order", phases.join(",") === "fetching,merging", phases.join(","));

  // 2. Dedup: a second start while running returns the SAME job.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const first = startSyncJob("beta", async () => {
    await gate;
    return { days: 1 };
  });
  await sleep(30); // let it enter "running"
  const second = startSyncJob("beta", async () => {
    throw new Error("must never run — beta already syncing");
  });
  check("double-start joins the running job", second.startedAt === first.startedAt,
    `${first.startedAt} vs ${second.startedAt}`);
  release();
  await waitForSyncJobs();
  check("joined job still lands ok (the duplicate never ran)", readSyncJobs()["beta"]?.status === "ok");

  // 3. Serial queue: two sources never run concurrently (no rebuild races).
  const order: string[] = [];
  startSyncJob("q1", async () => {
    order.push("q1-start");
    await sleep(40);
    order.push("q1-end");
    return {};
  });
  startSyncJob("q2", async () => {
    order.push("q2-start");
    return {};
  });
  await waitForSyncJobs();
  check("jobs run one at a time, in order", order.join(",") === "q1-start,q1-end,q2-start", order.join(","));

  // 4. A throwing runner lands as a readable error, never a stuck spinner.
  startSyncJob("gamma", async () => {
    throw new Error("RescueTime data API → 401 — key not found");
  });
  await waitForSyncJobs();
  const failed = readSyncJobs()["gamma"];
  check("failure lands with the API's own message",
    failed?.status === "error" && (failed.error ?? "").includes("401"), failed?.error);

  // 5. A running job whose heartbeat went silent reads back as interrupted.
  const file = path.join(root, "sync-jobs.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.jobs["dead"] = {
    id: "dead",
    status: "running",
    phase: "fetching",
    pct: 40,
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    updatedAt: new Date(Date.now() - 600_000).toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(state));
  const dead = readSyncJobs()["dead"];
  check("silent running job reads as interrupted error",
    dead?.status === "error" && (dead.error ?? "").toLowerCase().includes("interrupted"), dead?.error);

  // 6. The real thing: a rescuetime sync (offline fixture) through the job
  // queue — progress phases fire, the run LEDGER records ok, the CSV lands.
  const seen: string[] = [];
  startSyncJob("rescuetime", (progress) =>
    syncSource({
      id: "rescuetime",
      fixture: path.resolve("samples/rescuetime-daily.json"),
      onProgress: (phase, pct) => {
        seen.push(`${phase}@${pct}`);
        progress(phase, pct);
      },
    }).then((r) => ({ days: r.days, dailyRows: r.dailyRows })),
  );
  await waitForSyncJobs();
  const rt = readSyncJobs()["rescuetime"];
  check("real sync lands ok through the queue", rt?.status === "ok", rt?.error ?? "");
  check("sync phases reached the job bar", seen.some((s) => s.startsWith("fetching")) && seen.some((s) => s.startsWith("updating")),
    seen.join(" | "));
  const run = readSyncRuns().runs["rescuetime"];
  check("run ledger records the attempt (ok)", run?.ok === true, JSON.stringify(run));
  const csv = path.join(root, "record", "daily", "rescuetime.csv");
  check("record/daily/rescuetime.csv written", fs.existsSync(csv));
  if (fs.existsSync(csv)) {
    const { header } = parseCsv(fs.readFileSync(csv, "utf8"));
    check("csv carries the hours columns", header.includes("total_hours"), header.join(","));
  }

  // 7. A failing REAL sync also lands in the ledger — no silent failures.
  startSyncJob("gcal", (progress) =>
    syncSource({ id: "gcal", onProgress: progress }).then((r) => ({ days: r.days })),
  );
  await waitForSyncJobs();
  const gcal = readSyncJobs()["gcal"];
  const gcalRun = readSyncRuns().runs["gcal"];
  check("credential-less sync fails loudly (job)", gcal?.status === "error", gcal?.error);
  check("…and lands in the run ledger (failure)", gcalRun?.ok === false, JSON.stringify(gcalRun));

  // 8. THE production crash: a sync must PATCH the cache, never rebuild it from
  // the whole record. A rebuild re-reads events.jsonl and rewrites the entire DB
  // — minutes of synchronous work on a real record, which blocked the server and
  // made the app look dead. Proof: plant a row that exists ONLY in the cache (no
  // record text behind it). A full rebuild would wipe it; the incremental path
  // keeps it — while still landing the synced source's real rows.
  const db = new Database(path.join(root, "agentqs.db"));
  db.prepare("INSERT OR REPLACE INTO daily (date,source,metric,value_num,value_text) VALUES (?,?,?,?,?)").run(
    "2020-01-01", "cache_only_sentinel", "canary", 1, "1",
  );
  db.close();

  startSyncJob("spotify", (progress) =>
    syncSource({
      id: "spotify",
      fixture: path.resolve("samples/spotify-recent.json"),
      onProgress: progress,
    }).then((r) => ({ days: r.days, dailyRows: r.dailyRows })),
  );
  await waitForSyncJobs();
  check("spotify sync lands ok", readSyncJobs()["spotify"]?.status === "ok", readSyncJobs()["spotify"]?.error ?? "");

  const after = new Database(path.join(root, "agentqs.db"), { readonly: true });
  const sentinel = after
    .prepare("SELECT COUNT(*) AS n FROM daily WHERE source = 'cache_only_sentinel'")
    .get() as { n: number };
  const spotifyRows = after
    .prepare("SELECT COUNT(*) AS n FROM daily WHERE source = 'spotify'")
    .get() as { n: number };
  after.close();
  check("sync did NOT rebuild the whole cache (sentinel survives)", sentinel.n === 1, `sentinel rows=${sentinel.n}`);
  check("…and the synced source's rows really landed in the cache", spotifyRows.n > 0, `spotify rows=${spotifyRows.n}`);

  // The patched cache must hold exactly what a full rebuild would: same rows.
  const patched = new Database(path.join(root, "agentqs.db"), { readonly: true })
    .prepare("SELECT date, metric, value_text FROM daily WHERE source='spotify' ORDER BY date, metric")
    .all() as Record<string, unknown>[];
  rebuild({ recordDir: path.join(root, "record") });
  const rebuilt = new Database(path.join(root, "agentqs.db"), { readonly: true })
    .prepare("SELECT date, metric, value_text FROM daily WHERE source='spotify' ORDER BY date, metric")
    .all() as Record<string, unknown>[];
  check("patched rows are identical to a full rebuild's", JSON.stringify(patched) === JSON.stringify(rebuilt),
    `${patched.length} vs ${rebuilt.length} rows`);

  // (The incremental EVENT path — replace-window + no duplicate search rows — is
  // proven against Granola's own multi-endpoint fixture in `npm run granola:test`.)

  // 9. A scheduler/CLI sync (no job queue) refreshes the ROW the UI renders —
  // otherwise one web failure stays on screen as "failed" forever, even after
  // the nightly sync succeeded. (This is exactly what prod showed for Spotify.)
  noteSyncOutcome("spotify", false, "Spotify recently-played → fetch failed");
  check("row shows the failure", readSyncJobs()["spotify"]?.status === "error");
  await syncSource({ id: "spotify", fixture: path.resolve("samples/spotify-recent.json") });
  const cleared = readSyncJobs()["spotify"];
  check("a later successful sync clears the stale failure", cleared?.status === "ok" && !cleared.error,
    `${cleared?.status} ${cleared?.error ?? ""}`);

  fs.rmSync(root, { recursive: true, force: true });

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("\n✓ Sync jobs: background, persistent, serialized, honest about failures.\n");
}

void main();

#!/usr/bin/env tsx
/**
 * Ships-when proof for `agentqs sync --due` — the crontab mode.
 *
 *   MAIN: one crontab line auto-runs exactly the sources whose schedule says
 *   they're due — API sources and browser automations alike — using the SAME
 *   `due` flag the sources panel uses for lazy-sync-on-open. Nothing due runs,
 *   nothing scheduled is silently dropped, and a failed run doesn't stop the rest.
 *
 * Drives the production selection path (buildSources → syncDue) against a temp
 * data dir with the runners substituted (like the network in the GitHub test),
 * plus the real `agentqs sync --due` CLI as a subprocess. No network, no LLM.
 * Run: npm run syncdue:test
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-syncdue-"));
process.env.AGENTQS_DATA_DIR = dataDir;
delete process.env.GITHUB_TOKEN; // the temp config's token must be the only one
const rDir = path.join(dataDir, "record");

const REPO = process.cwd();
const TSX = path.join(REPO, "node_modules/.bin/tsx");

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

async function main(): Promise<void> {
  // A record + config where every schedule state exists at once:
  //   github      — hourly, last synced 3 h ago, token present  → DUE (api)
  //   scale_site  — daily automation, last run 2 days ago       → DUE (automation)
  //   spotify     — weekly, synced 1 h ago, credential present  → scheduled, not due
  //   whoop       — interval off                                → not scheduled at all
  fs.mkdirSync(path.join(rDir, "daily"), { recursive: true });
  fs.writeFileSync(path.join(rDir, "daily", "github.csv"), "date,commits\n2026-07-07,3\n2026-07-08,5\n");
  fs.writeFileSync(path.join(rDir, "daily", "spotify.csv"), "date,tracks\n2026-07-08,12\n");
  fs.writeFileSync(path.join(rDir, "daily", "whoop.csv"), "date,recovery\n2026-07-08,60\n");
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      username: "test",
      passwordHash: "x",
      sessionSecret: "s",
      githubToken: "ghp_test",
      githubSyncedAt: hoursAgo(3),
      sourceCreds: { spotify: "BQ-test" },
      sourceIntervals: { github: "hourly", spotify: "weekly", "scale_site": "daily" },
      sourceSyncedAt: { spotify: hoursAgo(1), scale_site: hoursAgo(48) },
      automations: [
        {
          id: "scale_site",
          name: "Scale site",
          url: "https://example.com/weight",
          credType: "none",
          steps: [],
          createdAt: hoursAgo(100),
          lastRun: hoursAgo(48),
          lastStatus: "ok",
        },
      ],
    }),
  );

  const { dueSources, syncDue } = await import("../src/lib/sync-due");

  // ---- 1. selection — the schedule picks exactly the due sources ------------
  console.log("\ndueSources — what the schedule sees");
  const scheduled = dueSources(rDir);
  const byId = Object.fromEntries(scheduled.map((s) => [s.id, s]));
  check("every scheduled source is listed (interval ≠ off)", scheduled.length === 3, scheduled.map((s) => s.id).join(","));
  check("whoop (interval off) is not scheduled", !byId.whoop);
  check("github hourly + 3h stale → due", byId.github?.due === true);
  check("the automation daily + 2d stale → due", byId.scale_site?.due === true && byId.scale_site?.automation === true);
  check("spotify weekly + 1h fresh → not due", byId.spotify?.due === false);

  // ---- 2. syncDue runs the due ones with the right runner -------------------
  console.log("\nsyncDue — runners substituted, selection real");
  const ran: { kind: string; id: string }[] = [];
  const summary = await syncDue(
    {
      api: async (id) => void ran.push({ kind: "api", id }),
      automation: async (id) => void ran.push({ kind: "automation", id }),
    },
    rDir,
  );
  check("ran exactly the due pair", summary.due === 2 && summary.synced.length === 2);
  check("github went through the api runner", ran.some((r) => r.kind === "api" && r.id === "github"));
  check("the automation went through the headless runner", ran.some((r) => r.kind === "automation" && r.id === "scale_site"));
  check(
    "spotify reported as skipped (not silently dropped)",
    summary.skipped.some((s) => s.id === "spotify" && s.reason === "not due yet"),
  );

  // ---- 3. one failure doesn't stop the rest --------------------------------
  console.log("\nsyncDue — a failed source doesn't take the run down");
  const summary2 = await syncDue(
    {
      api: async () => {
        throw new Error("upstream 500");
      },
      automation: async () => undefined,
    },
    rDir,
  );
  check("the failure is reported per-source", summary2.failed.length === 1 && /upstream 500/.test(summary2.failed[0].error ?? ""));
  check("the other due source still ran", summary2.synced.length === 1);

  // ---- 4. the real CLI, no network — nothing due → clean exit ---------------
  console.log("\n`agentqs sync --due` — the real CLI (nothing due, no network)");
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  cfg.githubSyncedAt = hoursAgo(0);
  cfg.sourceSyncedAt = { spotify: hoursAgo(0), scale_site: hoursAgo(0) };
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg));
  const outRaw = execFileSync(TSX, [path.join("bin", "agentqs-cli.ts"), "sync", "--due", "--json"], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, AGENTQS_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const cli = JSON.parse(outRaw);
  check("CLI reports zero due, all three skipped", cli.due === 0 && cli.skipped.length === 3, outRaw.trim().slice(0, 80));

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

void main();

#!/usr/bin/env tsx
/**
 * Ships-when proof for the Pipeline-tab Log + Journal Edit mode, end to end.
 *
 *   MAIN: over the deployed URL — drop a CSV capture (POST /api/inbox),
 *   Structure it (POST /api/structure), see it in the Log with revert armed
 *   (GET /api/log), hand-edit the daily table (POST /api/journal/edit: set a
 *   cell, add a manual column, delete a row), then Reject the capture
 *   (POST /api/log/reject) and assert the cells it wrote are gone while the
 *   manual column survives.
 *
 * Boots the built standalone app against a throwaway data dir (real routes,
 * real record files, no LLM key needed — the CSV path is free). Builds into
 * its own dist dir (.next-e2e) so a running `next dev` on .next is untouched.
 * Run: npm run log:test
 */
import { spawn } from "child_process";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, ms = 30000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status > 0) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > ms) throw new Error(`server did not come up at ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-log-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dist = process.env.NEXT_DIST_DIR || ".next-e2e";
  const serverJs = path.join(dist, "standalone", "server.js");
  if (!fs.existsSync(serverJs)) {
    throw new Error(`standalone build missing at ${serverJs} — run: NEXT_DIST_DIR=${dist} next build`);
  }
  console.log(`\nStarting the standalone app on ${base} (data dir = ${root})…`);
  const server = spawn("node", [serverJs], {
    env: {
      ...process.env,
      AGENTQS_DATA_DIR: root,
      SESSION_SECRET: "log-e2e-secret",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
    },
    stdio: "ignore",
  });

  try {
    await waitFor(`${base}/login`);

    // Plain username (not an email) — signup must accept both.
    const setup = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "e2e-tester", password: "log-e2e", confirm: "log-e2e" }),
    });
    check("setup accepted a plain username", setup.ok);
    const cookie = ((setup.headers.get("set-cookie") || "").match(/agentqs_session=[^;]+/) || [""])[0];
    check("session cookie issued", Boolean(cookie));
    const json = { "content-type": "application/json", cookie };

    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "E2E-Tester", password: "log-e2e" }),
    });
    check("login accepts the username case-insensitively", login.ok);

    // 0. Demo data: seed → daily table + a lived-in Log (pending calendar/history
    //    captures, structured drops, one rejected).
    console.log("\nDemo");
    const demo = await fetch(`${base}/api/demo`, { method: "POST", headers: json });
    check("demo seeded", demo.ok);
    const demoLog = (await (await fetch(`${base}/api/log`, { headers: { cookie } })).json()) as {
      items: Array<{ filename: string | null; status: string; structured: { source: string | null } | null }>;
    };
    const byName = (n: string) => demoLog.items.find((i) => i.filename === n);
    check("demo log has a pending calendar capture", byName("calendar.ics")?.status === "pending");
    check("demo log has a pending browser-history capture", byName("history.csv")?.status === "pending");
    check("demo log has a structured drop", byName("steps-export.csv")?.status === "structured" && byName("steps-export.csv")?.structured?.source === "steps");
    check("demo log has a rejected drop", byName("old-tracker.csv")?.status === "discarded");
    const demoJournal = (await (await fetch(`${base}/api/journal`, { headers: { cookie } })).json()) as { totalDays: number };
    check("demo journal has ~100 days", demoJournal.totalDays >= 90);

    // 1. Drop a CSV capture, exactly like the Dropzone does. Structuring it is a
    //    real import — it must wipe every trace of the demo record first.
    console.log("\nDrop → Structure");
    const drop = await fetch(`${base}/api/inbox`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        text: "date,steps\n2026-07-01,1000\n2026-07-02,2000",
        source: "drop",
        kind: "csv",
        meta: { filename: "steps.csv" },
      }),
    });
    check("capture landed in the inbox", drop.ok);

    const structure = await fetch(`${base}/api/structure`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ all: true }),
    });
    const sBody = (await structure.json()) as { structured: number };
    check("structured via the free CSV path", structure.ok && sBody.structured === 1);

    // 2. The Log shows the capture with what it became, revert armed.
    console.log("\nLog");
    const log1 = (await (await fetch(`${base}/api/log`, { headers: { cookie } })).json()) as {
      items: Array<{ id: string; status: string; filename: string | null; structured: { source: string | null; cells: number | null; canRevert: boolean; applied: Array<{ d: string; m: string; before: string | null; after: string }> } | null }>;
    };
    const item = log1.items[0];
    check("demo wiped on real import — log holds only the real capture", log1.items.length === 1 && item.filename === "steps.csv");
    check("log shows structured → steps, 2 cells, revert armed",
      item.status === "structured" && item.structured?.source === "steps" && item.structured?.cells === 2 && item.structured?.canRevert === true);
    const diff = item.structured?.applied ?? [];
    check("log carries the reviewable diff (before → after per cell)",
      diff.length === 2 &&
        diff.some((c) => c.d === "2026-07-01" && c.m === "steps" && c.before === null && c.after === "1000") &&
        diff.some((c) => c.d === "2026-07-02" && c.m === "steps" && c.before === null && c.after === "2000"));

    // 3. Edit the table: change a cell, add a manual column, delete a row.
    console.log("\nJournal edit");
    const edit = await fetch(`${base}/api/journal/edit`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        edits: [
          { op: "set", source: "steps", metric: "steps", date: "2026-07-01", value: "1111" },
          { op: "set", source: "manual", metric: "mood", date: "2026-07-01", value: "good" },
          { op: "deleteRow", date: "2026-07-02" },
        ],
      }),
    });
    const eBody = (await edit.json()) as {
      sets: number; deletedRows: number;
      journal: { days: Array<{ date: string; values: Record<string, { text: string }> }> };
    };
    check("edit applied", edit.ok && eBody.sets === 2 && eBody.deletedRows === 1);
    const day1 = eBody.journal.days.find((d) => d.date === "2026-07-01");
    check("cell edited in the returned journal", day1?.values["steps.steps"]?.text === "1111");
    check("manual column written", day1?.values["manual.mood"]?.text === "good");
    check("row deleted", !eBody.journal.days.some((d) => d.date === "2026-07-02"));

    // 4. Reject the capture: its cells go, the manual column stays.
    console.log("\nReject");
    const reject = await fetch(`${base}/api/log/reject`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ id: item.id }),
    });
    const rBody = (await reject.json()) as { reverted: number };
    check("reject reverted the merge's cells", reject.ok && rBody.reverted === 2);

    const journal = (await (await fetch(`${base}/api/journal`, { headers: { cookie } })).json()) as {
      metrics: Array<{ key: string }>;
      days: Array<{ date: string; values: Record<string, { text: string }> }>;
    };
    check("rejected capture's column is gone", !journal.metrics.some((m) => m.key === "steps.steps"));
    check("manual edit survived the reject", journal.days.find((d) => d.date === "2026-07-01")?.values["manual.mood"]?.text === "good");

    const log2 = (await (await fetch(`${base}/api/log`, { headers: { cookie } })).json()) as {
      items: Array<{ status: string; rejectedAt: string | null }>;
    };
    check("log marks it rejected", log2.items[0]?.status === "discarded" && Boolean(log2.items[0]?.rejectedAt));
  } finally {
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

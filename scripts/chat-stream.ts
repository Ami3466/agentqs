#!/usr/bin/env tsx
/**
 * Ships-when proof for Loop 5 · Chat UI.
 *
 * A *real* streaming grounded conversation over the production route. This boots the
 * built app against a throwaway data dir, seeds a two-source daily record, logs in,
 * and hits POST /api/chat exactly as the Chat tab does — then asserts the reply
 * arrives as a stream of NDJSON `delta` frames (not one blob), and the closing `done`
 * frame carries the grounded badge (≥2 sources) plus a sparkline series of a cited
 * metric (the inline numbers + sparkline the UI renders).
 *
 * Drives the deployed URL, so it fails if streaming, grounding, or the spark break.
 * Keyless path — no AI key required. Run: npm run chat:test  (needs `next build` first).
 */
import { spawn } from "child_process";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import { writeGithubRecord } from "../src/lib/importers/github";
import { importPlugin, fixtureFetch } from "../src/lib/importers/plugin";
import { PLUGINS } from "../src/lib/importers/registry";
import { rebuild } from "../src/lib/record";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-chat-"));
  const recordDir = path.join(root, "record");
  const dbFile = path.join(root, "agentqs.db");

  console.log("\nSeeding a two-source daily record (GitHub commits + RescueTime focus)…\n");
  writeGithubRecord(recordDir, [
    { date: "2026-06-01", commits: 4 },
    { date: "2026-06-02", commits: 9 },
    { date: "2026-06-03", commits: 2 },
    { date: "2026-06-04", commits: 15 },
    { date: "2026-06-05", commits: 11 },
    { date: "2026-06-06", commits: 3 },
    { date: "2026-06-07", commits: 18 },
  ]);
  const rescuetime = PLUGINS.find((p) => p.id === "rescuetime")!;
  const body = JSON.parse(fs.readFileSync(path.resolve("samples/rescuetime-daily.json"), "utf8"));
  await importPlugin(rescuetime, { from: "2026-06-01", to: "2026-06-30", fetchImpl: fixtureFetch(body) }, recordDir);
  rebuild({ recordDir, dbPath: dbFile });
  check("record seeded + cache rebuilt (2 sources)", fs.existsSync(dbFile));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nStarting the built app on ${base} (data dir = ${root})…`);
  const server = spawn(process.execPath, [path.join(process.cwd(), ".next", "standalone", "server.js")], {
    env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", AGENTQS_DATA_DIR: root, SESSION_SECRET: "loop5-ships-when-secret" },
    stdio: "ignore",
  });

  try {
    await waitFor(`${base}/login`);

    // Create the account (keyless — no AI key) exactly like first-run setup.
    const setup = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "tester", password: "loop5pass", confirm: "loop5pass" }),
    });
    check("setup created the account", setup.ok);
    const setCookie = setup.headers.get("set-cookie") || "";
    const cookie = (setCookie.match(/agentqs_session=[^;]+/) || [""])[0];
    check("session cookie issued", Boolean(cookie));

    // The exact call the Chat tab makes — a cross-source data question.
    const question = "Why has my focus been off, and how does it track my coding?";
    console.log(`\n  Q: ${question}\n`);
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message: question, skill: "mentor", history: [] }),
    });
    check("chat responded 200", res.status === 200);
    check("response is an NDJSON stream", (res.headers.get("content-type") || "").includes("ndjson"));

    // Read the stream frame-by-frame, exactly like the browser client does.
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let deltas = 0;
    let text = "";
    let done: any = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const f = JSON.parse(line);
        if (f.t === "delta") {
          deltas++;
          text += f.v;
        } else if (f.t === "done") {
          done = f;
        } else if (f.t === "error") {
          check("no error frame", false, f.error);
        }
      }
    }

    console.log(`  A: ${text}\n`);
    check("reply streamed in multiple delta frames", deltas >= 2, `${deltas} frames`);
    check("reassembled reply is non-empty + quotes a number", text.trim().length > 0 && /\d/.test(text));
    check("a done frame closed the stream", Boolean(done));
    if (done) {
      check("reply is grounded in the record", done.grounded === true);
      check("grounded on ≥2 sources", Array.isArray(done.sources) && new Set(done.sources).size >= 2, (done.sources || []).join(" + "));
      const spark = done.spark;
      check("a sparkline series came back", Boolean(spark) && Array.isArray(spark.points) && spark.points.length >= 2,
        spark ? `${spark.source}.${spark.metric}, ${spark.points.length} pts, avg ${spark.avg}` : "none");
      if (spark) {
        check("sparkline points are real dated numbers", spark.points.every((p: any) => typeof p.date === "string" && typeof p.value === "number"));
      }
    }
  } finally {
    server.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("\n✓ Chat UI ships: a real streaming grounded reply arrives over /api/chat — token-by-token, ≥2 sources cited, with an inline sparkline of a cited metric.\n");
}

void main();

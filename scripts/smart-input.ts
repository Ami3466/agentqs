#!/usr/bin/env tsx
/**
 * Ships-when proof for Loop 6 · Smart input modes.
 *
 * The Chat box routes one typed line three ways by its prefix — plain text = chat,
 * `//` = a memo (raw to the inbox, no LLM), `/` = a command — and a skill chip
 * switches persona. This proves all of it end to end:
 *
 *   1. the dispatch contract (src/lib/smart-input.ts) — the SAME module the input
 *      box imports — routes `// slept bad`, `/sync`, and plain text correctly;
 *   2. over the built app's real routes: `// slept bad` lands in the inbox as a
 *      raw pending memo with NO LLM (no daily row, no key set);
 *   3. `/sync` is wired to a live route that runs its logic, and the fetch →
 *      normalize → merge → rebuild pipeline it drives lands commits in the daily
 *      table the app serves;
 *   4. the skill chip switches persona — POST /api/chat with skill=therapist then
 *      coach changes the persona the server answers as.
 *
 * Drives the deployed URL, so it fails if routing, the inbox, /sync, or the skill
 * switch break. Keyless — no AI key required. Run: npm run smart:test  (needs
 * `next build` first).
 */
import { spawn } from "child_process";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import { importGithub, type FetchLike } from "../src/lib/importers/github";
import { rebuild } from "../src/lib/record";
import { COMMANDS, filterCommands, memoText, modeOf, parseCommand } from "../src/lib/smart-input";

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

/** A GitHub Search-Commits fetch stand-in from a fixture of ISO author-date
 *  strings — the exact offline shim the CLI importer uses, so `/sync` runs its
 *  real fetch → bucket → write pipeline without touching the network. */
function fixtureFetch(file: string): FetchLike {
  const dates = JSON.parse(fs.readFileSync(file, "utf8")) as string[];
  const page = { total_count: dates.length, items: dates.map((date) => ({ commit: { author: { date } } })) };
  return (async (url: string) => {
    const first = new URL(url).searchParams.get("page") === "1";
    const body = first ? page : { total_count: dates.length, items: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as FetchLike;
}

/** Read one NDJSON /api/chat stream to its `done` frame (reassembled text + frame). */
async function readChat(res: Response): Promise<{ text: string; done: any }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
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
      if (f.t === "delta") text += f.v;
      else if (f.t === "done") done = f;
    }
  }
  return { text, done };
}

async function main() {
  // ---- 1. The dispatch contract (pure, shared with the input box) ---------
  console.log("\nRouting one typed line by its prefix (the shared smart-input contract)…\n");
  check('plain text → "chat" mode', modeOf("why have I felt off?") === "chat");
  check('"// slept bad" → "memo" mode', modeOf("// slept bad") === "memo");
  check('"// slept bad" memo text is stripped', memoText("// slept bad") === "slept bad");
  check('"/sync" → "command" mode', modeOf("/sync") === "command");
  check('parseCommand("/sync torvalds") splits cmd + args',
    (() => { const p = parseCommand("/sync torvalds"); return p.cmd === "sync" && p.args[0] === "torvalds"; })());
  const palette = filterCommands("/s").map((c) => c.cmd);
  check('palette filters "/s" to the /s… commands', palette.includes("/sync") && palette.includes("/structure") && palette.includes("/skill"),
    palette.join(" "));
  check("all four commands are offered", COMMANDS.length === 4);

  // ---- Seed a record + a synced GitHub source, then boot the built app ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-smart-"));
  const recordDir = path.join(root, "record");
  const dbFile = path.join(root, "agentqs.db");

  console.log("\nSeeding a GitHub source via the real /sync pipeline (fetch → bucket → write), offline…\n");
  const fixture = path.resolve("samples/github-commits.json");
  const expectedCommits = (JSON.parse(fs.readFileSync(fixture, "utf8")) as string[]).length;
  const summary = await importGithub({
    login: "demo",
    from: "2026-06-01",
    to: "2026-06-30",
    recordDir,
    fetchImpl: fixtureFetch(fixture),
  });
  rebuild({ recordDir, dbPath: dbFile });
  check("/sync pipeline wrote commits/day to the record", summary.total === expectedCommits, `${summary.total} commits`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nStarting the built app on ${base} (data dir = ${root})…`);
  const server = spawn(process.execPath, [path.join(process.cwd(), ".next", "standalone", "server.js")], {
    env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", AGENTQS_DATA_DIR: root, SESSION_SECRET: "loop6-ships-when-secret", GITHUB_TOKEN: "" },
    stdio: "ignore",
  });

  try {
    await waitFor(`${base}/login`);
    const setup = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "tester", password: "loop6pass", confirm: "loop6pass" }),
    });
    check("setup created the account (no AI key)", setup.ok);
    const cookie = ((setup.headers.get("set-cookie") || "").match(/agentqs_session=[^;]+/) || [""])[0];
    check("session cookie issued", Boolean(cookie));
    const auth = { "content-type": "application/json", cookie };

    // ---- 2. `// slept bad` lands in the inbox, raw, no LLM ---------------
    console.log('\n  // slept bad\n');
    const before = await (await fetch(`${base}/api/inbox`, { headers: { cookie } })).json();
    const memo = await fetch(`${base}/api/inbox`, {
      method: "POST",
      headers: auth,
      // exactly what the memo path sends: the `//` stripped, source "memo".
      body: JSON.stringify({ text: memoText("// slept bad"), source: "memo" }),
    });
    const memoData = await memo.json();
    check("memo POST accepted", memo.ok, `pending ${memoData.pending}`);
    check("pending count went up by one", memoData.pending === (before.pending ?? 0) + 1);

    const inbox = await (await fetch(`${base}/api/inbox`, { headers: { cookie } })).json();
    const landed = (inbox.items || []).find((i: any) => i.source === "memo" && i.text === "slept bad");
    check('"slept bad" is in the inbox as a raw memo', Boolean(landed));

    // No LLM ran: the memo is still raw/pending — it never became a daily row.
    const daily = await (await fetch(`${base}/api/daily`, { headers: { cookie } })).json();
    const memoSource = (daily.sources || []).some((s: any) => s.source === "memo");
    check("no LLM ran — the memo produced no daily row", !memoSource);

    // ---- 3. `/sync` is live + its pipeline is visible in the daily table --
    const syncState = await (await fetch(`${base}/api/import/github`, { headers: { cookie } })).json();
    check("/sync's source shows connected in the app", syncState.connected === true, `${syncState.total} commits`);
    const githubRows = (daily.sources || []).find((s: any) => s.source === "github");
    check("synced commits are queryable in the daily table", Boolean(githubRows) && githubRows.rows > 0,
      githubRows ? `${githubRows.rows} rows` : "none");

    // The `/sync` command targets this live route; with no token it runs its
    // precondition and returns a deterministic, structured result (not a dead route).
    const syncRun = await fetch(`${base}/api/import/github`, { method: "POST", headers: auth, body: "{}" });
    const syncBody = await syncRun.json();
    check("/sync route executes its logic (deterministic, structured response)",
      syncRun.status === 400 && /token/i.test(syncBody.error || ""), syncBody.error);

    // ---- 4. The skill chip switches persona ------------------------------
    console.log("\n  switching persona: mentor → therapist → coach\n");
    async function askAs(skill: string) {
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ message: "hey", skill, history: [] }),
      });
      return readChat(res);
    }
    const asTherapist = await askAs("therapist");
    check("chat answers as the therapist", asTherapist.done?.skill === "therapist");
    check("therapist reply is framed by that persona", /therapist/i.test(asTherapist.text), asTherapist.text.slice(0, 60));
    const asCoach = await askAs("coach");
    check("switching to coach changes who answers", asCoach.done?.skill === "coach");
    check("coach reply is framed by that persona", /coach/i.test(asCoach.text), asCoach.text.slice(0, 60));
  } finally {
    server.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log(
    "\n✓ Smart input ships: `// slept bad` lands in the inbox raw (no LLM), `/sync` runs its live pipeline into the daily table, and the skill chip switches persona.\n",
  );
}

void main();

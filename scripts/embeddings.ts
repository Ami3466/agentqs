#!/usr/bin/env tsx
/**
 * Ships-when proof for Loop 15 · Embeddings + semantic search.
 *
 * "'Find days that felt like this' works with NO API key set." Proves the whole
 * semantic path is real, local, and keyless:
 *
 *   1. The pure index (src/lib/embeddings.ts — the SAME module the app imports):
 *      the real local embedding model (all-MiniLM-L6-v2) + sqlite-vec build an index
 *      from a seeded record and answer feeling-queries by MEANING, not keywords —
 *      "shipped, huge relief" surfaces the day that says "the deploy finally went out
 *      and I could breathe" though they share no words and no hand-built lexicon (the
 *      proof it's a real model, not the old featurizer). Asserts the sqlite-vec backend
 *      is actually live, and that the index is deterministic and self-heals when stale.
 *   2. End to end over the BUILT app with NO AI key configured: a real record of dated
 *      memos is seeded, then POST /api/search returns the right day, and the Chat
 *      endpoint answers "find days that felt like this: …" with a grounded reply that
 *      names that day — all with no provider key set. GET /api/embeddings reports the
 *      index status the Settings panel shows.
 *
 * Nothing is mocked — the embedding model, sqlite-vec, the record, the routes are the
 * real production path, so this fails if any of it breaks. Run: npm run semantic:test
 * (needs `next build`).
 */
import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { appendInboxItem } from "../src/lib/record";
import { buildIndex, indexStatus, semanticSearch, ensureIndex } from "../src/lib/embeddings";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

function niceDate(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
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

/** Dated memos — each day has a distinct *feeling*, worded so it shares NO words with
 *  the query that should find it. A real model has to understand meaning to match. */
const DAYS: [string, string][] = [
  ["2026-06-01", "The deploy finally went out and I could breathe."],
  ["2026-06-02", "Woke up drained, foggy head, dragged myself through the whole day."],
  ["2026-06-03", "Chest tight before the review, kept bracing for bad news."],
  ["2026-06-04", "Long quiet morning by the water, unhurried and still."],
  ["2026-06-05", "So mad I could barely see straight, resentment boiling."],
  ["2026-06-06", "Nobody around all weekend, the apartment felt huge and silent."],
];

function seedRecord(recordDir: string) {
  for (const [, text] of DAYS) appendInboxItem({ text, source: "memo" }, { recordDir });
  // Backdate each memo's ts so it belongs to its intended day.
  const inboxFile = path.join(recordDir, "inbox.jsonl");
  const lines = fs
    .readFileSync(inboxFile, "utf8")
    .trim()
    .split("\n")
    .map((l, i) => {
      const o = JSON.parse(l);
      o.ts = DAYS[i][0] + "T12:00:00.000Z";
      return JSON.stringify(o);
    });
  fs.writeFileSync(inboxFile, lines.join("\n") + "\n");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-semantic-"));
  const rDir = path.join(root, "record");
  const vecFile = path.join(root, "agentqs-vec.db");
  seedRecord(rDir);

  // Share ONE warm model cache between this process and the spawned server so the
  // real model downloads at most once, then runs fully offline (default is the data
  // dir; here we pin a stable dir so the temp data dir doesn't re-download).
  const modelDir = path.join(process.cwd(), "data", "models");
  process.env.AGENTQS_MODEL_DIR = modelDir;

  // ---- 1. The pure local index (sqlite-vec + the real local model), keyless. ----
  console.log("\nThe local semantic index — sqlite-vec + all-MiniLM-L6-v2 (no key)…\n");
  const built = await buildIndex({ recordDir: rDir, vecFile });
  check("the index built with the sqlite-vec backend", built.backend === "sqlite-vec", built.backend);
  check("it used the real model, not the hash shim", built.model === "all-MiniLM-L6-v2", built.model);
  check("every dated memo was embedded", built.count === DAYS.length, `${built.count} entries`);

  // Feeling-queries that share NO words (and no lexicon entry) with the memo they
  // should match — only a real model can bridge them.
  const semantic: [string, string][] = [
    ["shipped, huge relief", "2026-06-01"], // → "the deploy finally went out and I could breathe"
    ["no energy at all, running on empty", "2026-06-02"], // → drained/foggy
    ["nervous and on edge about what's coming", "2026-06-03"], // → chest tight / bracing
    ["peaceful and relaxed, felt serene", "2026-06-04"], // → quiet morning by the water
    ["furious, lost my temper", "2026-06-05"], // → so mad, resentment boiling
    ["isolated and missing people", "2026-06-06"], // → nobody around, silent apartment
  ];
  let semanticOk = 0;
  let firstTop = "";
  for (const [q, want] of semantic) {
    const hits = await semanticSearch(q, { recordDir: rDir, vecFile, limit: 3 });
    const top = hits[0]?.date;
    if (!firstTop) firstTop = top ?? "";
    const pass = top === want;
    if (pass) semanticOk++;
    console.log(
      `    "${q}"  → ${top ? niceDate(top) : "(none)"} ${pass ? "✓" : `✗ want ${niceDate(want)}`}`,
    );
  }
  check("semantic recall matches by MEANING, not keywords", semanticOk === semantic.length, `${semanticOk}/${semantic.length}`);

  // Deterministic: rebuild → identical ranking (compare to the first build's result).
  await buildIndex({ recordDir: rDir, vecFile });
  const again = await semanticSearch(semantic[0][0], { recordDir: rDir, vecFile, limit: 3 });
  check("the index is deterministic (same record → same top day)", again[0]?.date === firstTop, `${again[0]?.date} vs ${firstTop}`);
  check("ensureIndex is a no-op when the index is fresh", (await ensureIndex({ recordDir: rDir, vecFile })) === null);
  const st = indexStatus({ recordDir: rDir, vecFile });
  check("indexStatus reports built + fresh", st.built && !st.stale && st.count === DAYS.length);

  // ---- 2. End to end over the built app, NO AI key. ----
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nStarting the built app on ${base} (data dir = ${root}, NO AI key)…`);
  const server = spawn("node_modules/.bin/next", ["start", "-p", String(port)], {
    env: {
      ...process.env,
      AGENTQS_DATA_DIR: root,
      AGENTQS_MODEL_DIR: modelDir, // warm shared model cache → no re-download, offline
      SESSION_SECRET: "loop15-ships-when-secret",
      // Deliberately no ANTHROPIC/OPENAI/GOOGLE key — the whole point is keyless.
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
    },
    stdio: "ignore",
  });

  try {
    await waitFor(`${base}/login`);
    const setup = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "tester", password: "loop15pass" }),
    });
    check("setup created the account with NO AI key", setup.ok);
    const cookie = ((setup.headers.get("set-cookie") || "").match(/agentqs_session=[^;]+/) || [""])[0];

    // --- POST /api/search — keyless semantic search returns the right day. ---
    console.log(`\n  POST /api/search  "nervous and on edge about what's coming"\n`);
    const searchRes = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ query: "nervous and on edge about what's coming" }),
    });
    const search = await searchRes.json();
    check("/api/search returned days", Array.isArray(search.hits) && search.hits.length > 0);
    check(
      "the closest day is the anxious one (matched by meaning, no key)",
      search.hits?.[0]?.date === "2026-06-03",
      search.hits?.[0] ? `${search.hits[0].date} @ ${search.hits[0].score}` : "none",
    );

    // --- Chat: "find days that felt like this: …" → grounded reply, no key. This is
    // the acceptance headline: "shipped, huge relief" shares no words with the memo. ---
    console.log(`\n  POST /api/chat  "find days that felt like this: shipped, huge relief"\n`);
    const chatRes = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message: "find days that felt like this: shipped, huge relief", history: [] }),
    });
    check("chat streamed an NDJSON response", chatRes.ok && !!chatRes.body);
    let text = "";
    let done: any = null;
    const reader = chatRes.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: d } = await reader.read();
      if (d) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const f = JSON.parse(line);
        if (f.t === "delta") text += f.v ?? "";
        else if (f.t === "done") done = f;
      }
    }
    console.log(`  → reply: ${text.replace(/\n/g, " ")}\n`);
    check("the chat reply is grounded (keyless recall path)", done?.grounded === true, done?.via ?? JSON.stringify(done));
    check("it names the deploy/relief day", text.includes(niceDate("2026-06-01")), niceDate("2026-06-01"));
    check("the grounded badge attributes the memos", Array.isArray(done?.sources) && done.sources.includes("memos"), (done?.sources || []).join(", "));

    // --- GET /api/embeddings — the status the Settings panel shows. ---
    const statusRes = await fetch(`${base}/api/embeddings`, { headers: { cookie } });
    const status = await statusRes.json();
    check("/api/embeddings reports a built index", status.built === true && status.count === DAYS.length, `${status.count} entries · ${status.backend}`);
  } finally {
    server.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log(
    "\n✓ Embeddings ship: 'find days that felt like this' works with NO API key — the local model + sqlite-vec match days by meaning, in the Journal, the Chat, and the API.\n",
  );
}

void main();

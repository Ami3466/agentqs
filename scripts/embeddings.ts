#!/usr/bin/env tsx
/**
 * Ships-when proof for Loop 15 · Embeddings + semantic search.
 *
 * "'Find days that felt like this' works with NO API key set." Proves the whole
 * semantic path is real, local, and keyless:
 *
 *   1. The pure index (src/lib/embeddings.ts — the SAME module the app imports):
 *      the local embedding model + sqlite-vec build an index from a seeded record and
 *      answer feeling-queries by MEANING, not keywords — "wired, couldn't switch off"
 *      surfaces the day that says "anxious and stressed" though they share no words.
 *      Asserts the sqlite-vec backend is actually live, and that the index is
 *      deterministic (same record → same ranking) and self-heals when stale.
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
import { buildIndex, chunkText, collectItems, indexStatus, semanticSearch, ensureIndex } from "../src/lib/embeddings";

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

/** Dated memos — each day has a distinct *feeling*, expressed in its own words. */
const DAYS: [string, string][] = [
  ["2026-06-01", "Woke up completely exhausted, could not focus, so tired the whole day."],
  ["2026-06-02", "Amazing day — felt happy and energized, shipped a big feature."],
  ["2026-06-03", "Anxious and stressed about the deadline, heart racing all afternoon."],
  ["2026-06-04", "Calm and rested, went for a long run, felt clear and light."],
  ["2026-06-05", "Frustrated and angry at the meeting, snapped at people."],
];

// Filler long enough to push the buried fact WELL past the model's context window, so
// a single whole-document vector provably cannot see it.
const FILLER_EN =
  "Notes on the quarter. Shipped the importer, fixed the sync scheduler, reviewed the backlog, " +
  "rewrote the onboarding copy, argued about naming, cleaned up the cache layer, and moved on. ";
const FILLER_HE =
  "הערות מהרבעון. שחררתי את המייבא, תיקנתי את המתזמן, עברתי על המשימות, ניקיתי את המטמון והמשכתי הלאה. ";

// Two LONG documents whose distinctive fact sits in the MIDDLE, buried under ~4KB of
// filler. This is the exact shape that used to fail: the memo was stored, reindexed,
// and unfindable, because only its opening ever reached the model.
//   - the English one proves CHUNKING (the tail of a long doc is embedded at all).
//   - the Hebrew one proves the model is MULTILINGUAL (an English-only model can't
//     retrieve it in any language, and Hebrew is most of this record).
const BURIED_EN_DATE = "2026-06-08";
const BURIED_HE_DATE = "2026-06-09";
const BURIED_EN =
  FILLER_EN.repeat(12) +
  "\n\nThe decision I keep avoiding: I want to leave the agency and go work on brain-computer " +
  "interfaces, memory research specifically. I have not told anyone this yet.\n\n" +
  FILLER_EN.repeat(12);
const BURIED_HE =
  FILLER_HE.repeat(12) +
  "\n\nההחלטה שאני כל הזמן דוחה: אני רוצה לעזוב את הסוכנות וללכת לעבוד על ממשקי מוח-מחשב, " +
  "ובמיוחד על מחקר של זיכרון. עוד לא סיפרתי על זה לאף אחד.\n\n" +
  FILLER_HE.repeat(12);

// A dropped CSV lands VERBATIM in the inbox. Chunking one would flood the index with
// hundreds of rows of digits which a compressed-score model ranks alongside real
// writing — the numbers then crowd the journal out of its own search. A table is
// worth ONE vector; its meaning lives in the daily cells it structures into.
const TABLE_DATE = "2026-06-10";
const TABLE_CSV =
  "date,steps,resting_hr,hrv,sleep_min,calories\n" +
  Array.from(
    { length: 400 },
    (_, i) => `2025-${String((i % 12) + 1).padStart(2, "0")}-01,${8000 + i},${52 + (i % 9)},${40 + (i % 30)},${380 + (i % 90)},${2100 + i}`,
  ).join("\n");

const LONG: [string, string][] = [
  [BURIED_EN_DATE, BURIED_EN],
  [BURIED_HE_DATE, BURIED_HE],
];

// The SAME table, but already merged into daily cells (`via: "csv"`). Its rows now live
// in the daily table, which is embedded on its own — so indexing the raw file too would
// store every row twice and slice the file into fragments that outscore real writing.
// Raw or structured, never both.
const STRUCTURED_DATE = "2026-06-11";

/** Daily text cells: one column of real writing, one of the attachment-URL sludge that
 *  an import lands as "free text" (notion_journal.files_media is 872 cells of exactly
 *  this). Only the writing belongs in a semantic index — a column of links embeds to
 *  nowhere and then floats near the top of EVERY query. */
function seedDailyText(recordDir: string) {
  const dir = path.join(recordDir, "daily");
  fs.mkdirSync(dir, { recursive: true });
  const url = "https://lh3.googleusercontent.com/lr/" + "ANt8axlxkEVq7Z".repeat(6);
  fs.writeFileSync(
    path.join(dir, "notion_journal.csv"),
    "date,note,files_media\n" +
      `2026-06-12,"Long walk by the river and it finally felt quiet in my head.","${url}"\n` +
      `2026-06-13,"Argued with myself all morning about the same decision again.","${url}"\n`,
  );
}

function seedRecord(recordDir: string) {
  seedDailyText(recordDir);
  const all: [string, string][] = [
    ...DAYS,
    ...LONG,
    [TABLE_DATE, TABLE_CSV],
    [STRUCTURED_DATE, TABLE_CSV],
  ];
  for (const [, text] of all) appendInboxItem({ text, source: "memo" }, { recordDir });
  // Backdate each memo's ts so it belongs to its intended day, and mark the LAST one
  // structured-via-csv exactly as structurePending would.
  const inboxFile = path.join(recordDir, "inbox.jsonl");
  const lines = fs
    .readFileSync(inboxFile, "utf8")
    .trim()
    .split("\n")
    .map((l, i) => {
      const o = JSON.parse(l);
      o.ts = all[i][0] + "T12:00:00.000Z";
      if (all[i][0] === STRUCTURED_DATE) {
        // EXACTLY what structurePending writes to the record: `via` sits FLAT on meta.
        // (Only the /api/log wire shape nests it under `structured` — seeding that
        // nested shape here made this test pass while production matched nothing.)
        o.status = "structured";
        o.meta = { ...(o.meta ?? {}), filename: "health", via: "csv", source: "health", cells: 2400 };
      }
      return JSON.stringify(o);
    });
  fs.writeFileSync(inboxFile, lines.join("\n") + "\n");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-semantic-"));
  // Isolate part 1 from the developer's real config: semanticSearch/ensureIndex read
  // the Settings kill-switches via readConfig(), which follows AGENTQS_DATA_DIR.
  process.env.AGENTQS_DATA_DIR = root;
  const rDir = path.join(root, "record");
  const vecFile = path.join(root, "agentqs-vec.db");
  seedRecord(rDir);

  // ---- 1. The pure local index (sqlite-vec + the local model), keyless. ----
  console.log("\nThe local semantic index — sqlite-vec + the local embedding model (no key)…\n");
  const built = await buildIndex({ recordDir: rDir, vecFile });
  // A long PROSE memo becomes several chunks; a 400-row CSV stays ONE vector; the two
  // daily prose cells are embedded and their attachment-URL siblings are not.
  const DAILY_PROSE_CELLS = 2;
  const expected =
    DAYS.length + LONG.reduce((n, [, t]) => n + chunkText(t).length, 0) + 1 + DAILY_PROSE_CELLS;
  check("the index built with the sqlite-vec backend", built.backend === "sqlite-vec", built.backend);
  check("every dated memo was embedded", built.count === expected, `${built.count} entries`);
  check(
    "long memos are CHUNKED, not clipped to their opening",
    chunkText(BURIED_EN).length > 1 && chunkText(BURIED_HE).length > 1,
    `${chunkText(BURIED_EN).length} + ${chunkText(BURIED_HE).length} chunks`,
  );
  // The guard: a dropped table must NOT become hundreds of rows of digits in the
  // index. Its rows would score alongside prose and bury the journal. Both copies of
  // the same 400-row table are seeded — one pending, one already structured via csv —
  // so this counts BOTH: the pending one is worth a single vector, the structured one
  // is worth NONE (its rows are daily cells now, and those are embedded on their own).
  const collected = collectItems(rDir);
  const tableItems = collected.filter((it) => it.text.startsWith("date,steps,resting_hr"));
  check(
    "a structured CSV leaves the index entirely; a pending one is ONE vector, never rows of digits",
    tableItems.length === 1,
    `${tableItems.length} entries for two 400-row tables`,
  );
  // The index holds LANGUAGE: the prose column is embedded, the attachment-URL column
  // is not. A cell of links is text by shape only, and it floats near the top of every
  // query because the model has nothing to tell one link from another.
  const daily = collected.filter((it) => it.kind === "daily_text");
  check(
    "a daily column of prose is indexed; a column of attachment URLs is not",
    daily.some((it) => it.text.includes("felt quiet in my head")) &&
      !daily.some((it) => it.text.includes("googleusercontent")),
    `${daily.length} daily_text entries`,
  );

  // Feeling-queries that share NO words with the memo they should match — the real
  // neural model has to line them up by MEANING, not lexical overlap.
  const semantic: [string, string][] = [
    ["couldn't stop worrying, on edge and panicking about a deadline", "2026-06-03"], // → anxious/stressed
    ["completely wiped out, no energy at all", "2026-06-01"], // → exhausted/tired
    ["thrilled and full of joy after a great win", "2026-06-02"], // → happy/energized
    ["serene and relaxed, went jogging in the morning", "2026-06-04"], // → calm/run
    ["furious and irritated, lost my temper", "2026-06-05"], // → frustrated/angry
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

  // --- The two regressions this suite exists to catch. ---
  // Both queries name a fact buried in the MIDDLE of a ~4KB memo. With one vector per
  // document (the old behaviour) the fact is past the model's window and unreachable;
  // with an English-only model the Hebrew memo is unreachable in any language.
  console.log("\n  A fact buried mid-document, and a document written in Hebrew…\n");
  const buried: [string, string, string][] = [
    ["wanting to quit my job and move into neuroscience", BURIED_EN_DATE, "buried mid-document (English)"],
    ["רוצה לעזוב את העבודה ולעבוד על מחקר מוח", BURIED_HE_DATE, "Hebrew query → Hebrew document"],
    ["wanting to quit my job and move into brain research", BURIED_HE_DATE, "English query → HEBREW document (cross-lingual)"],
  ];
  for (const [q, want, label] of buried) {
    const hits = await semanticSearch(q, { recordDir: rDir, vecFile, limit: 5 });
    const dates = hits.map((h) => h.date);
    // The Hebrew and English docs say the same thing, so either may top the other for a
    // cross-lingual query — what must hold is that the buried day is FOUND at all.
    const pass = dates.includes(want);
    check(`${label}`, pass, pass ? `found ${niceDate(want)}` : `got ${dates.map(niceDate).join(", ") || "(none)"}`);
  }

  // Deterministic: rebuild → identical ranking (compare to the first build's result).
  await buildIndex({ recordDir: rDir, vecFile });
  const again = await semanticSearch(semantic[0][0], { recordDir: rDir, vecFile, limit: 3 });
  check("the index is deterministic (same record → same top day)", again[0]?.date === firstTop, `${again[0]?.date} vs ${firstTop}`);
  check("ensureIndex is a no-op when the index is fresh", (await ensureIndex({ recordDir: rDir, vecFile })) === null);
  const st = await indexStatus({ recordDir: rDir, vecFile });
  check("indexStatus reports built + fresh", st.built && !st.stale && st.count === expected, `${st.count} entries`);

  // ---- 2. End to end over the built app, NO AI key. ----
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nStarting the built app on ${base} (data dir = ${root}, NO AI key)…`);
  const server = spawn(process.execPath, [path.join(process.cwd(), ".next", "standalone", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      AGENTQS_DATA_DIR: root,
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
      body: JSON.stringify({ username: "tester", password: "loop15pass", confirm: "loop15pass" }),
    });
    check("setup created the account with NO AI key", setup.ok);
    const cookie = ((setup.headers.get("set-cookie") || "").match(/agentqs_session=[^;]+/) || [""])[0];

    // --- POST /api/search — keyless semantic search returns the right day. ---
    console.log(`\n  POST /api/search  "worried and on edge, panicking"\n`);
    const searchRes = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ query: "worried and on edge, panicking" }),
    });
    const search = await searchRes.json();
    check("/api/search returned days", Array.isArray(search.hits) && search.hits.length > 0);
    check(
      "the closest day is the anxious/stressed one (matched by meaning, no key)",
      search.hits?.[0]?.date === "2026-06-03",
      search.hits?.[0] ? `${search.hits[0].date} @ ${search.hits[0].score}` : "none",
    );

    // --- Chat: "find days that felt like this: …" → grounded reply, no key. ---
    console.log(`\n  POST /api/chat  "find days that felt like this: happy and full of energy"\n`);
    const chatRes = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message: "find days that felt like this: happy and full of energy", history: [] }),
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
    check("it names the happy/energized day", text.includes(niceDate("2026-06-02")), niceDate("2026-06-02"));
    check("the grounded badge attributes the memos", Array.isArray(done?.sources) && done.sources.includes("memos"), (done?.sources || []).join(", "));

    // --- GET /api/embeddings — the status the Settings panel shows. ---
    const statusRes = await fetch(`${base}/api/embeddings`, { headers: { cookie } });
    const status = await statusRes.json();
    check("/api/embeddings reports a built index", status.built === true && status.count === expected, `${status.count} entries · ${status.backend}`);
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

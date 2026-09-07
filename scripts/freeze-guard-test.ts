#!/usr/bin/env tsx
/**
 * Ships-when proof that a USER ACTION CANNOT FREEZE THIS APP.
 *
 * What happened, on the real record: structuring five pending inbox items through
 * `POST /api/structure` hung every request on the instance for over fifteen
 * minutes. `/api/doctor` timed out repeatedly; even `GET /` took 14 seconds to
 * answer a redirect. Nothing had crashed. better-sqlite3 is SYNCHRONOUS, and one
 * record mutation on the request thread owns the whole event loop while it runs —
 * so a button that reaches a full `rebuild()` (which re-reads 660MB of
 * events.jsonl and re-indexes every event) is not slow, it is an outage.
 *
 * The rule "never call rebuild() from a request" was already written down. It was
 * broken anyway, because half a dozen `land*` helpers quietly fell back to a
 * rebuild whenever their patch reported it could not apply. So this file asserts
 * the enforced version, against production code, with no network:
 *
 *   1. THE BOUNDARY IS REAL. `rebuild()` throws outside a converger context and
 *      works inside one (record-context.ts). The request side of the boundary is
 *      reproduced exactly as production sets it: `NEXT_RUNTIME=nodejs`.
 *   2. NO SILENT FALLBACK. Every `land*` helper, given a cache it cannot patch,
 *      fails LOUDLY — it never re-derives the record to get out of trouble.
 *   3. THE FIRST BUILD IS A NAMED PATH. "No cache yet" is legitimate and still
 *      works; "a cache exists but the patch failed" is not, and neither is
 *      building a first cache for a record too big to derive in a request.
 *   4. A REQUEST THAT STRUCTURES DOES NOT REBUILD. Proved positively with a
 *      sentinel row a rebuild would erase, on a record big enough that a rebuild
 *      is measurably slow — and inside a fixed time budget.
 *   5. THE PATCH IS SIZED TO THE CHANGE. The three per-run costs that grew with
 *      the whole record are measured before/after in the same run.
 *   6. THE PATCH STILL EQUALS A REBUILD. daily, events, raw_inbox, sessions and
 *      every `search` row, compared against a rebuild of the same record.
 *
 * Temp AGENTQS_DATA_DIR only — it never touches ./data.
 *
 * Run: npm run freeze:test
 */
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { writeConfig } from "../src/lib/config";
import { columnGuard } from "../src/lib/column-scan";
import {
  appendEvents,
  appendInboxItems,
  appendSession,
  buildInitialCache,
  landDailySources,
  landInboxCaptures,
  landInboxIds,
  landInboxStream,
  landRemovedSources,
  landSessionDelete,
  landSessionWrite,
  rebuild,
  readSessionsFromRecord,
} from "../src/lib/record";
import { REBUILD_IN_REQUEST, runAsConverger, runAsRequest } from "../src/lib/record-context";
import { structurePending } from "../src/lib/structure-run";

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

/** Run `fn` and hand back the error it threw (or null). */
function threw(fn: () => unknown): Error | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

const ms = (fn: () => unknown): number => {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
};

/** Reproduce the production request path exactly: Next sets NEXT_RUNTIME in its
 *  server bundle, which is what puts route handlers outside a converger. */
function asRequest<T>(fn: () => T): T {
  process.env.NEXT_RUNTIME = "nodejs";
  try {
    return fn();
  } finally {
    delete process.env.NEXT_RUNTIME;
  }
}

// ---- seeding --------------------------------------------------------------

/** Rows and events enough that a full rebuild is unmistakably slow — the whole
 *  point is that the patched path must NOT scale with any of this. */
const EVENTS = 200_000;
const DAILY_DAYS = 4_000;
const INBOX_ITEMS = 6_000;

function isoDay(n: number): string {
  const d = new Date(Date.UTC(2015, 0, 1));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function seedLargeRecord(rDir: string): void {
  fs.mkdirSync(path.join(rDir, "daily"), { recursive: true });

  // Numeric daily sources — the shape a real record is mostly made of.
  for (const [name, metric] of [
    ["whoop", "sleep_hours"],
    ["fitbit", "steps"],
    ["spotify", "tracks"],
  ] as const) {
    const lines = [`date,${metric}`];
    for (let i = 0; i < DAILY_DAYS; i++) lines.push(`${isoDay(i)},${(i % 97) + 1}`);
    fs.writeFileSync(path.join(rDir, "daily", `${name}.csv`), `${lines.join("\n")}\n`);
  }
  // A PROSE source: its cells reach the FTS index, which is what made the daily
  // patch scan the whole search table on every structure.
  {
    const lines = ["date,note"];
    for (let i = 0; i < DAILY_DAYS; i++) lines.push(`${isoDay(i)},"a written note for day ${i} with enough words to index"`);
    fs.writeFileSync(path.join(rDir, "daily", "notes.csv"), `${lines.join("\n")}\n`);
  }

  // events.jsonl — the stream a rebuild re-parses in full.
  const events = [];
  for (let i = 0; i < EVENTS; i++) {
    events.push({
      id: `ev-${i}`,
      date: isoDay(i % DAILY_DAYS),
      source: "google_myactivity",
      title: `visit ${i}`,
      text: `searched for something interesting number ${i}`,
    });
  }
  appendEvents(events, { recordDir: rDir });

  // A real backlog of captures. Landing the WHOLE inbox for a one-row change is
  // one FTS index scan per capture — the fifteen minutes, in one line of code.
  appendInboxItems(
    Array.from({ length: INBOX_ITEMS }, (_, i) => ({
      id: `cap-${i}`,
      text: `an old capture number ${i} that has already been dealt with`,
      source: "memo",
      kind: "text",
      status: i % 3 === 0 ? "structured" : "reference",
    })),
    { recordDir: rDir },
  );
  appendSession({ id: "sess-1", skill: "mentor", title: "a session", summary: "something learned" }, { recordDir: rDir });
}

/** Everything a rebuild would leave, as comparable text. */
function snapshot(dbFile: string): Record<string, string> {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const rows = (sql: string) => JSON.stringify(db.prepare(sql).all());
    return {
      daily: rows("SELECT date,source,metric,value_num,value_text FROM daily ORDER BY date,source,metric"),
      events: rows("SELECT id,date,ts,source,title,text,url,meta FROM events ORDER BY id"),
      inbox: rows("SELECT id,ts,source,kind,text,meta,status FROM raw_inbox ORDER BY id"),
      sessions: rows("SELECT id,date,started_at,skill,title,summary FROM sessions ORDER BY id"),
      search: rows("SELECT ref,kind,body FROM search ORDER BY kind,ref,body"),
    };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-freeze-"));
  process.env.AGENTQS_DATA_DIR = root;
  const rDir = path.join(root, "record");
  const dbFile = path.join(root, "agentqs.db");
  writeConfig({ username: "tester", passwordHash: "x", createdAt: new Date().toISOString() } as never);

  try {
    console.log("\nSeeding a record big enough that a rebuild is expensive…");
    seedLargeRecord(rDir);
    const rebuildMs = ms(() => rebuild({ recordDir: rDir }));
    console.log(
      `  ${EVENTS.toLocaleString()} events · ${(DAILY_DAYS * 4).toLocaleString()} daily cells · ` +
        `${INBOX_ITEMS.toLocaleString()} captures — full rebuild ${Math.round(rebuildMs)}ms`,
    );

    // ---- 1. the boundary ---------------------------------------------------
    console.log("\n1. rebuild() is a converger, and a request is not one…\n");
    const blocked = asRequest(() => threw(() => rebuild({ recordDir: rDir })));
    check("rebuild() THROWS on the request path", blocked !== null, blocked ? "threw" : "IT RAN");
    check(
      "…and the error names the fix, not just the ban",
      Boolean(blocked && blocked.message === REBUILD_IN_REQUEST && /agentqs rebuild/.test(blocked.message)),
      blocked?.message.slice(0, 80),
    );
    const inside = asRequest(() => threw(() => runAsConverger(() => rebuild({ recordDir: rDir }))));
    check("…and it still works inside an explicit converger context", inside === null, inside?.message ?? "");
    check("a plain CLI/script process is a converger with no ceremony", threw(() => rebuild({ recordDir: rDir })) === null);
    check(
      "…and any flow can declare itself a request and get the same guard",
      threw(() => runAsRequest(() => rebuild({ recordDir: rDir }))) !== null,
    );

    // ---- 2. no silent fallback --------------------------------------------
    console.log("\n2. A cache that cannot be patched fails LOUDLY — it never rebuilds…\n");
    const good = fs.readFileSync(dbFile);
    const item = { id: "cap-0", ts: "", source: "memo", kind: "text", text: "x", meta: null, status: "pending" };
    const session = readSessionsFromRecord(rDir)[0];
    const helpers: Array<[string, () => unknown]> = [
      ["landDailySources", () => landDailySources(["whoop"], { recordDir: rDir })],
      ["landRemovedSources", () => landRemovedSources(["whoop"], { recordDir: rDir })],
      ["landInboxCaptures", () => landInboxCaptures([item], { recordDir: rDir })],
      ["landInboxIds", () => landInboxIds(["cap-0"], { recordDir: rDir })],
      ["landInboxStream", () => landInboxStream({ recordDir: rDir })],
      ["landSessionWrite", () => landSessionWrite([session], { recordDir: rDir })],
      ["landSessionDelete", () => landSessionDelete(["sess-1"], { recordDir: rDir })],
      ["buildInitialCache", () => buildInitialCache({ recordDir: rDir })],
    ];
    for (const [name, run] of helpers) {
      fs.writeFileSync(dbFile, "this is not a database"); // present, unpatchable
      const e = asRequest(() => threw(run));
      const stillCorrupt = fs.readFileSync(dbFile).toString() === "this is not a database";
      check(`${name} throws instead of re-deriving`, e !== null, e ? "" : "IT SWALLOWED IT");
      check(`…and says how to converge`, Boolean(e && /agentqs rebuild/.test(e.message)), e?.message.slice(0, 60) ?? "");
      check(`…and the record was NOT re-derived`, stillCorrupt, stillCorrupt ? "" : "the cache was rebuilt");
    }
    fs.writeFileSync(dbFile, good);

    // ---- 3. the first build is a named path --------------------------------
    console.log("\n3. \"There is no cache yet\" is legitimate — and only that…\n");
    {
      const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-fresh-"));
      const fRec = path.join(fresh, "record");
      fs.mkdirSync(path.join(fRec, "daily"), { recursive: true });
      fs.writeFileSync(path.join(fRec, "daily", "whoop.csv"), "date,sleep_hours\n2026-08-01,7.4\n");
      const built = asRequest(() => threw(() => landDailySources(["whoop"], { recordDir: fRec })));
      check("a fresh install with no cache still builds one from a request", built === null, built?.message ?? "");
      check("…and the cache exists afterwards", fs.existsSync(path.join(fresh, "agentqs.db")));
      fs.rmSync(fresh, { recursive: true, force: true });
    }
    {
      // The other reason there is no cache: someone deleted it under a real
      // record. Deriving THAT in a request is the freeze, so it is refused.
      fs.rmSync(dbFile, { force: true });
      const refused = asRequest(() => threw(() => landDailySources(["whoop"], { recordDir: rDir })));
      check("a big record with no cache refuses to build one in a request", refused !== null, refused ? "" : "IT REBUILT");
      check(
        "…and points at the converger",
        Boolean(refused && /agentqs rebuild/.test(refused.message)),
        refused?.message.slice(0, 90) ?? "",
      );
      check(
        "…while the CLI/scheduler may still build it",
        threw(() => landDailySources(["whoop"], { recordDir: rDir })) === null,
      );
    }
    rebuild({ recordDir: rDir }); // back to a healthy cache for the rest

    // ---- 4. the request that froze production ------------------------------
    console.log("\n4. Structuring from a request: no rebuild, inside a fixed budget…\n");
    const { items } = appendInboxItems(
      [{ id: "to-structure", text: "date,mood\n2026-08-01,7\n2026-08-02,8\n", source: "drop", kind: "csv" }],
      { recordDir: rDir },
    );
    landInboxCaptures(items, { recordDir: rDir });

    // A row only a REBUILD would remove: it exists in the cache and in no record
    // file. If the structure re-derived the record, it is gone.
    const sentinel = new Database(dbFile);
    sentinel
      .prepare("INSERT OR REPLACE INTO daily (date,source,metric,value_num,value_text) VALUES (?,?,?,?,?)")
      .run("1999-01-01", "sentinel", "canary", 1, "1");
    sentinel.close();

    const t0 = process.hrtime.bigint();
    const run = await asRequest(() => structurePending({ id: "to-structure" }));
    const structureMs = Number(process.hrtime.bigint() - t0) / 1e6;

    check("the structure succeeded on the request path", run.ok && run.structured === 1, run.error ?? `structured ${run.structured}`);
    const wrote = run.results[0]?.source ?? "";
    const db = new Database(dbFile, { readonly: true });
    const canary = db.prepare("SELECT 1 FROM daily WHERE source = 'sentinel'").get();
    const landedCells = (
      db.prepare("SELECT COUNT(*) AS n FROM daily WHERE source = ? AND metric = 'mood'").get(wrote) as { n: number }
    ).n;
    db.close();
    check("NOTHING was rebuilt — the sentinel row survived", Boolean(canary), canary ? "" : "the cache was re-derived");
    check("…and the structured cells really landed", landedCells === 2, `${wrote}.mood rows=${landedCells}`);

    // The budget. Absolute, because a user-facing action has an absolute cost;
    // and relative, so a slower machine proves the same thing.
    const BUDGET_MS = 1_000;
    check(
      `structuring one item took under ${BUDGET_MS}ms`,
      structureMs < BUDGET_MS,
      `${Math.round(structureMs)}ms (a rebuild of this record: ${Math.round(rebuildMs)}ms)`,
    );
    check(
      "…and is at least 10× cheaper than the rebuild it used to fall back to",
      structureMs * 10 < rebuildMs,
      `${Math.round(rebuildMs / Math.max(structureMs, 0.01))}× faster`,
    );

    // ---- 5. the patch is sized to the change -------------------------------
    console.log("\n5. Work proportional to the EDIT, not to the record…\n");
    const wholeInboxMs = ms(() => landInboxStream({ recordDir: rDir }));
    const oneRowMs = ms(() => landInboxIds(["cap-0"], { recordDir: rDir }));
    check(
      "landing ONE inbox row beats re-landing the whole stream",
      oneRowMs * 5 < wholeInboxMs,
      `${oneRowMs.toFixed(1)}ms vs ${wholeInboxMs.toFixed(1)}ms for ${INBOX_ITEMS} captures`,
    );
    const fullGuardMs = ms(() => columnGuard(rDir));
    const scopedGuardMs = ms(() => columnGuard(rDir, { sources: ["notes"] }));
    check(
      "the post-structure column check is scoped to what changed",
      scopedGuardMs < fullGuardMs,
      `${scopedGuardMs.toFixed(1)}ms scoped vs ${fullGuardMs.toFixed(1)}ms full`,
    );
    // A prose source re-landing unchanged cells must not scan the FTS index.
    const prosePatchMs = ms(() => landDailySources(["notes"], { recordDir: rDir }));
    check(
      "re-landing a prose source does not scan the search index",
      prosePatchMs < rebuildMs / 10,
      `${prosePatchMs.toFixed(1)}ms`,
    );

    // ---- 6. a patched cache is a rebuilt cache -----------------------------
    console.log("\n6. The patched cache is EXACTLY what a rebuild would leave…\n");
    const refDb = path.join(root, "reference.db");
    rebuild({ recordDir: rDir, dbPath: refDb });
    const patched = snapshot(dbFile);
    const rebuilt = snapshot(refDb);
    for (const table of ["daily", "events", "inbox", "sessions", "search"] as const) {
      // The sentinel is ours, not the record's — drop it from the comparison.
      const a = table === "daily" ? patched[table].replace(/\{"date":"1999-01-01"[^}]*\},?/g, "") : patched[table];
      check(`${table} matches a full rebuild`, a === rebuilt[table], a === rebuilt[table] ? "" : "MISMATCH");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nAll freeze-guard checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

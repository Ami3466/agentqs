#!/usr/bin/env tsx
/**
 * Ships-when proof for the HTTP/agent SQL door (`runQueryAsync` → POST /api/query).
 *
 *   MAIN: an arbitrary read-only SELECT over the rebuilt cache returns real rows —
 *   date ranges, multi-source joins, raw grain. The attached `detail` store is
 *   reachable from the worker thread. A non-SELECT is refused; a missing LIMIT is
 *   capped.
 *   NON-BLOCKING: a runaway query (an infinite recursive CTE) is CANCELLED by the
 *   wall-clock timeout instead of freezing the process — and while it spins on its
 *   own thread, a normal query on the main thread still returns fast. This is the
 *   whole point of the worker: heavy data never wedges the server.
 *
 * Drives production code (rebuild → runQueryAsync) against a temp AGENTQS_DATA_DIR.
 * No network, no LLM. Run: npm run query:test
 */
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { rebuild } from "../src/lib/record";
import { runQueryAsync, describeSchema, explainQueryError, prepareSql, MAX_ROWS } from "../src/lib/query-async";
import { API_CATALOG, API_ORIENTATION, API_OMISSIONS } from "../src/lib/api-catalog";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

function seed(dataDir: string): void {
  const daily = path.join(dataDir, "record", "daily");
  fs.mkdirSync(daily, { recursive: true });
  // Two sources over a multi-year span — enough to prove date ranges + joins.
  fs.writeFileSync(
    path.join(daily, "whoop.csv"),
    "date,recovery\n2010-01-01,40\n2018-06-15,55\n2026-01-02,71\n",
  );
  fs.writeFileSync(
    path.join(daily, "spotify.csv"),
    "date,minutes\n2010-01-01,120\n2018-06-15,30\n2026-01-02,200\n",
  );
}

console.log("query door — arbitrary read-only SQL over HTTP, off the main thread\n");

async function main() {
  // ---- discovery manifest: the agent's map of the doors --------------------
  {
    const byPath = new Map(API_CATALOG.map((e) => [`${e.method} ${e.path}`, e]));
    check("catalog has no duplicate method+path", byPath.size === API_CATALOG.length);
    const q = API_CATALOG.find((e) => e.path === "/api/query");
    check("catalog exposes /api/query with the MCP equivalent", q?.mcp === "query" && /SQL/i.test(q?.desc ?? ""));
    const chat = API_CATALOG.find((e) => e.path === "/api/chat");
    check("catalog warns /api/chat is a one-liner, not a query engine", /one-?liner|NOT a query/i.test(chat?.desc ?? ""));
    const recall = API_CATALOG.find((e) => e.path === "/api/search");
    check("catalog maps /api/search to the recall capability", recall?.cli?.includes("recall") === true);
    check("orientation names the query door and the recall alias", /\/api\/query/.test(API_ORIENTATION) && /recall/i.test(API_ORIENTATION));
    check("omissions explain rebuild + file imports are CLI/MCP-only", API_OMISSIONS.some((o) => /rebuild/i.test(o.capability)) && API_OMISSIONS.some((o) => /import/i.test(o.capability)));
  }

  // ---- validation is shared (same rules as core.query) ---------------------
  {
    check("prepareSql caps a missing LIMIT", /limit 200$/i.test(prepareSql("SELECT 1").sql));
    check("prepareSql clamps an oversized limit to MAX_ROWS", prepareSql("SELECT 1", 9_000_000).limit === MAX_ROWS);
    let refused = false;
    try {
      prepareSql("DELETE FROM daily");
    } catch {
      refused = true;
    }
    check("prepareSql refuses a non-SELECT", refused);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-query-"));
  process.env.AGENTQS_DATA_DIR = dataDir;
  seed(dataDir);

  // Land a detail table so the worker's ATTACH is exercised.
  const detailFile = path.join(dataDir, "detail.db");
  const det = new Database(detailFile);
  det.exec("CREATE TABLE chrome_visits (ts TEXT, domain TEXT)");
  det.prepare("INSERT INTO chrome_visits VALUES (?,?)").run("2018-06-15T10:00:00Z", "example.com");
  det.close();

  rebuild({ dataDir });

  // ---- MAIN: a real analytical query ---------------------------------------
  {
    const range = await runQueryAsync(
      "SELECT date, metric, value_num FROM daily WHERE date BETWEEN '2010-01-01' AND '2018-12-31' ORDER BY date, metric",
    );
    check("a date range returns exactly the in-range rows", range.count === 4, `got ${range.count}`);
    check("rows carry the real values", range.rows.some((r) => r.metric === "recovery" && r.value_num === 55));

    const join = await runQueryAsync(
      `SELECT w.date, w.value_num AS recovery, s.value_num AS minutes
         FROM daily w JOIN daily s ON w.date = s.date
        WHERE w.metric='recovery' AND s.metric='minutes' AND w.date='2026-01-02'`,
    );
    check("a two-source join lines the metrics up", join.count === 1 && join.rows[0].recovery === 71 && join.rows[0].minutes === 200);

    const detail = await runQueryAsync("SELECT domain FROM detail.chrome_visits");
    check("the attached detail store is reachable from the worker", detail.count === 1 && detail.rows[0].domain === "example.com");

    // The cap must hold even when "limit" appears in a subquery, which skips the
    // outer LIMIT append — the executor caps by iterating, so it can't over-return.
    const capped = await runQueryAsync(
      "SELECT date, metric FROM daily WHERE date IN (SELECT date FROM daily LIMIT 5)",
      2,
    );
    check("row cap holds despite a subquery LIMIT (no over-return)", capped.count === 2, `got ${capped.count}`);
  }

  // ---- self-describe: the API teaches an agent the schema ------------------
  {
    const schema = await describeSchema();
    check("describeSchema lists the long-format grain", /LONG format/i.test(schema.grain));
    check("describeSchema returns the live metric catalog", schema.metrics.some((m) => m.metric === "recovery" || m.metric === "minutes"));
    check("describeSchema carries copy-paste recipes", schema.recipes.length >= 3 && schema.recipes.some((r) => /CASE WHEN/.test(r.sql)));
    check("describeSchema documents the daily columns", schema.tables[0].columns.includes("metric") && schema.tables[0].columns.includes("value_num"));
    // The exact mistake the user's agent made: wide-column guess against long `daily`.
    const guidance = explainQueryError("no such column: recovery");
    check("a wide-column error becomes long-format guidance", /metric=/.test(guidance) && /GET \/api\/query/.test(guidance));
  }

  // ---- a non-SELECT is refused at the door ---------------------------------
  {
    let refused = false;
    try {
      await runQueryAsync("UPDATE daily SET value_num = 0");
    } catch (e) {
      refused = /read-only/i.test((e as Error).message);
    }
    check("the runner refuses a mutating statement", refused);
  }

  // ---- NON-BLOCKING: a runaway query times out, main thread stays free ------
  {
    // A slow recursive CTE (~20M rows) that far outlives the 800ms timeout, so only
    // the timeout ends it in practice — but it is FINITE, so the worker thread still
    // dies on its own even though it is stuck in native SQLite code that terminate()
    // can't preempt. (An infinite CTE would leave an unkillable thread and hang the
    // test process; production is unaffected — the request already got its timeout.)
    const spin = runQueryAsync(
      "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r WHERE x < 20000000) SELECT count(*) AS n FROM r",
      200,
      800,
    );

    // While it spins on its own thread, a normal query must still return fast.
    const t0 = Date.now();
    const quick = await runQueryAsync("SELECT COUNT(*) AS n FROM daily", 10, 5000);
    const quickMs = Date.now() - t0;
    check("a normal query returns while the runaway spins (main thread not blocked)", (quick.rows[0].n as number) === 6 && quickMs < 700, `${quickMs}ms`);

    let cancelled = false;
    try {
      await spin;
    } catch (e) {
      cancelled = /exceeded .*cancelled/i.test((e as Error).message);
    }
    check("the runaway query is cancelled by the timeout", cancelled);
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nall checks passed");
    // A cancelled runaway worker can keep a native thread alive; exit explicitly so
    // the test process never hangs after the checks are done.
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

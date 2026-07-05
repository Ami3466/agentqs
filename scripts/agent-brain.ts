#!/usr/bin/env tsx
/**
 * Ships-when proof for Loop 4 · Agent brain (grounded chat).
 *
 *   1. The two agent tools are real: query_daily runs SQL over the daily table and
 *      returns the user's actual numbers; search_notes finds memos/sessions by
 *      keyword over the FTS5 index.
 *   2. The full mentor agent (Vercel AI SDK, provider-agnostic) answers
 *      "why have I felt off?" by *calling* query_daily, getting real rows back,
 *      and citing those exact numbers — proven by asserting the reply quotes a
 *      value that genuinely exists in the daily table.
 *   3. (Optional) With ANTHROPIC_API_KEY set, the same runMentor path is exercised
 *      against the real Claude API and must cite a number too.
 *
 * Drives the production code: mentorTools + runMentor (the exact functions
 * /api/chat uses) against a real SQLite cache rebuilt from samples/record. The
 * model is a scripted mock so the test is deterministic and offline, but every
 * number in the answer flows through the real tool → real DB → back into the model.
 *
 * Run: npm run agent:test
 */
import fs from "fs";
import os from "os";
import path from "path";
import { MockLanguageModelV4 } from "ai/test";
import { rebuild } from "../src/lib/record";
import { openReadonly } from "../src/lib/db";
import { mentorTools, runMentor, resolveModel } from "../src/lib/agent";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

/** Numbers actually present in the daily table for a given source/metric. */
function realValues(dbFile: string, source: string, metric: string): number[] {
  const db = openReadonly(dbFile);
  try {
    return (
      db
        .prepare(`SELECT value_num AS n FROM daily WHERE source=? AND metric=? AND value_num IS NOT NULL`)
        .all(source, metric) as { n: number }[]
    ).map((r) => r.n);
  } finally {
    db.close();
  }
}

/** A mock LanguageModel that plays the agent's part: first turn it calls
 *  query_daily for the user's WHOOP sleep + recovery; once the real rows come back
 *  in the prompt, it reads the lowest sleep and recovery *from that tool result*
 *  and cites them. So any number in its reply provably came out of the daily table. */
function scriptedMentor() {
  return new MockLanguageModelV4({
    doGenerate: (async (options: { prompt: unknown }) => {
      const dump = JSON.stringify(options.prompt ?? "");
      const seenResult = dump.includes("tool-result") && dump.includes("value_num");
      if (!seenResult) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "q1",
              toolName: "query_daily",
              input: JSON.stringify({
                sql: "SELECT date, source, metric, value_num FROM daily WHERE source='whoop' AND metric IN ('sleep_hours','recovery') ORDER BY date",
              }),
            },
          ],
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      }
      const sleeps = [...dump.matchAll(/"metric":"sleep_hours","value_num":([0-9.]+)/g)].map((m) => Number(m[1]));
      const recs = [...dump.matchAll(/"metric":"recovery","value_num":([0-9.]+)/g)].map((m) => Number(m[1]));
      const minSleep = Math.min(...sleeps);
      const minRec = Math.min(...recs);
      return {
        content: [
          {
            type: "text",
            text:
              `You've felt off because your body was under-recovered: sleep dropped to ${minSleep}h and ` +
              `WHOOP recovery fell to ${minRec}% — the lowest in the window. Guard tonight's sleep and it lifts.`,
          },
        ],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    }) as never,
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-agent-"));
  const dbFile = path.join(root, "agentqs.db");
  const r = rebuild({ recordDir: "samples/record", dbPath: dbFile });
  console.log(`\nRebuilt the sample cache: ${r.daily} daily rows, ${r.sessions} sessions, ${r.inbox} inbox.\n`);

  // ---- 1. The tools are real ------------------------------------------------
  console.log("Ships-when 1 — the SQL + FTS tools return real record data");
  const used = { sources: new Set<string>(), metrics: new Set<string>(), hits: 0 };
  const tools = mentorTools(dbFile, used);
  const opts = { toolCallId: "t", messages: [] } as never;

  const q = (await tools.query_daily.execute!(
    { sql: "SELECT date, source, metric, value_num FROM daily WHERE source='whoop' AND metric='sleep_hours' ORDER BY date" },
    opts,
  )) as { rowCount?: number; rows?: { value_num: number }[]; error?: string };
  check("query_daily runs a SELECT and returns rows", Boolean(q.rows && q.rows.length > 0), q.error ?? `${q.rowCount} rows`);
  check("query_daily returns real numeric values", Boolean(q.rows?.some((row) => typeof row.value_num === "number")));

  const rejected = (await tools.query_daily.execute!({ sql: "DELETE FROM daily" }, opts)) as { error?: string };
  check("query_daily refuses non-SELECT (read-only)", Boolean(rejected.error), rejected.error);

  const s = (await tools.search_notes.execute!({ query: "sleep" }, opts)) as {
    matches?: { ref: string; snippet: string }[];
  };
  check("search_notes finds memos/sessions by keyword", Boolean(s.matches && s.matches.length > 0), `${s.matches?.length ?? 0} matches`);

  // ---- 2. The agent cites real numbers -------------------------------------
  console.log("\nShips-when 2 — the mentor agent answers 'why have I felt off?' from real numbers");
  const question = "Why have I felt off lately?";
  const run = await runMentor({
    model: scriptedMentor() as never,
    system: "You are the mentor. Ground every claim in the user's real record via the tools.",
    messages: [{ role: "user", content: question }],
    dbFile,
  });
  console.log(`\n  Q: ${question}\n  A: ${run.text}\n`);

  check("the agent called a tool to fetch data", run.toolCalls >= 1, `${run.toolCalls} tool call(s)`);
  check("the reply is flagged grounded in the record", run.grounded);
  check("the grounded answer is attributed to a real source", run.sources.includes("whoop"), run.sources.join(", "));

  const sleepValues = realValues(dbFile, "whoop", "sleep_hours");
  const cited = sleepValues.filter((v) => run.text.includes(String(v)));
  check(
    "the reply quotes a number that genuinely exists in the daily table",
    cited.length > 0,
    `cited ${cited.join(", ")} (real: ${sleepValues.join(", ")})`,
  );

  // ---- 3. Optional: the same path against the real Claude API ---------------
  console.log("\nShips-when 3 — same agent path against a live provider (optional)");
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      const live = await runMentor({
        model: resolveModel("anthropic", key),
        system:
          "You are the mentor. Use the tools to fetch the user's real numbers before answering; cite specific figures.",
        messages: [{ role: "user", content: question }],
        dbFile,
      });
      console.log(`\n  live A: ${live.text}\n`);
      check("live reply cites a number", /\d/.test(live.text));
      check("live reply is grounded via a tool call", live.grounded && live.toolCalls >= 1, `${live.toolCalls} call(s)`);
    } catch (e) {
      check("live call succeeded", false, (e as Error).message);
    }
  } else {
    console.log("  · skipped (set ANTHROPIC_API_KEY to exercise the real Claude API)");
  }

  fs.rmSync(root, { recursive: true, force: true });

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log(
    "\n✓ Agent brain ships: the mentor calls SQL + FTS tools and answers 'why have I felt off?' citing the record's real numbers.\n",
  );
}

void main();

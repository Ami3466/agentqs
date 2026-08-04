#!/usr/bin/env tsx
/**
 * Ships-when proof for the read path at LIFETIME scale: what crosses the wire must
 * be proportional to what is on screen, not to the size of the record.
 *
 * The bug: every Journal read pivoted its whole window into one JSON body and every
 * Graphs read shipped every plottable line. On this record that was a 13MB journal
 * and an 11MB series payload; on a million-cell record, 40MB and 11MB — to render
 * fifty rows and two charts. Past a certain size Chrome will not even file the
 * response in its HTTP cache (net::ERR_CACHE_WRITE_FAILURE), so the tab hangs on its
 * skeleton, which is what "it takes five minutes to load" actually was.
 *
 * Five properties, against production code, no network:
 *
 *   1. A PAGE IS BOUNDED. One page of the journal is a page, whatever the record's
 *      size, and paging back through it never repeats or skips a day at the seam.
 *   2. PAGING == THE WHOLE THING. Walking the pages yields exactly the days (and the
 *      same cell values) a single days=all read returns. A fast path that disagrees
 *      with the slow one is worse than no fast path.
 *   3. A CHART PAYS FOR ITS OWN LINES. Asking for two series returns two series, its
 *      points identical to the same lines inside the full set, and the catalog (the
 *      picker's list) carries no numbers at all.
 *   4. COVERAGE IS MEMOIZED HONESTLY. Recomputing "what did each source land?" walks
 *      every (source, date) entry — 2.5M of them, ~345ms — and the Pipeline tab, the
 *      pipeline report and the prefetcher all ask on every load. Memoized, it must
 *      still invalidate on a write and must not hand callers its own object to
 *      mutate. A fast answer that is wrong is worse than a slow one.
 *   5. THE COLUMN CATALOG IS INDEXED. The "which columns exist?" query that opens
 *      every journal read must not full-scan the daily table.
 *
 * Run: npm run paging:test
 */
import fs from "fs";
import os from "os";
import path from "path";
import { rebuild } from "../src/lib/record";
import { readJournal } from "../src/lib/journal";
import { readGraphSeries } from "../src/lib/graphs";
import { openReadonly } from "../src/lib/db";
import { dbPath } from "../src/lib/paths";

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

/** A record big enough that "send it all" is visibly the wrong answer. */
function seed(recordDir: string, days: number, sources: number, metrics: number): void {
  const dir = path.join(recordDir, "daily");
  fs.mkdirSync(dir, { recursive: true });
  const start = new Date(Date.UTC(2026, 7, 1) - (days - 1) * 86400000);
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10),
  );
  for (let s = 0; s < sources; s++) {
    const cols = Array.from({ length: metrics }, (_, j) => `m${j}`);
    const lines = [`date,${cols.join(",")}`];
    for (let i = 0; i < dates.length; i++) {
      // Deterministic values, so "same cells" is a real comparison.
      lines.push(`${dates[i]},${cols.map((_, j) => (i * 7 + s * 13 + j) % 100).join(",")}`);
    }
    fs.writeFileSync(path.join(dir, `src${s}.csv`), lines.join("\n") + "\n");
  }
}

/** Every cell in a payload, flattened for comparison. */
function cells(d: { days: Array<{ date: string; values: Record<string, { num: number | null }> }> }): string[] {
  return d.days
    .flatMap((day) => Object.entries(day.values).map(([k, v]) => `${day.date}|${k}|${v.num}`))
    .sort();
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-paging-"));
  process.env.AGENTQS_DATA_DIR = root;
  const rDir = path.join(root, "record");
  const DAYS = 900;
  seed(rDir, DAYS, 12, 4); // 43,200 cells — enough for paging to matter, fast to build
  rebuild({ recordDir: rDir });

  try {
    console.log("\nA page is bounded, whatever the record holds…\n");
    const PAGE = 90;
    const p1 = readJournal({ days: PAGE });
    check("page 1 is one page", p1.days.length === PAGE, `${p1.days.length} days`);
    check("…and says more exists", p1.hasMore === true);
    check("…and hands back a cursor", Boolean(p1.oldest), String(p1.oldest));
    check(
      "totals still describe the WHOLE record, not the page",
      p1.totalDays === DAYS,
      `totalDays=${p1.totalDays} vs ${DAYS}`,
    );

    const p2 = readJournal({ days: PAGE, before: p1.oldest! });
    check("page 2 is strictly older — no repeat at the seam", p2.days[0].date < p1.oldest!, `${p2.days[0].date} < ${p1.oldest}`);

    console.log("\nPaging back equals reading it all…\n");
    const paged: typeof p1.days = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const page: ReturnType<typeof readJournal> = cursor
        ? readJournal({ days: PAGE, before: cursor })
        : readJournal({ days: PAGE });
      paged.push(...page.days);
      if (!page.hasMore || !page.oldest) break;
      cursor = page.oldest;
    }
    const all = readJournal({ days: "all" });
    check("every day is reached by paging", paged.length === all.days.length, `${paged.length} vs ${all.days.length}`);
    check(
      "no day is visited twice",
      new Set(paged.map((d) => d.date)).size === paged.length,
      `${new Set(paged.map((d) => d.date)).size} unique of ${paged.length}`,
    );
    check(
      "and every CELL matches the whole-record read",
      JSON.stringify(cells({ days: paged })) === JSON.stringify(cells(all)),
    );

    console.log("\nA chart pays for its own lines…\n");
    const full = readGraphSeries();
    const catalog = readGraphSeries({ catalogOnly: true });
    const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x));
    check("the catalog lists every line", catalog.series.length === full.series.length, `${catalog.series.length}`);
    check("…carrying no numbers at all", catalog.series.every((s) => s.v.length === 0));
    check(
      "…so it is a fraction of the full payload",
      bytes(catalog) * 20 < bytes(full),
      `${(bytes(catalog) / 1024).toFixed(1)}KB vs ${(bytes(full) / 1024).toFixed(1)}KB`,
    );

    const two = full.series.slice(0, 2).map((s) => s.key);
    const sub = readGraphSeries({ keys: two });
    check("asking for two lines returns two", sub.series.length === 2, sub.series.map((s) => s.key).join(","));
    check("…and is far smaller than everything", bytes(sub) * 5 < bytes(full), `${(bytes(sub) / 1024).toFixed(1)}KB`);
    const pts = (d: typeof full, key: string) => {
      const s = d.series.find((x) => x.key === key)!;
      return (s.d ?? s.v.map((_, i) => i)).map((di, i) => `${d.dates[di]}=${s.v[i]}`).join(",");
    };
    check("…with identical points after reindexing", pts(full, two[0]) === pts(sub, two[0]));

    console.log("\nCoverage is memoized without going stale or leaking…\n");
    {
      const { coverageBySource } = await import("../src/lib/daily");
      const first = coverageBySource();
      const again = coverageBySource();
      check(
        "a repeat call returns the same answer",
        JSON.stringify([...first].sort()) === JSON.stringify([...again].sort()),
        `${first.size} sources`,
      );
      // buildSources fills defaults into the map it gets back. If that were the
      // memo's own object, the next reader would inherit the mutation.
      const k = [...first.keys()][0];
      first.get(k)!.events = 987654;
      check("a caller mutating its copy cannot poison the memo", coverageBySource().get(k)!.events !== 987654);

      // A write must invalidate it — a fast answer that is WRONG is the worst outcome.
      const before = coverageBySource().get("src0")?.days ?? 0;
      fs.appendFileSync(path.join(rDir, "daily", "src0.csv"), "1999-01-01,1,2,3,4\n");
      rebuild({ recordDir: rDir });
      const after = coverageBySource().get("src0")?.days ?? 0;
      check("a rebuild invalidates it", after === before + 1, `${before} -> ${after} days`);
    }

    console.log("\nThe column catalog is answered from an index…\n");
    const db = openReadonly(dbPath());
    const plan = (
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT source, metric, COUNT(*)-COUNT(value_num) FROM daily WHERE date <= ? GROUP BY source, metric",
        )
        .all("2026-08-01") as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join(" | ");
    db.close();
    check("it uses the covering index", /COVERING INDEX daily_metric_catalog/.test(plan), plan);
    check("…and builds no temp B-tree", !/TEMP B-TREE/.test(plan));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nAll paging checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

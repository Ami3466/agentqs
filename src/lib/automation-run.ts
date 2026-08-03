/**
 * Automation runner (server-only) — replays a recipe's recorded steps in a real
 * headless browser and lands the scraped table in the daily record.
 *
 * Playwright is loaded with a runtime dynamic import (webpackIgnore) so it never
 * enters the Next bundle and stays an optional dependency: the browser binary is a
 * one-time `npx playwright install chromium`, not part of the app build. If it's
 * missing the runner throws an actionable message instead of a stack trace.
 *
 * Pipeline: launch chromium → goto(url) → replay steps (fill/click/wait/press) →
 * extractTable → wide daily table → mergeDailyCsv(daily/<id>.csv) → cache patch. A
 * table whose first column is a date merges into the daily table; anything else
 * lands raw in the inbox for the Structure step. Same idempotent write every other
 * importer uses, so re-running is safe.
 */
import {
  appendInboxItem,
  landDailySources,
  landInboxCaptures,
  mergeDailyCsv,
  serializeCsv,
} from "./record";
import { recordDir } from "./paths";
import { getAutomation, getCreds, recordRun } from "./automation";
import { interpolateCreds, type AutomationStep } from "./automation-types";

export interface AutomationRunResult {
  id: string;
  name: string;
  landed: "daily" | "inbox";
  rows: number; // cells written (daily) or bytes captured (inbox)
  dailyRows: number; // total daily rows after rebuild
  metrics: string[];
  headers: string[];
  syncedAt: string;
  headless: boolean;
}

// Minimal structural types so this file needs no @types for the optional package.
interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  fill(selector: string, value: string, opts?: Record<string, unknown>): Promise<void>;
  click(selector: string, opts?: Record<string, unknown>): Promise<void>;
  press(selector: string, key: string, opts?: Record<string, unknown>): Promise<void>;
  waitForSelector(selector: string, opts?: Record<string, unknown>): Promise<unknown>;
  $$eval<T>(selector: string, fn: (els: Element[]) => T): Promise<T>;
}
interface PwBrowser {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** Load playwright-core at runtime; keep it out of the webpack graph + optional. */
async function loadChromium(): Promise<{ launch(opts: Record<string, unknown>): Promise<PwBrowser> }> {
  const spec = "playwright-core";
  try {
    const mod = (await import(/* webpackIgnore: true */ spec)) as {
      chromium: { launch(opts: Record<string, unknown>): Promise<PwBrowser> };
    };
    return mod.chromium;
  } catch {
    throw new Error(
      "Browser automation needs Playwright. Install it once:\n  npm i playwright-core && npx playwright install chromium",
    );
  }
}

/** Scrape a <table> (or any container of rows) into a header + rows grid. */
async function extractTable(page: PwPage, selector: string): Promise<string[][]> {
  const sel = selector && selector.trim() ? selector.trim() : "table";
  const grid = await page.$$eval(`${sel} tr`, (trs) =>
    (trs as Element[]).map((tr) =>
      Array.from(tr.querySelectorAll("th,td")).map((c) => (c.textContent ?? "").trim()),
    ),
  );
  return grid.filter((r) => r.some((c) => c !== ""));
}

async function runStep(page: PwPage, step: AutomationStep, creds: ReturnType<typeof getCreds>): Promise<string[][] | null> {
  const val = interpolateCreds(step.value, creds);
  switch (step.type) {
    case "goto":
      if (val) await page.goto(val, { waitUntil: "domcontentloaded" });
      return null;
    case "fill":
      if (step.selector) await page.fill(step.selector, val);
      return null;
    case "click":
      if (step.selector) await page.click(step.selector);
      return null;
    case "press":
      await page.press(step.selector || "body", val || "Enter");
      return null;
    case "waitForSelector":
      if (step.selector) await page.waitForSelector(step.selector, { timeout: 20000 });
      return null;
    case "extractTable":
      return extractTable(page, step.selector || "table");
    default:
      return null;
  }
}

/**
 * Replay one recipe end to end. `headed` opens a visible browser (so a user can
 * watch / solve a login on their own machine); the default is headless for the
 * scheduled cron path. Persists the run outcome on the recipe either way.
 */
export async function runAutomation(
  id: string,
  opts: { headed?: boolean; recordDir?: string } = {},
): Promise<AutomationRunResult> {
  const recipe = getAutomation(id);
  if (!recipe) throw new Error(`No automation "${id}".`);
  const creds = getCreds(id);
  const rDir = opts.recordDir ?? recordDir();
  const headless = !opts.headed;
  const at = new Date().toISOString();

  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless });
  let grid: string[][] | null = null;
  try {
    const page = await browser.newPage();
    await page.goto(recipe.url, { waitUntil: "domcontentloaded" });
    for (const step of recipe.steps) {
      const captured = await runStep(page, step, creds);
      if (captured) grid = captured;
    }
  } catch (e) {
    await browser.close().catch(() => undefined);
    recordRun(id, { status: "error", error: (e as Error).message, at });
    throw new Error(`Automation "${id}" failed: ${(e as Error).message}`);
  }
  await browser.close().catch(() => undefined);

  if (!grid || grid.length < 2) {
    recordRun(id, { status: "error", error: "No table captured — check the extractTable selector.", at });
    throw new Error(
      `Automation "${id}" captured no data. Add an extractTable step, or fix its selector.`,
    );
  }

  const [header, ...rows] = grid;
  const looksDated = rows.some((r) => DATE_RE.test((r[0] ?? "").trim()));

  if (looksDated) {
    const table = { header: header.map((h) => (h || "date").trim()), rows };
    // Force the first column to the canonical "date" so it merges into the timeline.
    table.header[0] = "date";
    const merge = mergeDailyCsv(rDir, id, table);
    const dailyRows = landDailySources([id], { recordDir: rDir });
    recordRun(id, { status: "ok", rows: merge.cells, at });
    return {
      id, name: recipe.name, landed: "daily", rows: merge.cells, dailyRows,
      metrics: merge.metrics, headers: table.header, syncedAt: at, headless,
    };
  }

  // Not a dated table — keep it raw in the inbox for the Structure step.
  const csv = serializeCsv(header, rows);
  const item = appendInboxItem(
    { text: csv, source: "automation", kind: "csv", meta: { automation: id, filename: `${id}.csv` } },
    { recordDir: rDir },
  );
  landInboxCaptures([item], { recordDir: rDir });
  const dailyRows = landDailySources([], { recordDir: rDir });
  recordRun(id, { status: "ok", rows: Buffer.byteLength(csv), at });
  return {
    id, name: recipe.name, landed: "inbox", rows: rows.length, dailyRows,
    metrics: [], headers: header, syncedAt: at, headless,
  };
}

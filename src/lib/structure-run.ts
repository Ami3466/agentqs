/**
 * The Structure step, extracted so every face shares one implementation: the
 * /api/structure route, the `agentqs structure` CLI, and the MCP `structure` tool
 * all call `structurePending`. Drains pending inbox captures into the daily table
 * — clean CSV maps straight to columns (free, no LLM); prose goes through the
 * model to the same wide shape (paid, only here). Server-only (fs + provider).
 */
import crypto from "crypto";
import { activeLlm, autoStructureEnabled, readConfig } from "./config";
import { wipeDemoOnImport } from "./demo";
import { recordDir } from "./paths";
import {
  appendInboxItems,
  landDailySources,
  landInboxStream,
  mergeDailyCsv,
  readInboxFromRecord,
  updateInboxItems,
  type InboxItem,
} from "./record";
import { llmComplete } from "./llm";
import { acceptQualityAction, columnGuard, qualityActionOf, splitColumnKey } from "./column-scan";
import {
  parseLlmCsv,
  proseExtractionSystem,
  proseExtractionUser,
  sourceName,
  structureCsv,
  type Structured,
} from "./structure";

/** One line naming what a CSV parse lost — shared by errors and notifications. */
export function csvLossText(s: Structured): string {
  const parts: string[] = [];
  if (s.skippedRows) {
    parts.push(
      `${s.skippedRows} row(s) with data but no parseable date (e.g. ${s.skippedSamples.map((x) => `"${x}"`).join(", ")})`,
    );
  }
  if (s.droppedColumns) parts.push(`${s.droppedColumns} column(s) with data but an empty header`);
  // The daily table is one row per date, so rows sharing a date overwrite each other.
  if (s.duplicateDates) {
    parts.push(
      `${s.duplicateDates} row(s) share a date with an earlier row — this is per-EVENT data, and the daily table holds one row per day, so only the last row of each date would survive. Roll it up first (sum / count / average — only you know which)`,
    );
  }
  return parts.join("; ");
}

/** A "structured" file that silently shed rows is how a record rots — persist
 *  the loss as a pending notification. ONE per file (stable id from the hint),
 *  latest run wins: partially fixing a file and re-importing must update the
 *  warning, not stack a contradictory second one. Used by every channel that
 *  structures a FILE the user can't regenerate on the spot; agent-supplied CSV
 *  is rejected outright instead. */
export function notifyCsvLoss(rDir: string, hint: string | undefined, s: Structured): number {
  const loss = csvLossText(s);
  // An ambiguous date column is NOT a loss — every row landed. It is a GUESS, and the
  // difference matters: "did not fully land, fix and re-import" would be a lie, and a
  // warning that misdescribes itself is a warning nobody reads twice. But an unremarked
  // guess silently misfiles half a European year (05/07 is 5 July, and it landed on 7
  // May), so it still has to be said out loud — just truthfully.
  const guess = s.ambiguousDateOrder
    ? `its dates are written 05/07-style and the file never says whether that is D/M or M/D (no value is over 12), so they were read as US M/D — if this file is European, every date in it is wrong`
    : "";
  if (!loss && !guess) return 0;
  const text = loss
    ? `CSV import${hint ? ` "${hint}"` : ""} did NOT fully land: ${loss}. The other rows merged; fix the file and re-import to recover these.${guess ? ` Also: ${guess}.` : ""}`
    : `CSV import${hint ? ` "${hint}"` : ""} landed in full, but ${guess}.`;
  const id = `csvloss-${crypto.createHash("sha256").update(hint ?? text).digest("hex").slice(0, 16)}`;
  const item = {
    text,
    status: "pending",
    meta: {
      kind: "import-loss",
      hint: hint ?? null,
      skippedRows: s.skippedRows,
      skippedSamples: s.skippedSamples,
      droppedColumns: s.droppedColumns,
    },
  };
  const patched = updateInboxItems([{ id, ...item }], { recordDir: rDir });
  if (!patched) {
    appendInboxItems([{ id, source: "import", kind: "notification", ...item }], { recordDir: rDir });
  }
  return 1;
}

export type StructureRoute = "csv" | "llm" | "agent" | "fix";
export type StructureStatus = "structured" | "empty" | "error";

export interface StructureItemResult {
  id: string;
  route: StructureRoute;
  status: StructureStatus;
  source?: string;
  rowsAdded?: number;
  metrics?: string[];
  dates?: number;
  message?: string;
}

export interface StructureRunResult {
  ok: boolean;
  structured: number;
  results: StructureItemResult[];
  pending: number;
  dailyRows: number | null;
  /** The column scanner's post-structure pass (see column-scan.ts). */
  scan?: { autoMerged: number; findings: number; notified: number };
  error?: string;
}

function filenameOf(item: InboxItem): string | undefined {
  const m = item.meta;
  if (m && typeof m === "object" && "filename" in m) {
    const f = (m as { filename?: unknown }).filename;
    if (typeof f === "string" && f.trim()) return f;
  }
  return undefined;
}

/** Auto-structure (Settings): structure a fresh capture immediately so it skips the
 *  pending inbox. No-op when the toggle is off. Never throws — a failed attempt just
 *  leaves the item pending, exactly as it was before. */
export async function autoStructureNewItem(id: string): Promise<StructureRunResult | null> {
  if (!autoStructureEnabled(readConfig())) return null;
  try {
    return await structurePending({ id });
  } catch {
    return null;
  }
}

/** Drain pending inbox items into daily rows. `{id}` structures one; `{}` drains all.
 *  `{id, csv}` is the key-free agent route: a CLI agent (e.g. Codex) reads
 *  the pending item itself and SUPPLIES the extracted daily CSV — same validation,
 *  merge, and undo metadata as the LLM route, no API key involved. */
export async function structurePending(
  opts: { id?: string; all?: boolean; csv?: string } = {},
): Promise<StructureRunResult> {
  if (opts.csv && !opts.id) {
    return {
      ok: false,
      structured: 0,
      results: [],
      pending: 0,
      dailyRows: null,
      error: "csv requires id — an agent structures one item at a time.",
    };
  }
  // Structuring real data is a real import — clear the demo record first, from EVERY
  // face (GUI button, CLI, MCP, agent tool, auto-structure), so real rows never merge
  // into demo CSVs that a later wipe would delete.
  wipeDemoOnImport();
  const rDir = recordDir();
  // Inbox stream only - readRecord would parse the (huge) events.jsonl for nothing.
  const pending = readInboxFromRecord(rDir).filter((i) => i.status === "pending");

  let targets = pending;
  if (opts.id) targets = pending.filter((i) => i.id === opts.id);
  if (targets.length === 0) {
    return {
      ok: false,
      structured: 0,
      results: [],
      pending: pending.length,
      dailyRows: null,
      error: opts.id ? "That item isn't in the pending inbox." : "Nothing pending to structure.",
    };
  }

  const cfg = readConfig();
  const llm = activeLlm(cfg);
  const hasLlm = Boolean(llm);

  const results: StructureItemResult[] = [];
  const patches: Array<{ id: string; status: string; meta: unknown }> = [];
  let mutated = false;

  for (const item of targets) {
    // Scanner notifications ARE a type of structuring: instead of extracting a
    // CSV, structuring one applies its data-quality fix (merge the duplicate,
    // drop the dead column, clean the messy values). Undo metadata mirrors a
    // normal merge.
    if (item.kind === "notification") {
      const action = qualityActionOf(item.meta);
      if (!action) {
        results.push({ id: item.id, route: "fix", status: "empty", message: "Notification carries no fix action." });
        continue;
      }
      const outcome = acceptQualityAction(rDir, action);
      if (outcome.applied.length) mutated = true;
      patches.push({
        id: item.id,
        status: "structured",
        meta: {
          ...(item.meta && typeof item.meta === "object" ? item.meta : {}),
          structuredAt: new Date().toISOString(),
          via: action.type,
          source: outcome.source,
          cells: outcome.cells,
          applied: outcome.applied,
        },
      });
      results.push({
        id: item.id,
        route: "fix",
        status: "structured",
        source: outcome.source,
        rowsAdded: outcome.cells,
        metrics: [outcome.metric],
        dates: outcome.cells,
        message: outcome.summary,
      });
      continue;
    }
    // Images never structure here — their body is a base64 data URL, not notes
    // (the Photos import owns pictures). Skip before burning an LLM call on it.
    if (item.kind === "image" || item.text.startsWith("data:")) {
      results.push({ id: item.id, route: "csv", status: "empty", message: "Image capture — use the Photos import for pictures." });
      continue;
    }
    const hint = filenameOf(item);
    let structured = opts.csv ? structureCsv(parseLlmCsv(opts.csv)) : structureCsv(item.text);
    let route: StructureRoute = opts.csv ? "agent" : "csv";
    let source: string;

    // Agent-supplied CSV is rejected ATOMICALLY on any loss — the agent can fix
    // the dates and resend, so nothing is merged from a CSV that sheds rows.
    if (structured && opts.csv && (structured.skippedRows || structured.droppedColumns)) {
      results.push({
        id: item.id,
        route: "agent",
        status: "error",
        message: `Nothing merged — the CSV loses data: ${csvLossText(structured)}. Every row needs a YYYY-MM-DD date and every column a header; fix and resend.`,
      });
      continue;
    }

    if (structured) {
      source = sourceName(hint, opts.csv ? "notes" : "import");
    } else if (opts.csv) {
      results.push({
        id: item.id,
        route: "agent",
        status: "error",
        message:
          "That CSV didn't parse into dated rows. First column must be `date` with YYYY-MM-DD values, every other column one snake_case metric, one row per date.",
      });
      continue;
    } else {
      route = "llm";
      if (!hasLlm) {
        results.push({
          id: item.id,
          route,
          status: "error",
          message:
            "No AI key configured. Add one in Settings, or structure key-free with a CLI agent: `agentqs structure --id <id> --csv '<date,... CSV>'`.",
        });
        continue;
      }
      const captureDate = (item.ts || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      let out = "";
      try {
        out = await llmComplete({
          llm: llm!,
          system: proseExtractionSystem(),
          messages: [{ role: "user", content: proseExtractionUser(item.text, captureDate) }],
          // Multi-date documents (timelines, exports) produce one CSV row per date —
          // a small cap truncated them mid-table and collapsed history onto one day.
          maxTokens: 4000,
        });
      } catch (e) {
        results.push({ id: item.id, route, status: "error", message: `Model call failed: ${(e as Error).message}` });
        continue;
      }
      structured = structureCsv(parseLlmCsv(out));
      source = sourceName(hint, "notes");
      if (!structured) {
        results.push({ id: item.id, route, status: "empty", message: "No dated metrics found in that note." });
        continue;
      }
    }

    const merge = mergeDailyCsv(rDir, source, { header: structured.header, rows: structured.rows });
    // A FILE that sheds rows gets a persisted loss notification — the user
    // can fix the file and re-import. LLM output shedding rows is the model's
    // formatting, not the user's data: "fix the file" would be nonsense, so
    // the loss travels in the result message instead.
    if (route === "csv") notifyCsvLoss(rDir, hint, structured);
    const llmLoss = route === "llm" ? csvLossText(structured) : "";
    mutated = true;
    patches.push({
      id: item.id,
      status: "structured",
      meta: {
        ...(item.meta && typeof item.meta === "object" ? item.meta : {}),
        structuredAt: new Date().toISOString(),
        via: route,
        source,
        cells: merge.cells,
        metrics: merge.metrics,
        // Exact cells this item changed (with prior values) — lets the Log's
        // Reject undo the merge by replaying them in reverse.
        applied: merge.applied,
      },
    });
    results.push({
      id: item.id,
      route,
      status: "structured",
      source,
      rowsAdded: merge.cells,
      metrics: merge.metrics,
      dates: merge.dates.length,
      ...(llmLoss ? { message: `Model output lost data: ${llmLoss}. Re-structure the item if those facts matter.` } : {}),
    });
  }

  if (patches.length) updateInboxItems(patches, { recordDir: rDir });
  // The post-structure column check: re-apply saved merge rules and queue a
  // notification for any NEW duplicate the fresh rows just created — before the
  // cache patch, so the cache already reflects both.
  const guard = mutated ? columnGuard(rDir) : null;
  // Only the sources this run wrote (plus both sides of any merge rule it
  // re-applied). A full rebuild here re-derived every event in the record —
  // minutes of frozen server for a handful of structured cells.
  const touched = [
    ...new Set([
      ...results.flatMap((r) => (r.status === "structured" && r.source ? [r.source] : [])),
      ...(guard?.autoMerged ?? []).flatMap((o) => [
        splitColumnKey(o.from).source,
        splitColumnKey(o.into).source,
      ]),
    ]),
  ].filter(Boolean);
  const dailyRows = mutated ? landDailySources(touched, { recordDir: rDir }) : null;
  if (mutated) landInboxStream({ recordDir: rDir });
  const remaining = readInboxFromRecord(rDir).filter((i) => i.status === "pending").length;

  return {
    ok: true,
    structured: results.filter((r) => r.status === "structured").length,
    results,
    pending: remaining,
    dailyRows,
    ...(guard
      ? { scan: { autoMerged: guard.autoMerged.length, findings: guard.findings.length, notified: guard.notified } }
      : {}),
  };
}

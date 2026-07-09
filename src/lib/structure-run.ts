/**
 * The Structure step, extracted so every face shares one implementation: the
 * /api/structure route, the `agentqs structure` CLI, and the MCP `structure` tool
 * all call `structurePending`. Drains pending inbox captures into the daily table
 * — clean CSV maps straight to columns (free, no LLM); prose goes through the
 * model to the same wide shape (paid, only here). Server-only (fs + provider).
 */
import { activeLlm, autoStructureEnabled, readConfig } from "./config";
import { wipeDemoOnImport } from "./demo";
import { recordDir } from "./paths";
import { mergeDailyCsv, readInboxFromRecord, rebuild, updateInboxItems, type InboxItem } from "./record";
import { llmComplete } from "./llm";
import { acceptQualityAction, columnGuard, qualityActionOf } from "./column-scan";
import {
  parseLlmCsv,
  proseExtractionSystem,
  proseExtractionUser,
  sourceName,
  structureCsv,
} from "./structure";

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
 *  `{id, csv}` is the key-free agent route: a CLI agent (Claude Code, Codex) reads
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
            "No AI key configured. Add one in Settings, or structure key-free with a CLI agent: `agentqs structure --id <id> --csv '<date,... CSV>'` (see CLAUDE.md).",
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
    });
  }

  if (patches.length) updateInboxItems(patches, { recordDir: rDir });
  // The post-structure column check: re-apply saved merge rules and queue a
  // notification for any NEW duplicate the fresh rows just created — before the
  // rebuild, so the cache already reflects both.
  const guard = mutated ? columnGuard(rDir) : null;
  const rebuilt = mutated ? rebuild({ recordDir: rDir }) : null;
  const remaining = readInboxFromRecord(rDir).filter((i) => i.status === "pending").length;

  return {
    ok: true,
    structured: results.filter((r) => r.status === "structured").length,
    results,
    pending: remaining,
    dailyRows: rebuilt?.daily ?? null,
    ...(guard
      ? { scan: { autoMerged: guard.autoMerged.length, findings: guard.findings.length, notified: guard.notified } }
      : {}),
  };
}

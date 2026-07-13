import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { readConfig } from "./config";
import { recordDir } from "./paths";
import { coverageBySource } from "./daily";
import { buildSources } from "./source-registry";
import { GOOGLE_PRESETS } from "./google-web-scraper";
import { readSyncRuns } from "./sync-runs";
import type { SourceCoverage, SourceProvenance, SourceView } from "./sources";

/**
 * The data-pipeline truth table: for every source, where its data comes from,
 * who established the connection (credential provenance), what schedule it is
 * on, whether a scheduler actually sweeps it, when it last ran and with what
 * outcome, and what data has landed. One brain — the CLI (`agentqs pipeline`),
 * the MCP tool and /api/pipeline all render this object.
 *
 * Exists because states like "connected" used to be derived silently from
 * "data rows exist", making an auto-detected desktop-app integration or a
 * one-shot agent import indistinguishable from a connection the user made.
 */

/** Coverage is the same fact the Pipeline tab shows per row — one shape, one query
 *  (daily.ts), so the CLI truth table and the UI can never disagree. */
export type PipelineCoverage = SourceCoverage;

export interface PipelineRow {
  id: string;
  name: string;
  /** How data arrives. */
  origin: "api" | "file" | "automation" | "extension" | "record";
  connected: boolean;
  /** Why it counts as connected — never implicit. */
  connectedBecause: "credential" | "data-only" | null;
  /** How the data got here when it is NOT a connection (imported CSV, local file,
   *  extension scrape). The honest answer to "connected to what, exactly?". */
  provenance: SourceProvenance | null;
  credentialOrigin: "env" | "saved" | "discovered" | null;
  /** Rows exist in the record — orthogonal to connected (imports never connect). */
  hasData: boolean;
  /** A local desktop app's login is detectable but the user has not approved it. */
  detectedApp: boolean;
  interval: string;
  scheduled: boolean; // interval !== off → sync --due / Pipeline-tab open will run it
  lastSync: string | null;
  lastRun: { at: string; ok: boolean; error?: string } | null;
  /** A background sync job currently queued/running for this source. */
  syncing: { status: string; phase: string; pct: number; startedAt: string } | null;
  data: PipelineCoverage;
}

export interface SchedulerStatus {
  /** com.agentqs.autosync launchd agent present (macOS). */
  launchd: boolean;
  /** A crontab line mentioning agentqs present. */
  crontab: boolean;
  /** Last `sync --due` sweep heartbeat — null means no sweep has EVER reached
   *  the app, however many schedulers claim to exist. */
  lastDueRunAt: string | null;
}

export interface PipelineReport {
  generatedAt: string;
  sources: PipelineRow[];
  scheduler: SchedulerStatus;
}

export function detectScheduler(home: string = os.homedir()): Omit<SchedulerStatus, "lastDueRunAt"> {
  const launchd = fs.existsSync(path.join(home, "Library", "LaunchAgents", "com.agentqs.autosync.plist"));
  let crontab = false;
  try {
    crontab = /agentqs/.test(execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    /* no crontab / not available — not an error */
  }
  return { launchd, crontab };
}

function rowFromSource(s: SourceView, coverage: Map<string, PipelineCoverage>): PipelineRow {
  const data = coverage.get(s.id) ?? { events: 0, days: 0, from: null, to: null };
  const runs = readSyncRuns().runs;
  const run = runs[s.id];
  // connected ⇔ stored credential. A record-backed row (a dropped CSV, a local
  // file, an unpacked archive) is NOT connected — it carries `provenance` instead,
  // so "connected" can never be answered by "well, there is data".
  const connectedBecause = !s.connected ? null : s.credentialOrigin ? ("credential" as const) : ("data-only" as const);
  return {
    id: s.id,
    name: s.name,
    origin: s.automation ? "automation" : s.kind === "api" ? "api" : "record",
    connected: s.connected,
    connectedBecause,
    provenance: s.provenance ?? null,
    credentialOrigin: s.credentialOrigin ?? null,
    hasData: s.hasData ?? (data.events > 0 || data.days > 0),
    detectedApp: s.detectedApp ?? false,
    interval: String(s.interval),
    scheduled: s.interval !== "off",
    lastSync: s.lastSync,
    lastRun: run ? { at: run.at, ok: run.ok, ...(run.error ? { error: run.error } : {}) } : null,
    syncing:
      s.job && (s.job.status === "queued" || s.job.status === "running")
        ? { status: s.job.status, phase: s.job.phase, pct: s.job.pct, startedAt: s.job.startedAt }
        : null,
    data,
  };
}

/** Chrome-extension presets are owned by the Pipeline tab's Google card, not
 *  buildSources — the pipeline covers them too: origin "extension", manual
 *  (the extension's own daily auto-scrape lives in the browser, not here). */
function extensionRows(coverage: Map<string, PipelineCoverage>): PipelineRow[] {
  return GOOGLE_PRESETS.map((p) => {
    const data = coverage.get(p.source) ?? coverage.get(p.dailySource) ?? { events: 0, days: 0, from: null, to: null };
    const has = data.events > 0 || data.days > 0;
    return {
      id: p.id,
      name: `Google · ${p.label}`,
      origin: "extension" as const,
      // Scraped through the extension = imported, not connected. There is no key
      // here; the browser did the work. Reporting these as connected made a
      // one-off scrape indistinguishable from an authorized, syncing account.
      connected: false,
      connectedBecause: null,
      provenance: has ? ("imported" as const) : null,
      credentialOrigin: null,
      hasData: has,
      detectedApp: false,
      interval: "off",
      scheduled: false,
      lastSync: null,
      lastRun: null,
      syncing: null,
      data,
    };
  });
}

export function pipelineReport(dir: string = recordDir()): PipelineReport {
  const coverage = coverageBySource();
  const sources = buildSources(readConfig(), dir, coverage).map((s) => rowFromSource(s, coverage));
  const seen = new Set(sources.map((s) => s.id));
  for (const row of extensionRows(coverage)) if (!seen.has(row.id)) sources.push(row);
  return {
    generatedAt: new Date().toISOString(),
    sources,
    scheduler: { ...detectScheduler(), lastDueRunAt: readSyncRuns().dueRunAt ?? null },
  };
}

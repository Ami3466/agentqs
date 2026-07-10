import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { readConfig } from "./config";
import { dbPath, recordDir } from "./paths";
import { openReadonly } from "./db";
import { buildSources } from "./source-registry";
import { GOOGLE_PRESETS } from "./google-web-scraper";
import { readSyncRuns } from "./sync-runs";
import type { SourceView } from "./sources";

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

export interface PipelineCoverage {
  events: number;
  days: number;
  from: string | null;
  to: string | null;
}

export interface PipelineRow {
  id: string;
  name: string;
  /** How data arrives. */
  origin: "api" | "file" | "automation" | "extension" | "record";
  connected: boolean;
  /** Why it counts as connected — never implicit. */
  connectedBecause: "credential" | "data-only" | null;
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

/** date-range + counts per source from the cache, both layers at once. */
function coverageBySource(file: string = dbPath()): Map<string, PipelineCoverage> {
  const out = new Map<string, PipelineCoverage>();
  if (!fs.existsSync(file)) return out;
  try {
    const db = openReadonly(file);
    try {
      const daily = db
        .prepare("SELECT source, COUNT(DISTINCT date) AS days, MIN(date) AS f, MAX(date) AS t FROM daily GROUP BY source")
        .all() as Array<{ source: string; days: number; f: string; t: string }>;
      for (const r of daily) out.set(r.source, { events: 0, days: r.days, from: r.f, to: r.t });
      const events = db
        .prepare("SELECT source, COUNT(*) AS n, MIN(date) AS f, MAX(date) AS t FROM events GROUP BY source")
        .all() as Array<{ source: string; n: number; f: string; t: string }>;
      for (const r of events) {
        const cur = out.get(r.source) ?? { events: 0, days: 0, from: null, to: null };
        cur.events = r.n;
        cur.from = cur.from && cur.from < r.f ? cur.from : r.f;
        cur.to = cur.to && cur.to > r.t ? cur.to : r.t;
        out.set(r.source, cur);
      }
    } finally {
      db.close();
    }
  } catch {
    /* stale/older cache — coverage shows as empty rather than failing the report */
  }
  return out;
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
  // connected ⇔ stored credential; record-backed rows (imports) count as
  // "data-only" presence, never as an authorized connection.
  const connectedBecause = !s.connected ? null : s.credentialOrigin ? ("credential" as const) : ("data-only" as const);
  return {
    id: s.id,
    name: s.name,
    origin: s.automation ? "automation" : s.kind === "api" ? "api" : "record",
    connected: s.connected,
    connectedBecause,
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
      connected: has,
      connectedBecause: has ? ("data-only" as const) : null,
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
  const sources = buildSources(readConfig(), dir).map((s) => rowFromSource(s, coverage));
  const seen = new Set(sources.map((s) => s.id));
  for (const row of extensionRows(coverage)) if (!seen.has(row.id)) sources.push(row);
  return {
    generatedAt: new Date().toISOString(),
    sources,
    scheduler: { ...detectScheduler(), lastDueRunAt: readSyncRuns().dueRunAt ?? null },
  };
}

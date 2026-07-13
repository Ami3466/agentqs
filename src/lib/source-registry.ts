/**
 * Server-only source composition (uses fs). Builds the Pipeline-tab sources list by
 * merging a registry of known integrations with the manual sources discovered in
 * the record, then layering each source's saved interval + derived last-sync and
 * computing stale/due via the pure helpers in ./sources.
 *
 * GitHub and WHOOP keep bespoke rows/routes (GitHub for its commit sparkline,
 * WHOOP for its unofficial email+password app login + per-minute stream); the
 * single-credential Tier-1 plugins (RescueTime, Google Calendar, Spotify) are
 * composed generically from the plugin registry so adding one is a single entry.
 */
import fs from "fs";
import path from "path";
import type { AppConfig } from "./config";
import { recordDir } from "./paths";
import { parseGithubCsv, resolveGithubToken } from "./importers/github";
import { PLUGINS, SOURCE_PLUGINS } from "./importers/registry";
import { connectionState } from "./importers/plugin";
import { readSyncRuns } from "./sync-runs";
import { readSyncJobs, type SyncJob } from "./sync-jobs";
import { FILE_IMPORTERS } from "./importers/files/registry";
import { listAutomations } from "./automation";
import type { AutomationRecipe } from "./automation-types";
import { GOOGLE_PRESET_DAILY_SOURCES } from "./google-web-scraper";
import { shouldSkipDailyCsvRead } from "./record";
import { SOURCE_BUNDLES, type SourceBundle } from "./source-bundles";
import {
  isDue,
  isStale,
  isValidInterval,
  type Interval,
  type SourceView,
} from "./sources";

/** Latest sync attempt for a source from the run ledger, as SourceView fields.
 *  Read per row but the ledger is one small JSON — cache it per buildSources
 *  pass via the module-level snapshot below. */
let runsSnapshot: ReturnType<typeof readSyncRuns> | null = null;
let jobsSnapshot: Record<string, SyncJob> | null = null;
function lastRunFields(id: string): {
  lastRunOk: boolean | null;
  lastRunError: string | null;
  job: SyncJob | null;
} {
  const run = (runsSnapshot ?? readSyncRuns()).runs[id];
  return {
    lastRunOk: run ? run.ok : null,
    lastRunError: run?.error ?? null,
    // Live/last background job — the UI's progress bar + poll signal.
    job: (jobsSnapshot ?? readSyncJobs())[id] ?? null,
  };
}

function intervalFor(cfg: AppConfig | null, id: string): Interval {
  const raw = cfg?.sourceIntervals?.[id];
  return isValidInterval(raw) ? raw : "off";
}

function fileMtimeISO(file: string): string | null {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

function regularFileSize(file: string): number {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function hasRows(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytes <= 0) return false;
    const text = buf.subarray(0, bytes).toString("utf8").trim();
    if (!text) return false;
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length > 1) return true;
    return fs.fstatSync(fd).size > bytes;
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function firstDataDate(file: string): string | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(8192);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const lines = buf.subarray(0, bytes).toString("utf8").split(/\r?\n/).filter((line) => line.trim());
      return lines[1]?.split(",")[0]?.trim() || null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function csvMetricCount(file: string): number {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(2048);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const header = buf.subarray(0, bytes).toString("utf8").split(/\r?\n/)[0] ?? "";
      return Math.max(0, header.split(",").length - 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
}

function displayName(id: string): string {
  const words: Record<string, string> = {
    api: "API",
    browser: "Browser",
    calendar: "Calendar",
    chrome: "Chrome",
    fit: "Fit",
    google: "Google",
    history: "History",
    journal: "Journal",
    maps: "Maps",
    myactivity: "My Activity",
    notion: "Notion",
    places: "Places",
    semantic: "Semantic",
    settings: "Settings",
    takeout: "Takeout",
    text: "Text",
    texts: "Text",
    timeline: "Timeline",
  };
  return id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => words[part.toLowerCase()] ?? part.replace(/\b\w/g, (m) => m.toUpperCase()))
    .join(" ");
}

function coverageForFiles(files: string[]): { files: number; from: string | null; to: string | null; metrics: number } {
  const dates: string[] = [];
  let metrics = 0;
  for (const file of files) {
    metrics += csvMetricCount(file);
    const first = firstDataDate(file);
    if (first) dates.push(first);
  }
  const ordered = dates.sort();
  return { files: files.length, from: ordered[0] ?? null, to: ordered[ordered.length - 1] ?? null, metrics };
}

/** GitHub is connected once its record file holds commits; last-sync prefers the
 *  saved API timestamp, falling back to the file mtime. It is only DUE (auto-sync)
 *  when a token is actually available to run the sync. */
function githubRow(cfg: AppConfig | null, dir: string): SourceView {
  const file = path.join(dir, "daily", "github.csv");
  const days = fs.existsSync(file) ? parseGithubCsv(fs.readFileSync(file, "utf8")) : [];
  const hasData = days.length > 0;
  const lastSync = cfg?.githubSyncedAt ?? fileMtimeISO(file);
  const interval = intervalFor(cfg, "github");
  const hasToken = Boolean(resolveGithubToken());
  return {
    id: "github",
    name: "GitHub",
    kind: "api",
    detail: "commits per day",
    connected: hasToken,
    hasData,
    interval,
    lastSync,
    stale: false,
    due: hasToken && isDue(lastSync, interval),
    syncEndpoint: "/api/import/github",
    live: true,
    credentialOrigin: hasToken ? (process.env.GITHUB_TOKEN ? "env" : "saved") : null,
    ...lastRunFields("github"),
  };
}

/** WHOOP connects via the unofficial app login (email + password → token), so it
 *  has its own bespoke row + route like GitHub. Connected once its record file has
 *  rows; has a credential when the stored email + (password or refresh token) can
 *  re-auth; DUE (server-side auto-sync) only then. */
function whoopRow(cfg: AppConfig | null, dir: string): SourceView {
  const file = path.join(dir, "daily", "whoop.csv");
  const hasData = hasRows(file);
  const lastSync = cfg?.sourceSyncedAt?.whoop ?? fileMtimeISO(file);
  const interval = intervalFor(cfg, "whoop");
  const wc = cfg?.whoopCreds;
  const hasCred = Boolean(wc?.email && (wc?.password || wc?.refreshToken));
  return {
    id: "whoop",
    name: "WHOOP (per-minute, unofficial)",
    kind: "api",
    detail: "per-minute HR, HRV, recovery, sleep, strain",
    connected: hasCred,
    hasData,
    interval,
    lastSync,
    stale: false,
    due: hasCred && isDue(lastSync, interval),
    syncEndpoint: "/api/import/whoop",
    live: true,
    credentialOrigin: hasCred ? "saved" : null,
    ...lastRunFields("whoop"),
  };
}

/** Generic row for a Tier-1 plugin source (or one extra ACCOUNT of it — an
 *  instance id like "spotify-2" with its own credential, CSV and schedule).
 *  Connected once its record file has rows; DUE (auto-sync on open) only when
 *  live + a credential is resolvable. */
function pluginRow(
  cfg: AppConfig | null,
  dir: string,
  plugin: (typeof PLUGINS)[number],
  instanceId: string = plugin.id,
): SourceView {
  const file = path.join(dir, "daily", `${instanceId}.csv`);
  const lastSync = cfg?.sourceSyncedAt?.[instanceId] ?? fileMtimeISO(file);
  const interval = intervalFor(cfg, instanceId);
  // connected = the user AUTHORIZED syncing (saved/env credential, or an
  // opted-in detected app token). Data presence is a separate fact (hasData):
  // an import landing rows must never present the source as connected.
  const state = connectionState(plugin, cfg, instanceId, file);
  const suffix = instanceId !== plugin.id ? instanceId.slice(plugin.id.length + 1) : "";
  return {
    id: instanceId,
    name: suffix ? `${plugin.name} · account ${suffix}` : plugin.name,
    kind: "api",
    detail: plugin.detail,
    connected: state.connected,
    interval,
    lastSync,
    stale: false,
    due: plugin.live && state.connected && isDue(lastSync, interval),
    syncEndpoint: plugin.live ? `/api/import/${instanceId}` : null,
    live: plugin.live,
    plugin: true,
    credentialOrigin: state.credentialOrigin === "explicit" ? "saved" : state.credentialOrigin,
    hasData: state.hasData,
    detectedApp: state.detectedApp,
    ...lastRunFields(instanceId),
  };
}

/** Extra-account instance ids already set up for a plugin ("spotify-2", …) —
 *  anything holding a credential, a schedule, a sync stamp, or a daily file. */
function pluginInstanceIds(cfg: AppConfig | null, dir: string, plugin: (typeof PLUGINS)[number]): string[] {
  const re = new RegExp(`^${plugin.id}-(\\d+)$`);
  const ids = new Set<string>();
  for (const map of [cfg?.sourceCreds, cfg?.sourceIntervals, cfg?.sourceSyncedAt]) {
    for (const key of Object.keys(map ?? {})) if (re.test(key)) ids.add(key);
  }
  try {
    for (const f of fs.readdirSync(path.join(dir, "daily"))) {
      const stem = f.endsWith(".csv") ? f.slice(0, -4) : "";
      if (stem && re.test(stem)) ids.add(stem);
    }
  } catch {
    /* no daily dir yet */
  }
  // An automation recipe could own a colliding slug — automations win that id.
  const automationIds = new Set(listAutomations(cfg).map((a) => a.id));
  return [...ids].filter((id) => !automationIds.has(id)).sort();
}

/** Row for a Tier-2 file importer (Chrome history, iPhone backup). These read a
 *  local file on the user's own machine, so the server can never auto-sync them —
 *  they're `manual` (run `agentqs import:file` / the local daemon; a cloud replica
 *  gets the rows via git). Connected once the record file has rows; overdue → stale. */
function fileSourceRow(cfg: AppConfig | null, dir: string, importer: (typeof FILE_IMPORTERS)[number]): SourceView {
  const file = path.join(dir, "daily", `${importer.id}.csv`);
  const connected = hasRows(file);
  const lastSync = cfg?.sourceSyncedAt?.[importer.id] ?? fileMtimeISO(file);
  const interval = intervalFor(cfg, importer.id);
  return {
    id: importer.id,
    name: importer.name,
    kind: "manual",
    detail: importer.detail,
    connected,
    interval,
    lastSync,
    stale: connected ? isStale(lastSync, interval) : false,
    due: false, // local file — the server can't reach the user's disk
    syncEndpoint: null,
    live: importer.live,
  };
}

function recordSourceRows(cfg: AppConfig | null, dir: string, owned: Set<string>): SourceView[] {
  const dailyDir = path.join(dir, "daily");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dailyDir).filter((f) => f.toLowerCase().endsWith(".csv")).sort();
  } catch {
    return [];
  }
  const out: SourceView[] = [];
  for (const f of files) {
    const id = f.slice(0, -4);
    if (!id || owned.has(id)) continue;
    // Same skip rule as readDaily — a CSV the record readers ignore must not
    // surface as a phantom "connected" source.
    if (shouldSkipDailyCsvRead(dailyDir, f)) continue;
    const file = path.join(dailyDir, f);
    if (regularFileSize(file) <= 0) continue;
    const lastSync = cfg?.sourceSyncedAt?.[id] ?? fileMtimeISO(file);
    const interval = intervalFor(cfg, id);
    out.push({
      id,
      name: displayName(id),
      kind: "manual",
      detail: "record import",
      connected: true,
      // A header-only CSV (an import that landed zero rows) must not present
      // as data — the Pipeline row's Journal link keys off this.
      hasData: hasRows(file),
      interval,
      lastSync,
      stale: isStale(lastSync, interval),
      due: false,
      syncEndpoint: null,
      live: true,
    });
  }
  return out;
}

function bundleRow(cfg: AppConfig | null, dir: string, bundle: SourceBundle): SourceView | null {
  const sourceIds = bundle.sourceIds(dir).filter((id) => hasRows(path.join(dir, "daily", `${id}.csv`)));
  if (!sourceIds.length) return null;
  const files = sourceIds.map((id) => path.join(dir, "daily", `${id}.csv`));
  const c = coverageForFiles(files);
  const lastSync =
    cfg?.sourceSyncedAt?.[bundle.id] ??
    files
      .map(fileMtimeISO)
      .filter((v): v is string => Boolean(v))
      .sort()
      .at(-1) ??
    null;
  const interval = intervalFor(cfg, bundle.id);
  const span = c.from ? `from ${c.from}` : "imported";
  return {
    id: bundle.id,
    name: bundle.name,
    kind: "manual",
    detail: `${bundle.detail} · ${sourceIds.length} files · ${c.metrics} metrics · ${span}`,
    connected: true,
    interval,
    lastSync,
    stale: isStale(lastSync, interval),
    due: false,
    syncEndpoint: null,
    live: true,
    bundle: true,
    hasData: true, // a bundle row only exists once member files hold rows
  };
}

/** Row for a browser-automation recipe (a source with no API). Always shown as a
 *  set-up import (connected) so it stays editable under Automated imports even if a
 *  replay fails; the server CAN auto-sync it (headless Playwright), so overdue → due
 *  and it replays on Pipeline-tab open via its run endpoint. */
function automationRow(cfg: AppConfig | null, dir: string, recipe: AutomationRecipe): SourceView {
  const file = path.join(dir, "daily", `${recipe.id}.csv`);
  const interval = intervalFor(cfg, recipe.id);
  const lastSync = cfg?.sourceSyncedAt?.[recipe.id] ?? recipe.lastRun ?? fileMtimeISO(file);
  let host = recipe.url;
  try {
    host = new URL(recipe.url).host;
  } catch {
    /* keep raw url */
  }
  const landed = hasRows(file);
  const detail =
    recipe.lastStatus === "error"
      ? `${host} · last run failed`
      : `${host} · ${landed ? "last run ok" : "no data yet"}`;
  return {
    id: recipe.id,
    name: recipe.name,
    kind: "api",
    detail,
    hasData: landed,
    connected: true, // a configured automation always lives under Automated imports
    interval,
    lastSync,
    stale: false,
    due: isDue(lastSync, interval), // headless replay can run server-side on open
    syncEndpoint: `/api/automations/run?id=${encodeURIComponent(recipe.id)}`,
    live: true,
    automation: true,
    automationStatus: recipe.lastStatus ?? null,
    automationError: recipe.lastError ?? null,
  };
}

/** Compose the sources list from registered integrations plus real record-backed
 *  imports already present in record/daily. A source is connected only when the
 *  record has rows for it; unknown CSVs are surfaced as removable record imports,
 *  not as fake automations. */
export function buildSources(cfg: AppConfig | null, dir: string = recordDir()): SourceView[] {
  runsSnapshot = readSyncRuns(); // one ledger read per pass, not per row
  jobsSnapshot = readSyncJobs();
  const out: SourceView[] = [githubRow(cfg, dir), whoopRow(cfg, dir)];
  // Every plugin id is CLAIMED (so no stray record CSV resurfaces as an unknown
  // import), but only the SOURCES get a row: a backup target (Google Drive)
  // borrows the plugin contract for its OAuth machinery and brings no data in.
  // The pipeline is data coming IN; backups live in Settings → Data.
  const owned = new Set<string>(["github", "whoop", ...PLUGINS.map((p) => p.id)]);
  for (const plugin of SOURCE_PLUGINS) {
    out.push(pluginRow(cfg, dir, plugin));
    for (const instanceId of pluginInstanceIds(cfg, dir, plugin)) {
      out.push(pluginRow(cfg, dir, plugin, instanceId));
      owned.add(instanceId);
    }
  }
  // Tier-2 file importers (Chrome, iPhone) are local-only and off the API roster —
  // surface one only once it actually holds data, so the Connections catalog stays
  // the API roster while imported file data is still manageable under Automated.
  for (const importer of FILE_IMPORTERS) {
    const row = fileSourceRow(cfg, dir, importer);
    owned.add(importer.id);
    if (row.connected) out.push(row);
  }

  for (const recipe of listAutomations(cfg)) {
    owned.add(recipe.id);
    out.push(automationRow(cfg, dir, recipe));
  }

  // Chrome-extension Google scrapes are owned by the Pipeline tab's Google card
  // (per-preset status + remove) — keep them out of the generic record rows.
  for (const id of GOOGLE_PRESET_DAILY_SOURCES) owned.add(id);

  for (const bundle of SOURCE_BUNDLES) {
    const sourceIds = bundle.sourceIds(dir);
    if (!sourceIds.length) continue;
    for (const id of sourceIds) owned.add(id);
    const row = bundleRow(cfg, dir, bundle);
    if (row) out.push(row);
  }

  out.push(...recordSourceRows(cfg, dir, owned));
  return out;
}

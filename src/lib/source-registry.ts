/**
 * Server-only source composition (uses fs). Builds the Data-tab sources list by
 * merging the known integrations with the manual sources discovered in the record,
 * then layering each source's saved interval + derived last-sync and computing
 * stale/due via the pure helpers in ./sources.
 *
 * Every row is actionable — there are no dead placeholders. GitHub keeps its
 * bespoke row/route; the Tier-1 API plugins are composed from the plugin registry
 * (paste-a-credential → sync); the Tier-2/3 file importers carry the exact
 * `agentqs import:file` command they run; the upload sources carry a per-source
 * upload into the inbox. Adding a source is one registry entry, not a branch here.
 */
import fs from "fs";
import path from "path";
import type { AppConfig } from "./config";
import { recordDir } from "./paths";
import { parseGithubCsv, resolveGithubToken } from "./importers/github";
import { PLUGINS } from "./importers/registry";
import { resolveCredential } from "./importers/plugin";
import { FILE_IMPORTERS } from "./importers/files/registry";
import { UPLOAD_SOURCES } from "./upload-sources";
import {
  isDue,
  isStale,
  isValidInterval,
  type Interval,
  type SourceView,
} from "./sources";

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

function hasRows(file: string): boolean {
  try {
    return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).length > 1;
  } catch {
    return false;
  }
}

function dailyStems(dir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dir, "daily"))
      .filter((f) => f.toLowerCase().endsWith(".csv"))
      .map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
}

/** GitHub is connected once its record file holds commits; last-sync prefers the
 *  saved API timestamp, falling back to the file mtime. It is only DUE (auto-sync)
 *  when a token is actually available to run the sync. */
function githubRow(cfg: AppConfig | null, dir: string): SourceView {
  const file = path.join(dir, "daily", "github.csv");
  const days = fs.existsSync(file) ? parseGithubCsv(fs.readFileSync(file, "utf8")) : [];
  const connected = days.length > 0;
  const lastSync = cfg?.githubSyncedAt ?? fileMtimeISO(file);
  const interval = intervalFor(cfg, "github");
  const hasToken = Boolean(resolveGithubToken());
  return {
    id: "github",
    name: "GitHub",
    kind: "api",
    detail: "commits per day",
    connected,
    interval,
    lastSync,
    stale: false,
    due: connected && hasToken && isDue(lastSync, interval),
    syncEndpoint: "/api/import/github",
    live: true,
    connectVia: "api",
  };
}

/** Generic row for a Tier-1 plugin source. Connected once its record file has
 *  rows; DUE (auto-sync on open) only when live + a credential is resolvable. */
function pluginRow(cfg: AppConfig | null, dir: string, plugin: (typeof PLUGINS)[number]): SourceView {
  const file = path.join(dir, "daily", `${plugin.id}.csv`);
  const connected = hasRows(file);
  const lastSync = cfg?.sourceSyncedAt?.[plugin.id] ?? fileMtimeISO(file);
  const interval = intervalFor(cfg, plugin.id);
  const hasCred = Boolean(resolveCredential(plugin, undefined, cfg));
  return {
    id: plugin.id,
    name: plugin.name,
    kind: "api",
    detail: plugin.detail,
    connected,
    interval,
    lastSync,
    stale: false,
    due: plugin.live && connected && hasCred && isDue(lastSync, interval),
    syncEndpoint: plugin.live ? `/api/import/${plugin.id}` : null,
    live: plugin.live,
    connectVia: "api",
  };
}

/** Row for a Tier-2/3 file importer (browser history, iPhone backup, chat.db,
 *  Apple Health, OwnTracks). These read a local file on the user's own machine, so
 *  the server can never auto-sync them — they're `manual` and carry the exact
 *  `agentqs import:file` command to run locally (a cloud replica gets the rows via
 *  git). Connected once the record file has rows; overdue → stale. */
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
    connectVia: "cli",
    importCmd: `agentqs import:file --source ${importer.id} --rebuild`,
    connectHint: importer.connectHint ?? null,
  };
}

/** Row for an upload source (WhatsApp/Notion/Takeout/Slack/Telegram export). No
 *  live local file to poll, so the connect affordance is a per-source upload that
 *  lands the export in the inbox; Structure turns it into daily rows. */
function uploadSourceRow(cfg: AppConfig | null, dir: string, src: (typeof UPLOAD_SOURCES)[number]): SourceView {
  const file = path.join(dir, "daily", `${src.id}.csv`);
  const connected = hasRows(file);
  const lastSync = fileMtimeISO(file);
  const interval = intervalFor(cfg, src.id);
  return {
    id: src.id,
    name: src.name,
    kind: "manual",
    detail: src.detail,
    connected,
    interval,
    lastSync,
    stale: connected ? isStale(lastSync, interval) : false,
    due: false,
    syncEndpoint: null,
    live: true,
    connectVia: "upload",
    uploadAccept: src.accept,
    connectHint: src.hint,
  };
}

/** Compose the full sources list: GitHub + Tier-1 API plugins + Tier-2/3 file
 *  importers + upload sources + discovered manual drops (daily/*.csv not owned). */
export function buildSources(cfg: AppConfig | null, dir: string = recordDir()): SourceView[] {
  const out: SourceView[] = [githubRow(cfg, dir)];
  for (const plugin of PLUGINS) out.push(pluginRow(cfg, dir, plugin));
  for (const importer of FILE_IMPORTERS) out.push(fileSourceRow(cfg, dir, importer));
  for (const src of UPLOAD_SOURCES) out.push(uploadSourceRow(cfg, dir, src));

  const owned = new Set<string>([
    "github",
    ...PLUGINS.map((p) => p.id),
    ...FILE_IMPORTERS.map((f) => f.id),
    ...UPLOAD_SOURCES.map((s) => s.id),
  ]);

  // Discovered manual sources — structured drops / pasted exports land as
  // daily/<stem>.csv. They can't auto-sync, so an overdue one is badged stale.
  for (const stem of dailyStems(dir)) {
    if (owned.has(stem)) continue;
    const lastSync = fileMtimeISO(path.join(dir, "daily", `${stem}.csv`));
    const interval = intervalFor(cfg, stem);
    out.push({
      id: stem,
      name: stem,
      kind: "manual",
      detail: "imported daily data",
      connected: true,
      interval,
      lastSync,
      stale: isStale(lastSync, interval),
      due: false,
      syncEndpoint: null,
      live: true,
      connectVia: "upload",
    });
  }

  return out;
}

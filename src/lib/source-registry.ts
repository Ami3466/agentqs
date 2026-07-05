/**
 * Server-only source composition (uses fs). Builds the Data-tab sources list by
 * merging a registry of known integrations with the manual sources discovered in
 * the record, then layering each source's saved interval + derived last-sync and
 * computing stale/due via the pure helpers in ./sources.
 *
 * GitHub keeps its bespoke row/route (Loop 3); the Tier-1 plugins (RescueTime,
 * Google Calendar, Spotify, WHOOP-stub) are composed generically from the plugin
 * registry so adding a source is one entry, not a new branch here.
 */
import fs from "fs";
import path from "path";
import type { AppConfig } from "./config";
import { recordDir } from "./paths";
import { parseGithubCsv, resolveGithubToken } from "./importers/github";
import { PLUGINS } from "./importers/registry";
import { resolveCredential } from "./importers/plugin";
import {
  isDue,
  isStale,
  isValidInterval,
  type Interval,
  type SourceKind,
  type SourceView,
} from "./sources";

interface Registered {
  id: string;
  name: string;
  kind: SourceKind;
  detail: string;
  csv?: string; // daily/<csv>.csv this source owns (so it isn't double-counted as manual)
  live: boolean; // has a working importer
}

/** Not-yet-live file-based integrations (later loops wire these up). GitHub and
 *  the Tier-1 plugins are composed separately below. */
const PLACEHOLDERS: Registered[] = [
  { id: "apple-health", name: "Apple Health", kind: "manual", detail: "steps, HR, sleep, workouts", live: false },
  { id: "chrome", name: "Chrome history", kind: "manual", detail: "browsing history", live: false },
];

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
  };
}

/** Compose the full sources list: GitHub + Tier-1 plugins + placeholder
 *  integrations + discovered manual sources (any daily/*.csv not owned above). */
export function buildSources(cfg: AppConfig | null, dir: string = recordDir()): SourceView[] {
  const out: SourceView[] = [githubRow(cfg, dir)];
  for (const plugin of PLUGINS) out.push(pluginRow(cfg, dir, plugin));

  const owned = new Set<string>(["github", ...PLUGINS.map((p) => p.id)]);

  for (const reg of PLACEHOLDERS) {
    out.push({
      id: reg.id,
      name: reg.name,
      kind: reg.kind,
      detail: reg.detail,
      connected: false,
      interval: intervalFor(cfg, reg.id),
      lastSync: null,
      stale: false,
      due: false,
      syncEndpoint: null,
      live: reg.live,
    });
  }

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
    });
  }

  return out;
}

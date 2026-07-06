/**
 * Server-only source composition (uses fs). Builds the Data-tab sources list by
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
import { PLUGINS } from "./importers/registry";
import { resolveCredential } from "./importers/plugin";
import { FILE_IMPORTERS } from "./importers/files/registry";
import { listAutomations } from "./automation";
import type { AutomationRecipe } from "./automation-types";
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
  /** Real wire-up path for a not-yet-live source (never a fake "connected" row):
   *  "file" → a local export imported via the CLI; "automation" → the record-login
   *  + scrape wizard. */
  setup: "automation" | "file";
  setupUrl?: string; // seeds the wizard's Start URL for automation sources
}

/**
 * Roster integrations that have no live single-credential in-app importer yet,
 * shown as real connectable sources — never faked as connected. Wiring one up runs
 * the record-login + scrape wizard, which moves it to Automated imports for real.
 * (The rest of the roster — Oura, Fitbit, Strava, Withings, Mastodon, … — are live
 * API plugins in ./importers/registry; GitHub + WHOOP are bespoke rows.)
 */
const PLACEHOLDERS: Registered[] = [
  { id: "health-connect", name: "Health Connect", kind: "manual", detail: "Android health + fitness aggregate", live: false, setup: "automation" },
  { id: "garmin", name: "Garmin", kind: "manual", detail: "activities, sleep, body battery", live: false, setup: "automation", setupUrl: "https://connect.garmin.com/signin" },
  { id: "instapaper", name: "Instapaper", kind: "manual", detail: "articles saved + read", live: false, setup: "automation", setupUrl: "https://www.instapaper.com/user/login" },
  { id: "apple-weather", name: "Apple Weather", kind: "manual", detail: "daily conditions + temperature", live: false, setup: "automation", setupUrl: "https://weather.apple.com" },
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

/** WHOOP connects via the unofficial app login (email + password → token), so it
 *  has its own bespoke row + route like GitHub. Connected once its record file has
 *  rows; has a credential when the stored email + (password or refresh token) can
 *  re-auth; DUE (server-side auto-sync) only then. */
function whoopRow(cfg: AppConfig | null, dir: string): SourceView {
  const file = path.join(dir, "daily", "whoop.csv");
  const connected = hasRows(file);
  const lastSync = cfg?.sourceSyncedAt?.whoop ?? fileMtimeISO(file);
  const interval = intervalFor(cfg, "whoop");
  const wc = cfg?.whoopCreds;
  const hasCred = Boolean(wc?.email && (wc?.password || wc?.refreshToken));
  return {
    id: "whoop",
    name: "WHOOP",
    kind: "api",
    detail: "per-minute HR, HRV, recovery, sleep, strain",
    connected,
    interval,
    lastSync,
    stale: false,
    due: connected && hasCred && isDue(lastSync, interval),
    syncEndpoint: "/api/import/whoop",
    live: true,
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
  const connected = hasRows(file);
  const lastSync = cfg?.sourceSyncedAt?.[instanceId] ?? fileMtimeISO(file);
  const interval = intervalFor(cfg, instanceId);
  const hasCred = Boolean(resolveCredential(plugin, undefined, cfg, instanceId));
  const suffix = instanceId !== plugin.id ? instanceId.slice(plugin.id.length + 1) : "";
  return {
    id: instanceId,
    name: suffix ? `${plugin.name} · account ${suffix}` : plugin.name,
    kind: "api",
    detail: plugin.detail,
    connected,
    interval,
    lastSync,
    stale: false,
    due: plugin.live && connected && hasCred && isDue(lastSync, interval),
    syncEndpoint: plugin.live ? `/api/import/${instanceId}` : null,
    live: plugin.live,
    plugin: true,
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

/** Row for a browser-automation recipe (a source with no API). Always shown as a
 *  set-up import (connected) so it stays editable under Automated imports even if a
 *  replay fails; the server CAN auto-sync it (headless Playwright), so overdue → due
 *  and it replays on Data-tab open via its run endpoint. */
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
  const detail =
    recipe.lastStatus === "error"
      ? `${host} · last run failed`
      : `${host} · ${hasRows(file) ? "importing" : "no data yet"}`;
  return {
    id: recipe.id,
    name: recipe.name,
    kind: "api",
    detail,
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

/** Compose the sources list = real, repeatable integrations only: GitHub +
 *  Tier-1 API plugins + Tier-2 file importers + not-yet-live placeholders. A
 *  one-off dropped CSV is NOT a source — it lands in the inbox and, once
 *  structured, shows up in the daily table, never as a fake "connected" feed. */
export function buildSources(cfg: AppConfig | null, dir: string = recordDir()): SourceView[] {
  const out: SourceView[] = [githubRow(cfg, dir), whoopRow(cfg, dir)];
  for (const plugin of PLUGINS) {
    out.push(pluginRow(cfg, dir, plugin));
    for (const instanceId of pluginInstanceIds(cfg, dir, plugin)) {
      out.push(pluginRow(cfg, dir, plugin, instanceId));
    }
  }
  // Tier-2 file importers (Chrome, iPhone) are local-only and off the API roster —
  // surface one only once it actually holds data, so the Connections catalog stays
  // the API roster while imported file data is still manageable under Automated.
  for (const importer of FILE_IMPORTERS) {
    const row = fileSourceRow(cfg, dir, importer);
    if (row.connected) out.push(row);
  }

  for (const recipe of listAutomations(cfg)) out.push(automationRow(cfg, dir, recipe));

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
      setup: reg.setup,
      setupUrl: reg.setupUrl,
    });
  }

  return out;
}

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
import { coverageBySource } from "./daily";
import { parseGithubCsv, resolveGithubToken } from "./importers/github";
import { whoopCredsFor } from "./importers/whoop";
import { googlePluginOn } from "./google";
import { PLUGINS, SOURCE_PLUGINS } from "./importers/registry";
import { connectionState } from "./importers/plugin";
import { readSyncRuns } from "./sync-runs";
import { readSyncJobs, type SyncJob } from "./sync-jobs";
import { FILE_IMPORTERS } from "./importers/files/registry";
import { listAutomations } from "./automation";
import type { AutomationRecipe } from "./automation-types";
import { GOOGLE_PRESET_DAILY_SOURCES } from "./google-web-scraper";
import { readInboxFromRecord, shouldSkipDailyCsvRead } from "./record";
import { CHANNELS, channelEnv } from "./channels/registry";
import { deliveryVerdict, readChannelDeliveries } from "./channel-deliveries";
import { pullChannelName, pullable } from "./channels/pull";
import { readBackfillState } from "./sync-runs";
import { SOURCE_BUNDLES, type SourceBundle } from "./source-bundles";
import {
  isDue,
  isStale,
  isValidInterval,
  type Interval,
  type SourceCoverage,
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
 *  has its own bespoke row + route like GitHub. `plugin: true` on the base row lets
 *  the panel link a SECOND athlete's account ("whoop-2") — its own login, daily
 *  file and schedule. Connected once its stored login can re-auth; DUE (server-side
 *  auto-sync) only then. */
function whoopRow(cfg: AppConfig | null, dir: string, instanceId: string = "whoop"): SourceView {
  const file = path.join(dir, "daily", `${instanceId}.csv`);
  const hasData = hasRows(file);
  const lastSync = cfg?.sourceSyncedAt?.[instanceId] ?? fileMtimeISO(file);
  const interval = intervalFor(cfg, instanceId);
  const wc = whoopCredsFor(cfg, instanceId);
  const hasCred = Boolean(wc?.email && (wc?.password || wc?.refreshToken));
  const m = instanceId.match(/^whoop-(\d+)$/);
  return {
    id: instanceId,
    name: m ? `WHOOP · account ${m[1]} (per-minute, unofficial)` : "WHOOP (per-minute, unofficial)",
    kind: "api",
    detail: "per-minute HR, HRV, recovery, sleep, strain",
    connected: hasCred,
    hasData,
    interval,
    lastSync,
    stale: false,
    due: hasCred && isDue(lastSync, interval),
    // The base route reads ?instance to know which account it's syncing; the base
    // stays the plain path so nothing else has to change.
    syncEndpoint: instanceId === "whoop" ? "/api/import/whoop" : `/api/import/whoop?instance=${instanceId}`,
    live: true,
    plugin: instanceId === "whoop", // only the base offers "add another account"
    credentialOrigin: hasCred ? "saved" : null,
    // WHICH athlete this row is — two WHOOP accounts are otherwise identical rows.
    account: hasCred ? (wc?.email ?? null) : null,
    ...lastRunFields(instanceId),
  };
}

/** Live-capture channel rows (Slack, Telegram). A channel is PUSHED to our
 *  webhook: connected by a bot token, never scheduled, never synced, never due.
 *  Its "data" is the memos you sent the bot (inbox items tagged with its id), so
 *  the row says how many it has captured — and NEVER reads like a puller that
 *  could fetch your platform history (it cannot). */
function channelRows(cfg: AppConfig | null, dir: string): SourceView[] {
  const env = channelEnv();
  let inbox: ReturnType<typeof readInboxFromRecord> = [];
  try {
    inbox = readInboxFromRecord(dir);
  } catch {
    /* no record yet */
  }
  return CHANNELS.map((adapter) => {
    const connected = adapter.configured(env);
    const captures = inbox.filter((i) => i.source === adapter.id);
    const n = captures.length;
    const last = n ? captures.reduce((a, b) => (a.ts > b.ts ? a : b)) : null;
    const tail = "messages you send the bot land in your inbox";
    // Inbound webhook health: whether the PLATFORM is still calling us, and what we
    // did with the call. Without it, "connected" (a token is stored) was the only
    // signal a channel had — and it stays true while every delivery is refused.
    const d = readChannelDeliveries(adapter.id);
    const delivery = {
      lastAt: d.last?.at ?? null,
      lastOutcome: d.last?.outcome ?? null,
      lastDetail: d.last?.detail ?? null,
      rejectedAt: d.lastRejected?.at ?? null,
      rejectedDetail: d.lastRejected?.detail ?? null,
      verdict: deliveryVerdict(d, { configured: connected, label: adapter.label }),
    };
    // A channel with a conversation configured is ALSO polled on our own schedule.
    // Push is instant but silently dies when the platform disables the subscription;
    // the poll is what still collects those messages, and it runs in this process on
    // this host — never a cron somewhere else that can quietly stop being paid for.
    const polls = pullable(adapter.id, env);
    const from = pullChannelName(adapter.id, env);
    // Naming a conversation to poll IS the request to poll it, so the cadence
    // defaults to hourly rather than to "off". A setting that silently does nothing
    // until you also find a dropdown is the same class of bug as the cron that
    // reported success while capturing nothing — the user's intent was explicit.
    const stored = intervalFor(cfg, adapter.id);
    const interval: Interval = polls ? (stored === "off" ? "hourly" : stored) : "off";
    const lastPull = readBackfillState(`channel-pull:${adapter.id}`).at ?? null;
    const detail = n
      ? `${n} message${n === 1 ? "" : "s"} captured${polls ? ` · polling #${from}` : ""} · ${tail}`
      : `${connected ? "nothing captured yet" : "not connected"}${polls ? ` · polling #${from}` : ""} · ${tail}`;
    return {
      id: adapter.id,
      name: adapter.label,
      kind: "api",
      channel: true,
      detail,
      connected,
      hasData: n > 0,
      interval,
      lastSync: last?.ts ?? null,
      stale: false,
      due: polls && isDue(lastPull, interval),
      syncEndpoint: polls ? `/api/import/${adapter.id}` : null,
      live: polls,
      credentialOrigin: connected ? "env" : null,
      delivery,
      ...lastRunFields(adapter.id),
    };
  });
}

/** Extra WHOOP accounts already set up ("whoop-2", …) — anything holding a login,
 *  a schedule, a sync stamp, or a daily file. Mirrors pluginInstanceIds. */
function whoopInstanceIds(cfg: AppConfig | null, dir: string): string[] {
  const re = /^whoop-\d+$/;
  const ids = new Set<string>();
  for (const key of Object.keys(cfg?.whoopCredsByInstance ?? {})) if (re.test(key)) ids.add(key);
  for (const map of [cfg?.sourceIntervals, cfg?.sourceSyncedAt]) {
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
  return [...ids].sort();
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
    // A Google plugin shares one key with its siblings, so "connected" can't gate
    // its schedule — an UNTICKED Gmail still holds the key. googlePluginOn is the
    // checkbox: unticked → never due, even with a saved cadence. Non-Google plugins
    // are never gated (googlePluginOn returns true for them).
    due: plugin.live && state.connected && googlePluginOn(cfg, plugin.id) && isDue(lastSync, interval),
    syncEndpoint: plugin.live ? `/api/import/${instanceId}` : null,
    live: plugin.live,
    plugin: true,
    // Plugins that share one OAuth key (Google: Calendar + Gmail) carry the
    // provider tag so the Pipeline folds them into a single card.
    provider: plugin.oauth?.providerKey,
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
  const hasData = hasRows(file);
  const lastSync = cfg?.sourceSyncedAt?.[importer.id] ?? fileMtimeISO(file);
  const interval = intervalFor(cfg, importer.id);
  return {
    id: importer.id,
    name: importer.name,
    kind: "manual",
    detail: importer.detail,
    // Reading a file off YOUR disk is not a connection: no key, no account, and
    // the web server can't reach it (it re-runs from the CLI/MCP/daemon). It used
    // to report connected the moment rows existed — a local import wearing an
    // integration's badge.
    connected: false,
    provenance: "local-file",
    hasData,
    interval,
    lastSync,
    stale: hasData ? isStale(lastSync, interval) : false,
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
      // A dropped CSV is IMPORTED, never connected: there is no credential, no
      // account and nothing to sync. This row used to hardcode connected: true —
      // the record's own files then read back as live integrations, which is the
      // exact lie the connection rule exists to prevent.
      connected: false,
      provenance: "imported",
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
    // An archive you unpacked (a Takeout bundle) is imported history, not a
    // connection — there is no key behind it and nothing will ever sync it.
    connected: false,
    provenance: "imported",
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
 *  not as fake automations.
 *
 *  Every row carries its `coverage` (what actually landed) so the UI can show
 *  "what synced and what didn't" without a second round-trip. Callers that already
 *  hold the map (the pipeline report) pass it in rather than re-querying. */
export function buildSources(
  cfg: AppConfig | null,
  dir: string = recordDir(),
  coverage: Map<string, SourceCoverage> = coverageBySource(),
): SourceView[] {
  runsSnapshot = readSyncRuns(); // one ledger read per pass, not per row
  jobsSnapshot = readSyncJobs();
  const out: SourceView[] = [githubRow(cfg, dir), whoopRow(cfg, dir)];
  // Extra WHOOP athletes ("whoop-2", …) — each its own login, file and schedule.
  const whoopExtras = whoopInstanceIds(cfg, dir);
  for (const instanceId of whoopExtras) out.push(whoopRow(cfg, dir, instanceId));
  // Every plugin id is CLAIMED (so no stray record CSV resurfaces as an unknown
  // import), but only the SOURCES get a row: a backup target (Google Drive)
  // borrows the plugin contract for its OAuth machinery and brings no data in.
  // The pipeline is data coming IN; backups live in Settings → Data.
  const owned = new Set<string>(["github", "whoop", ...whoopExtras, ...PLUGINS.map((p) => p.id)]);
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
  //
  // A file importer may BACKFILL a live source rather than be one (the Spotify export
  // fills the same `spotify` the API sync keeps fresh — the export is the history, the
  // API is the last few days). It has already been given a row by the plugin loop, and
  // that row's coverage is read from the daily file both of them write, so it shows the
  // whole lifetime. A second row here would split one Spotify in half and re-ask for a
  // credential the source already has.
  for (const importer of FILE_IMPORTERS) {
    const row = fileSourceRow(cfg, dir, importer);
    const backfillsAPlugin = PLUGINS.some((p) => p.id === importer.id);
    owned.add(importer.id);
    if (row.hasData && !backfillsAPlugin) out.push(row); // surfaces once it holds rows (never "connected")
  }

  for (const recipe of listAutomations(cfg)) {
    owned.add(recipe.id);
    out.push(automationRow(cfg, dir, recipe));
  }

  // Live-capture channels (Slack, Telegram): PUSHED to our webhook, not polled —
  // connected by a bot token, filled by memos you send the bot. They belong on the
  // tab that shows data coming in, but never as a broken puller.
  for (const row of channelRows(cfg, dir)) {
    owned.add(row.id);
    out.push(row);
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
  // Coverage + provenance last, in one place: every row answers "what landed?" and
  // "how did it get here?" the same way, whoever built it. A row with no coverage
  // entry landed nothing (it stays zeroed). Provenance is only DERIVED for rows
  // that didn't declare one — an imported CSV / local file says so itself, and a
  // row is "credential" only when a key is actually stored, so nothing can quietly
  // wear the Connected badge on the strength of having data.
  for (const row of out) {
    row.coverage = coverage.get(row.id) ?? { events: 0, days: 0, from: null, to: null };
    if (!row.provenance) {
      row.provenance = row.automation ? "automation" : row.connected ? "credential" : undefined;
    }
  }
  return out;
}

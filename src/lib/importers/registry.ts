import type { ImporterPlugin } from "./plugin";
import { rescuetimePlugin } from "./rescuetime";
import { gcalPlugin } from "./gcal";
import { spotifyPlugin } from "./spotify";
import { ouraPlugin } from "./oura";
import { fitbitPlugin } from "./fitbit";
import { stravaPlugin } from "./strava";
import { lastfmPlugin } from "./lastfm";
import { togglPlugin } from "./toggl";
import { todoistPlugin } from "./todoist";
import { traktPlugin } from "./trakt";
import { notionPlugin } from "./notion";
import { deezerPlugin } from "./deezer";
import { swarmPlugin } from "./swarm";
import { mastodonPlugin } from "./mastodon";
import { withingsPlugin } from "./withings";

/**
 * The single-credential API importer plugins — API-first: every source that ships
 * an API is pulled through it (never manual export). GitHub and WHOOP keep their
 * own bespoke modules + routes — GitHub for its commit-specific sparkline, WHOOP
 * because it uses the reverse-engineered app login (email + password → token) and
 * a per-minute stream, neither of which fit the single-credential daily-table
 * plugin contract these share behind /api/import/[source]. Adding an API source is
 * one entry here — it then appears in the Data tab, gets a connect/sync route, and
 * is syncable from the CLI + MCP automatically.
 */
export const PLUGINS: ImporterPlugin[] = [
  rescuetimePlugin,
  gcalPlugin,
  spotifyPlugin,
  ouraPlugin,
  fitbitPlugin,
  stravaPlugin,
  lastfmPlugin,
  togglPlugin,
  todoistPlugin,
  traktPlugin,
  notionPlugin,
  deezerPlugin,
  swarmPlugin,
  mastodonPlugin,
  withingsPlugin,
];

export function pluginById(id: string): ImporterPlugin | undefined {
  return PLUGINS.find((p) => p.id === id);
}

/** Resolved multi-account source id: the plugin + the instance id that keys its
 *  credential, CSV and schedule ("spotify" account 2 → instanceId "spotify-2"). */
export interface PluginInstance {
  plugin: ImporterPlugin;
  instanceId: string;
}

/** Resolve a source id, accepting "<plugin>-<n>" instance ids so one integration
 *  can be connected under several accounts. The base id is account 1. */
export function pluginInstanceById(id: string): PluginInstance | undefined {
  const direct = pluginById(id);
  if (direct) return { plugin: direct, instanceId: direct.id };
  const m = id.match(/^(.+)-(\d+)$/);
  const base = m ? pluginById(m[1]) : undefined;
  return base ? { plugin: base, instanceId: id } : undefined;
}

/** Display name for an instance — "Spotify" for account 1, "Spotify · account 2" after. */
export function pluginInstanceName(inst: PluginInstance): string {
  const m = inst.instanceId.match(/-(\d+)$/);
  return m && inst.instanceId !== inst.plugin.id
    ? `${inst.plugin.name} · account ${m[1]}`
    : inst.plugin.name;
}

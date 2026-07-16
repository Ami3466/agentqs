import type { ImporterPlugin } from "./plugin";
import { rescuetimePlugin } from "./rescuetime";
import { gcalPlugin } from "./gcal";
import { gmailPlugin } from "./gmail";
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
import { granolaPlugin } from "./granola";
import { whoopApiPlugin } from "./whoop-api";
import { wakatimePlugin } from "./wakatime";
import { ynabPlugin } from "./ynab";
import { readwisePlugin } from "./readwise";
import { gdriveBackupPlugin } from "./gdrive-backup";
import { driveImportPlugin } from "./drive-import";

/**
 * The single-credential API importer plugins — API-first: every source that ships
 * an API is pulled through it (never manual export). GitHub and the per-minute
 * WHOOP keep their own bespoke modules + routes — GitHub for its commit-specific
 * sparkline, WHOOP because it uses the reverse-engineered app login (email +
 * password → token) and a per-minute stream, neither of which fit the
 * single-credential daily-table plugin contract these share behind
 * /api/import/[source]. The OFFICIAL WHOOP API (daily summaries, bearer token)
 * fits the contract and lives here as `whoop-api`. Adding an API source is
 * one entry here — it then appears in the Pipeline tab, gets a connect/sync route, and
 * is syncable from the CLI + MCP automatically.
 */
export const PLUGINS: ImporterPlugin[] = [
  whoopApiPlugin,
  rescuetimePlugin,
  // Google, behind ONE key: Calendar and Gmail share the `google` OAuth grant and
  // are ticked as products on the Pipeline's Google card, not connected separately.
  gcalPlugin,
  gmailPlugin,
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
  granolaPlugin,
  wakatimePlugin,
  ynabPlugin,
  readwisePlugin,
  // NOT an importer and NOT a source: the encrypted-Drive BACKUP target. It sits
  // in this registry for one reason — a registry entry is what buys the OAuth
  // dance, the token refresh and `source authorize`. It brings no data in, so it
  // stays out of the pipeline: iterate SOURCE_PLUGINS whenever you mean "the
  // sources we pull data from".
  gdriveBackupPlugin,
  // Also NOT a source: the read-on-request Drive IMPORT integration. Registry entry
  // buys it the OAuth dance / token refresh; `credentialOnly` keeps it out of the
  // pipeline. Its data is pulled explicitly (`agentqs drive pull`), never synced.
  driveImportPlugin,
];

/** The DATA SOURCES — every plugin except the backup targets and read-only tools.
 *  The pipeline is data coming IN on a schedule; a backup is data going OUT, and a
 *  credential-only tool (Drive import) is read on request. Anything listing, syncing
 *  or scheduling sources iterates THIS, never PLUGINS (which also carries those). */
export const SOURCE_PLUGINS: ImporterPlugin[] = PLUGINS.filter((p) => !p.backupTarget && !p.credentialOnly);

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

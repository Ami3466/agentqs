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
];

export function pluginById(id: string): ImporterPlugin | undefined {
  return PLUGINS.find((p) => p.id === id);
}

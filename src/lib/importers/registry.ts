import type { ImporterPlugin } from "./plugin";
import { rescuetimePlugin } from "./rescuetime";
import { gcalPlugin } from "./gcal";
import { spotifyPlugin } from "./spotify";

/**
 * The Tier-1 importer plugins (Loop 11). GitHub and WHOOP keep their own bespoke
 * modules + routes — GitHub for its commit-specific sparkline, WHOOP because it
 * uses the reverse-engineered app login (email + password → token) and a
 * per-minute stream, neither of which fit the single-credential daily-table
 * plugin contract these three share behind /api/import/[source].
 */
export const PLUGINS: ImporterPlugin[] = [rescuetimePlugin, gcalPlugin, spotifyPlugin];

export function pluginById(id: string): ImporterPlugin | undefined {
  return PLUGINS.find((p) => p.id === id);
}

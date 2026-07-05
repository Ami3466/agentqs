import type { ImporterPlugin } from "./plugin";
import { rescuetimePlugin } from "./rescuetime";
import { gcalPlugin } from "./gcal";
import { spotifyPlugin } from "./spotify";
import { whoopPlugin } from "./whoop";

/**
 * The Tier-1 importer plugins (Loop 11). GitHub keeps its own bespoke module +
 * route (it predates this interface and has a commit-specific sparkline); these
 * four share the generic ImporterPlugin contract and the /api/import/[source]
 * route. WHOOP is a stub adapter (`live: false`) until its OAuth flow lands.
 */
export const PLUGINS: ImporterPlugin[] = [rescuetimePlugin, gcalPlugin, spotifyPlugin, whoopPlugin];

export function pluginById(id: string): ImporterPlugin | undefined {
  return PLUGINS.find((p) => p.id === id);
}

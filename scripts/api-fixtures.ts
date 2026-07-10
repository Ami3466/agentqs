/**
 * The one fixture table for the single-credential API plugins. Every script that
 * drives PLUGINS offline (api-sources, integration-batch) imports from here, so
 * adding a source is ONE entry — a map that only lives in one script rots as
 * plugins are added (integration-batch crashed exactly that way).
 */

export const FIXTURES: Record<string, string> = {
  "whoop-api": "samples/whoop-api.json",
  rescuetime: "samples/rescuetime-daily.json",
  gcal: "samples/gcal-events.json",
  spotify: "samples/spotify-recent.json",
  oura: "samples/oura-readiness.json",
  fitbit: "samples/fitbit-steps.json",
  strava: "samples/strava-activities.json",
  lastfm: "samples/lastfm-recent.json",
  toggl: "samples/toggl-entries.json",
  todoist: "samples/todoist-completed.json",
  trakt: "samples/trakt-history.json",
  notion: "samples/notion-search.json",
  deezer: "samples/deezer-history.json",
  swarm: "samples/swarm-checkins.json",
  mastodon: "samples/mastodon-statuses.json",
  withings: "samples/withings-measures.json",
  granola: "samples/granola-documents.json",
};

// Split-credential sources take "<a>:<b>" in the single credential slot.
export const CRED: Record<string, string> = {
  lastfm: "APIKEY:testuser",
  trakt: "CLIENTID:ACCESSTOKEN",
  mastodon: "mastodon.example:ACCESSTOKEN",
  granola: "test-refresh-token",
};

/** Multi-request sources need a fixture keyed by endpoint — and, for the
 *  per-document ones, by the `document_id` the plugin posts. */
type Fixture = Record<string, unknown>;
type Router = (href: string, body: Fixture, req: Fixture) => unknown;

const MULTI: Record<string, Router> = {
  "whoop-api": (href, body) =>
    href.includes("/activity/sleep")
      ? body.sleep
      : href.includes("/recovery")
        ? body.recovery
        : href.includes("/cycle")
          ? body.cycle
          : {},
  // Two endpoints: anapi/data (per-day productivity seconds, includes today) and
  // the daily_summary_feed (pulse for completed days only).
  rescuetime: (href, body) => (href.includes("/anapi/data") ? body.interval : body.summary),
  mastodon: (href, body) => (href.includes("/verify_credentials") ? { id: "42" } : body),
  granola: (href, body, req) => {
    const byDoc = (key: string) =>
      (body[key] as Record<string, unknown>)[String(req.document_id)] ?? [];
    if (href.includes("refresh-access-token")) return body.refresh;
    if (href.includes("get-documents")) return body.documents;
    if (href.includes("get-document-panels")) return byDoc("panels");
    if (href.includes("get-document-transcript")) return byDoc("transcript");
    return {};
  },
};

export function fetchForFixture(pluginId: string, body: unknown): typeof fetch {
  const route = MULTI[pluginId];
  const respond = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (!route) return respond(body);
    const req = init?.body ? (JSON.parse(String(init.body)) as Fixture) : {};
    return respond(route(String(url), body as Fixture, req));
  }) as typeof fetch;
}

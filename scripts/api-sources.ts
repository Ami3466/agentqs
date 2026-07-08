#!/usr/bin/env tsx
/**
 * API-first proof (Task 8) — every source that ships an API is pulled through it,
 * never a manual export. Drives each single-credential API plugin end to end:
 *
 *   fixture body → plugin.fetch (real request shape, offline) → normalize →
 *   mergeDailyCsv → record/daily/<id>.csv → assert the primary-metric column has
 *   real numbers for the window.
 *
 * Covers the sources added in this task (Oura, Fitbit, Strava, Last.fm, Toggl,
 * Todoist, Trakt, Notion) plus the earlier three (RescueTime, Calendar, Spotify),
 * so the whole PLUGINS registry is exercised through the live import path.
 * Deterministic, no network. Run: npm run api:test
 */
import fs from "fs";
import os from "os";
import path from "path";
import { importPlugin, fixtureFetch } from "../src/lib/importers/plugin";
import { PLUGINS } from "../src/lib/importers/registry";
import { parseCsv } from "../src/lib/record";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const FIXTURES: Record<string, string> = {
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
const CRED: Record<string, string> = {
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

function fetchForFixture(pluginId: string, body: unknown) {
  const route = MULTI[pluginId];
  if (!route) return fixtureFetch(body);
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const req = init?.body ? (JSON.parse(String(init.body)) as Fixture) : {};
    const payload = route(String(url), body as Fixture, req);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-api-"));
  const recordDir = path.join(root, "record");
  const from = "2026-06-01";
  const to = "2026-06-30";

  console.log(`\nAPI-first — driving ${PLUGINS.length} API plugins through the real import path\n`);

  for (const plugin of PLUGINS) {
    const fx = FIXTURES[plugin.id];
    check(`${plugin.name}: has a fixture`, Boolean(fx));
    if (!fx) continue;
    const body = JSON.parse(fs.readFileSync(path.resolve(fx), "utf8"));
    const summary = await importPlugin(
      plugin,
      { from, to, credential: CRED[plugin.id], fetchImpl: fetchForFixture(plugin.id, body) },
      recordDir,
    );

    const file = path.join(recordDir, "daily", `${plugin.id}.csv`);
    const exists = fs.existsSync(file);
    check(`${plugin.name}: wrote record/daily/${plugin.id}.csv`, exists);
    if (!exists) continue;

    const { header, rows } = parseCsv(fs.readFileSync(file, "utf8"));
    check(`${plugin.name}: header has date + ${plugin.primaryMetric}`,
      header[0] === "date" && header.includes(plugin.primaryMetric),
      header.join(","));

    const mi = header.indexOf(plugin.primaryMetric);
    const withMetric = rows.filter((r) => (r[mi] ?? "").trim() !== "" && Number.isFinite(Number(r[mi])));
    check(`${plugin.name}: ${plugin.primaryMetric} has real numbers`,
      summary.rows > 0 && withMetric.length > 0,
      `${withMetric.length} days, latest ${plugin.primaryMetric}=${withMetric.at(-1)?.[mi]}`);

    // A rich source (Granola) also lands prose the search index can reach and one
    // event per item on the journal timeline. Both go through importPlugin, so the
    // same fixture run proves them.
    for (const extra of summary.extraSources) {
      const extraFile = path.join(recordDir, "daily", `${extra}.csv`);
      const ok = fs.existsSync(extraFile);
      check(`${plugin.name}: wrote record/daily/${extra}.csv`, ok);
      if (!ok) continue;
      const t = parseCsv(fs.readFileSync(extraFile, "utf8"));
      const ti = t.header.indexOf("text");
      const prose = t.rows.filter((r) => (r[ti] ?? "").trim().length >= 20);
      check(`${plugin.name}: ${extra} carries searchable prose`, ti >= 0 && prose.length > 0,
        `${prose.length} day(s), ${prose[0]?.[ti]?.length ?? 0} chars`);
    }

    if (summary.eventsAdded > 0) {
      const lines = fs.readFileSync(path.join(recordDir, "events.jsonl"), "utf8").trim().split("\n");
      const mine = lines.map((l) => JSON.parse(l) as { source: string }).filter((e) => e.source === plugin.id);
      check(`${plugin.name}: ${summary.eventsAdded} event(s) on the journal timeline`,
        mine.length === summary.eventsAdded, `${mine.length} in events.jsonl`);
    }
  }

  fs.rmSync(root, { recursive: true, force: true });

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log(`\n✓ API-first: all ${PLUGINS.length} API sources import through their API into the daily record.\n`);
}

void main();

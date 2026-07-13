#!/usr/bin/env tsx
/**
 * The four ways connecting a source broke on a HOSTED instance — every one of
 * them invisible on a laptop, because they are all about not being on one.
 *
 *   1. OAuth came back to https://0.0.0.0:3000. Next's standalone server builds
 *      `req.url` from HOSTNAME+PORT, so the callback's redirect pointed at the
 *      container's own socket. Spotify connected fine and the user landed on a
 *      dead page.
 *   2. A cold container's first DNS lookup failed, and undici's bare
 *      "fetch failed" reached the user as "Spotify recently-played → fetch
 *      failed" — which reads like a bad key. One blip must not fail a connect.
 *   3. Granola's guide promised "agentqs detects your login" to a server that
 *      physically cannot see the user's Mac.
 *
 * Deterministic, temp data dir, no network. Run: npm run integrations:test
 */
import fs from "fs";
import os from "os";
import path from "path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-integrations-"));
process.env.AGENTQS_DATA_DIR = dataDir;

import { originOf, requestOrigin } from "../src/lib/request-origin";
import { netFetch, type FetchLike } from "../src/lib/importers/plugin";
import { granolaPlugin } from "../src/lib/importers/granola";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

/** What Next hands a route behind a reverse proxy: the socket in req.url, the
 *  truth in the forwarded headers. */
function proxiedRequest(headers: Record<string, string>): Request {
  return new Request("https://0.0.0.0:3000/api/oauth/callback?code=abc&state=xyz", { headers });
}

async function main() {
  console.log("\nIntegrations on a hosted instance\n");

  // 1. THE redirect bug: the bounce must follow the browser's origin, never the
  //    container's socket — otherwise a perfect OAuth connect ends on a dead page.
  const proxied = proxiedRequest({
    host: "0.0.0.0:3000",
    "x-forwarded-host": "48068d-webvp28.vps.flowengine.cloud",
    "x-forwarded-proto": "https",
  });
  const origin = requestOrigin(proxied);
  check("proxied callback resolves the PUBLIC origin", origin === "https://48068d-webvp28.vps.flowengine.cloud", origin);
  check("…so the bounce lands on a reachable page",
    new URL("/pipeline?connected=1", origin).href.startsWith("https://48068d-webvp28.vps.flowengine.cloud/pipeline"),
    new URL("/pipeline?connected=1", origin).href);

  // A proxy that forwards nothing but Host still beats req.url.
  const hostOnly = requestOrigin(proxiedRequest({ host: "agentqs.example.com" }));
  check("Host header alone is enough", hostOnly === "https://agentqs.example.com", hostOnly);

  // Worst case — every header is the bind-any socket: fall back to the origin the
  // dance was STARTED from (the pending redirect URI), never to 0.0.0.0.
  const blind = requestOrigin(
    proxiedRequest({ host: "0.0.0.0:3000" }),
    originOf("https://agentqs.example.com/api/oauth/callback"),
  );
  check("a wildcard host falls back to the origin the connect started from",
    blind === "https://agentqs.example.com", blind);

  // The local dev case must keep working exactly as before.
  const local = new Request("http://127.0.0.1:3106/api/oauth/callback", { headers: { host: "127.0.0.1:3106" } });
  check("localhost is untouched", requestOrigin(local) === "http://127.0.0.1:3106", requestOrigin(local));

  // 2. A transient network blip is retried, and a real one names its cause.
  let attempts = 0;
  const flaky: FetchLike = (async () => {
    attempts++;
    if (attempts < 3) throw new TypeError("fetch failed", { cause: new Error("getaddrinfo EAI_AGAIN api.spotify.com") });
    return new Response('{"items":[]}', { status: 200 });
  }) as FetchLike;
  const res = await netFetch("https://api.spotify.com/v1/me/player/recently-played", {}, flaky);
  check("a cold-start DNS blip is retried, not surfaced as a failed connect", res.ok && attempts === 3, `${attempts} attempts`);

  const dead: FetchLike = (async () => {
    throw new TypeError("fetch failed", { cause: new Error("ENOTFOUND api-7.whoop.com") });
  }) as FetchLike;
  const err = await netFetch("https://api-7.whoop.com/oauth/token", {}, dead).catch((e) => (e as Error).message);
  check("a real network failure names the host and the cause", typeof err === "string" && err.includes("api-7.whoop.com") && err.includes("ENOTFOUND"), String(err));
  check("…and says it is NOT a credential problem", typeof err === "string" && err.includes("not a bad credential"), String(err));

  // A non-network error is never retried or reworded — tests must still fail loudly.
  let called = 0;
  const bug: FetchLike = (async () => {
    called++;
    throw new Error("fixture: unexpected URL");
  }) as FetchLike;
  const bugErr = await netFetch("https://x.test/", {}, bug).catch((e) => (e as Error).message);
  check("a programmer error passes through untouched", bugErr === "fixture: unexpected URL" && called === 1, `${called} call(s)`);

  // 3. Granola's guide must work for someone whose agentqs is NOT on their Mac:
  //    the paste path first, detection as the local-only convenience it is.
  const steps = granolaPlugin.credentialHelp?.steps ?? [];
  check("the Granola guide gives the file to read", steps.some((s) => s.includes("supabase.json")), steps.join(" | "));
  check("…names the token inside it", steps.some((s) => s.includes("workos_tokens.refresh_token")));
  check("…and never claims detection before offering the paste",
    steps.findIndex((s) => s.includes("supabase.json")) < steps.findIndex((s) => s.includes("detect")));
  check("the placeholder no longer promises auto-detection",
    !granolaPlugin.credentialPlaceholder.includes("auto-detected"), granolaPlugin.credentialPlaceholder);

  fs.rmSync(dataDir, { recursive: true, force: true });
  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("\n✓ Integrations: OAuth returns to the real origin, blips retry, dead doors stay shut.\n");
}

void main();

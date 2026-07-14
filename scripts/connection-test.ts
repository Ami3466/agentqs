#!/usr/bin/env tsx
/**
 * Ships-when proof for: A CONNECTION NEVER LIES.
 *
 * The second bug class the user kept hitting. Not missing data — data that looks fine.
 * A source that reads as connected when nothing is connected. A credential that tests
 * green and can never sync. A product switched off that keeps pulling anyway. A sync
 * that lands nothing and reports ok, for months.
 *
 * Every check here is a bug that SHIPPED. Drives the production core against a temp
 * data dir — no network. Run: npm run connection:test
 */
import fs from "fs";
import os from "os";
import path from "path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-conn-"));
process.env.AGENTQS_DATA_DIR = dataDir;

import { readConfig, writeConfig, type AppConfig } from "../src/lib/config";
import { pluginById } from "../src/lib/importers/registry";
import { connectionState, type FetchLike } from "../src/lib/importers/plugin";
import { resolveSyncCredentialFresh } from "../src/lib/oauth";
import { onboardingGuide, type OnboardingStep } from "../src/lib/onboarding";
import { googleState } from "../src/lib/google-connect";
import { google, syncSource } from "../src/lib/cli-core";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const base = {
  username: "t",
  passwordHash: "x",
  sessionSecret: "s",
  createdAt: new Date().toISOString(),
} as unknown as AppConfig;

const CONNECT_STEP = "connect_sources";

async function main() {
  fs.mkdirSync(path.join(dataDir, "record", "daily"), { recursive: true });

  // ---- 1. AN APP KEY IS NOT A CONNECTION -------------------------------------
  // Registering an app with Spotify (client id + secret) and SIGNING IN to Spotify are
  // two different acts. The key is saved once, per provider; the grant is per account.
  // Onboarding counted the KEY: `Object.keys(sourceOAuth)` ticks an entry that holds
  // nothing but a clientId and a secret. This is the author's own live config — key
  // saved, never authorized, zero rows — and the checklist reported "connect a source:
  // done" and walked straight past it.
  console.log("\nan app key is not a connection:");
  writeConfig({
    ...base,
    sourceOAuth: { spotify: { clientId: "cid", clientSecret: "csec" } },
  } as unknown as AppConfig);

  const spotify = pluginById("spotify")!;
  check(
    "the connection rule itself holds: no token → not connected",
    connectionState(spotify, readConfig(), "spotify").connected === false,
  );
  const connectStep = onboardingGuide().steps.find((s: OnboardingStep) => s.id === CONNECT_STEP);
  check(
    "…and onboarding agrees — a saved key does NOT tick 'connect a source'",
    connectStep?.done === false,
    `done=${connectStep?.done}`,
  );

  // Sign in for real → NOW it is connected.
  writeConfig({
    ...base,
    oauthApps: { spotify: { clientId: "cid", clientSecret: "csec" } },
    sourceOAuth: { spotify: { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3.6e6 } },
  } as unknown as AppConfig);
  check(
    "signing in DOES connect it (the grant holds a token)",
    connectionState(spotify, readConfig(), "spotify").connected === true,
  );
  check(
    "…and onboarding ticks the step",
    onboardingGuide().steps.find((s: OnboardingStep) => s.id === CONNECT_STEP)?.done === true,
  );

  // ---- 2. A PASTED TOKEN RESCUES A DEAD GRANT --------------------------------
  // Revoke the app at Spotify. The sync fails. The connect form offers "or paste a
  // short-lived access token" — you paste one, it tests green, the UI says connected…
  // and every sync still fails forever, because the resolver checked the DEAD grant
  // first and threw before ever reaching the token you just saved. Every surface said
  // connected while the source was permanently broken.
  console.log("\na pasted token rescues a revoked grant:");
  writeConfig({
    ...base,
    oauthApps: { spotify: { clientId: "cid", clientSecret: "csec" } },
    sourceOAuth: { spotify: { accessToken: "dead", refreshToken: "revoked", expiresAt: Date.now() - 1000 } },
    sourceCreds: { spotify: "BQ-freshly-pasted" },
  } as unknown as AppConfig);

  // Spotify's token endpoint rejects the revoked refresh token, as it would in life.
  const revoked: FetchLike = (async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as FetchLike;

  const rescued = await resolveSyncCredentialFresh(spotify, undefined, readConfig(), "spotify", revoked);
  check(
    "the sync reaches the token the user pasted, instead of dying on the dead grant",
    rescued === "BQ-freshly-pasted",
    String(rescued),
  );

  // With nothing pasted, the failure must still be LOUD — never a silent empty token.
  writeConfig({
    ...base,
    oauthApps: { spotify: { clientId: "cid", clientSecret: "csec" } },
    sourceOAuth: { spotify: { accessToken: "dead", refreshToken: "revoked", expiresAt: Date.now() - 1000 } },
  } as unknown as AppConfig);
  const stillFails = await resolveSyncCredentialFresh(spotify, undefined, readConfig(), "spotify", revoked)
    .then(() => false)
    .catch(() => true);
  check("…but with nothing to fall back to, a revoked grant still fails loudly", stillFails);

  // ---- 3. AN UNTICKED PRODUCT REFUSES TO SYNC --------------------------------
  // The tick says what the one Google key may bring in. It was enforced in exactly one
  // place — the `due` flag — so the cron obeyed it and every other door ignored it.
  // Untick Calendar and `agentqs sync` or POST /api/import/gcal pulled it anyway.
  console.log("\nan unticked product refuses to sync, on every door:");
  writeConfig({
    ...base,
    googleProducts: ["gmail.inbox"], // Calendar OFF, Gmail on
    sourceOAuth: { google: { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3.6e6 } },
  } as unknown as AppConfig);
  const refused = await syncSource({ id: "gcal" })
    .then(() => "")
    .catch((e: Error) => e.message);
  check(
    "syncing an unticked Calendar is REFUSED, not quietly obeyed",
    /switched off|will not sync/i.test(refused),
    refused.slice(0, 70) || "it synced anyway",
  );

  // Ticking it back on lets it through (the guard gates on the tick, not on the key).
  google({ enable: ["calendar"] });
  const allowed = await syncSource({ id: "gcal" })
    .then(() => "")
    .catch((e: Error) => e.message);
  check(
    "…and ticking it back on lets it through to the API",
    !/switched off/i.test(allowed),
    allowed.slice(0, 60),
  );

  // ---- 4. THE APP KEY IS READ FROM WHERE IT LIVES ----------------------------
  // `clientIdSet` means "the app credentials are saved but the dance never finished".
  // It read the GRANT (`g.clientId`), but the modern key is saved per PROVIDER at
  // `config.oauthApps` — so for anyone who is not a legacy user it could never be true:
  // save the Google key, don't sign in, and the card reported no key at all. Same class
  // as the Trakt bug that read client creds off the grant and produced "undefined:<token>".
  console.log("\nthe app key is read from where it actually lives:");
  writeConfig({ ...base, oauthApps: { google: { clientId: "cid", clientSecret: "csec" } } } as unknown as AppConfig);
  const saved = googleState();
  check(
    "a saved Google app key is SEEN, even before anyone signs in",
    saved.clientIdSet === true && saved.connected === false,
    `clientIdSet=${saved.clientIdSet} connected=${saved.connected}`,
  );

  // ---- 5. A TOKEN WE CANNOT PROVE IS FRESH GETS REFRESHED ---------------------
  // A provider that omits `expires_in` leaves `expiresAt` unset — and that was read as
  // "never expires". So the stored access token was used until it died and the sync
  // 401'd, on a connection that only needed one refresh call.
  console.log("\na token we cannot prove is fresh is refreshed, not gambled on:");
  writeConfig({
    ...base,
    oauthApps: { spotify: { clientId: "cid", clientSecret: "csec" } },
    sourceOAuth: { spotify: { accessToken: "stale-but-undated", refreshToken: "rt" } }, // NO expiresAt
  } as unknown as AppConfig);
  let refreshed = false;
  const tokenEndpoint: FetchLike = (async () => {
    refreshed = true;
    return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 });
  }) as unknown as FetchLike;
  const tok = await resolveSyncCredentialFresh(spotify, undefined, readConfig(), "spotify", tokenEndpoint);
  check(
    "an undated access token is refreshed rather than used until it 401s",
    refreshed && tok === "fresh",
    `refreshed=${refreshed} token=${tok}`,
  );

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("\n✓ A connection never lies: an app key is not a login, a pasted token rescues a revoked grant, and an unticked product refuses to sync on every door.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

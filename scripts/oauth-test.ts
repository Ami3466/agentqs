#!/usr/bin/env tsx
/**
 * Ships-when proof for source connect guides + the OAuth dance.
 *
 *   MAIN: an expiring-token source (Spotify) connects via the authorization-code
 *   flow — beginOAuth builds the provider URL and stashes state, completeOAuth
 *   validates state + exchanges the code, and the source is then CONNECTED
 *   (stored grant = stored credential). A later sync mints a fresh access token
 *   from the refresh token (rotation persisted); disconnect forgets the grant.
 *   PLUS: every credentialed plugin ships a credentialHelp guide, so no source
 *   is a bare paste box.
 *
 * Drives the production core against a temp data dir — no network (token
 * endpoint faked via injected fetch). Run: npm run oauth:test
 */
import fs from "fs";
import os from "os";
import path from "path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-oauth-"));
process.env.AGENTQS_DATA_DIR = dataDir;

import { readConfig, writeConfig, type AppConfig } from "../src/lib/config";
import { PLUGINS, pluginById } from "../src/lib/importers/registry";
import { connectionState, resolveSyncCredential, type FetchLike } from "../src/lib/importers/plugin";
import {
  beginOAuth,
  completeOAuth,
  freshOAuthToken,
  oauthRedirectUri,
  resolveSyncCredentialFresh,
} from "../src/lib/oauth";
import { disconnectSource, sourceGuide } from "../src/lib/cli-core";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

/** Fake token endpoint: records every call, replies with `reply`. */
function fakeToken(reply: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fn = (async (url: unknown, init?: { headers?: Record<string, string>; body?: unknown }) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, body: String(init?.body ?? "") });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as FetchLike;
  return { fn, calls };
}

const neverFetch = (async () => {
  throw new Error("fetch must not be called here");
}) as unknown as FetchLike;

async function main() {
  fs.mkdirSync(path.join(dataDir, "record", "daily"), { recursive: true });
  writeConfig({
    username: "t",
    passwordHash: "x",
    sessionSecret: "s",
    createdAt: new Date().toISOString(),
  } as unknown as AppConfig);

  // --- 1. Every credentialed plugin ships a guide; OAuth is on the expiring four.
  console.log("guides:");
  for (const p of PLUGINS) {
    check(
      `${p.id} has credentialHelp`,
      Boolean(p.credentialHelp && p.credentialHelp.url && p.credentialHelp.steps.length >= 2),
    );
  }
  for (const id of ["spotify", "gcal", "fitbit", "strava"]) {
    check(`${id} connects via OAuth`, Boolean(pluginById(id)?.oauth));
  }
  const g = sourceGuide("spotify");
  check("sourceGuide(spotify) → oauth + redirect hint", g.oauth && g.redirectUriHint.includes("/api/oauth/callback"));
  check("sourceGuide(github) exists", sourceGuide("github").steps.length > 0);
  check("sourceGuide(whoop) exists", sourceGuide("whoop").steps.length > 0);

  // --- 2. begin: authorize URL + stashed state.
  console.log("begin:");
  const origin = "http://127.0.0.1:3106";
  const { authorizeUrl, redirectUri } = beginOAuth("spotify", "cid", "csec", origin);
  const u = new URL(authorizeUrl);
  check("authorize URL is the provider's", u.origin + u.pathname === "https://accounts.spotify.com/authorize");
  check("client_id + scope + response_type", u.searchParams.get("client_id") === "cid" && u.searchParams.get("scope") === "user-read-recently-played" && u.searchParams.get("response_type") === "code");
  check("redirect uri is the app callback", u.searchParams.get("redirect_uri") === `${origin}/api/oauth/callback` && redirectUri === oauthRedirectUri(origin));
  const state = u.searchParams.get("state") ?? "";
  check("state stashed in config", Boolean(state) && readConfig()?.oauthPending?.state === state);
  check("app creds stored", readConfig()?.sourceOAuth?.spotify?.clientId === "cid");

  // --- 3. callback: state must match; the exchange stores the grant.
  console.log("complete:");
  let stateRejected = false;
  await completeOAuth("code123", "WRONG", neverFetch).catch(() => (stateRejected = true));
  check("mismatched state rejected", stateRejected);
  const ex = fakeToken({ access_token: "AT1", refresh_token: "RT1", expires_in: 3600 });
  const done = await completeOAuth("code123", state, ex.fn);
  check("exchange hits the token URL", ex.calls[0]?.url === "https://accounts.spotify.com/api/token");
  check("spotify sends Basic client auth", (ex.calls[0]?.headers.Authorization ?? "").startsWith("Basic "));
  const exBody = new URLSearchParams(ex.calls[0]?.body ?? "");
  check("authorization_code + same redirect_uri", exBody.get("grant_type") === "authorization_code" && exBody.get("redirect_uri") === redirectUri);
  check("returns the connected instance", done.instanceId === "spotify");
  const afterCfg = readConfig();
  check("grant stored, pending cleared", afterCfg?.sourceOAuth?.spotify?.refreshToken === "RT1" && !afterCfg?.oauthPending);
  check("auto-sync defaulted to daily", afterCfg?.sourceIntervals?.spotify === "daily");
  const spotify = pluginById("spotify")!;
  const st = connectionState(spotify, afterCfg, "spotify");
  check("source is CONNECTED (origin saved)", st.connected && st.credentialOrigin === "saved");
  check("presence checks see a credential", Boolean(resolveSyncCredential(spotify, undefined, afterCfg, "spotify")));

  // --- 4. sync-time token: valid → as-is; expired → refreshed + rotation persisted.
  console.log("refresh:");
  check("valid token returned without a refresh", (await freshOAuthToken("spotify", readConfig(), neverFetch)) === "AT1");
  const expired = readConfig()!;
  expired.sourceOAuth!.spotify.expiresAt = new Date(Date.now() - 1000).toISOString();
  writeConfig(expired);
  const rf = fakeToken({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 });
  check("expired token refreshed", (await freshOAuthToken("spotify", readConfig(), rf.fn)) === "AT2");
  const rfBody = new URLSearchParams(rf.calls[0]?.body ?? "");
  check("refresh_token grant used", rfBody.get("grant_type") === "refresh_token" && rfBody.get("refresh_token") === "RT1");
  const rotated = readConfig()?.sourceOAuth?.spotify;
  check("rotation persisted", rotated?.refreshToken === "RT2" && rotated?.accessToken === "AT2" && Date.parse(rotated?.expiresAt ?? "") > Date.now());
  check("resolveSyncCredentialFresh: explicit wins", (await resolveSyncCredentialFresh(spotify, "PASTED", readConfig(), "spotify", neverFetch)) === "PASTED");
  check("resolveSyncCredentialFresh: grant → fresh token", (await resolveSyncCredentialFresh(spotify, undefined, readConfig(), "spotify", neverFetch)) === "AT2");

  // --- 5. Google-style: body client auth + offline params.
  console.log("gcal:");
  const gUrl = new URL(beginOAuth("gcal", "gid", "gsec", origin).authorizeUrl);
  check("offline + consent requested", gUrl.searchParams.get("access_type") === "offline" && gUrl.searchParams.get("prompt") === "consent");
  const gex = fakeToken({ access_token: "GA", refresh_token: "GR", expires_in: 3599 });
  await completeOAuth("gcode", gUrl.searchParams.get("state") ?? "", gex.fn);
  const gBody = new URLSearchParams(gex.calls[0]?.body ?? "");
  check("client creds travel in the body", gBody.get("client_id") === "gid" && gBody.get("client_secret") === "gsec" && !gex.calls[0]?.headers.Authorization);

  // --- 6. disconnect forgets the grant (a grant is a stored credential).
  console.log("disconnect:");
  fs.writeFileSync(path.join(dataDir, "record", "daily", "spotify.csv"), "date,tracks\n2026-07-01,3\n");
  disconnectSource("spotify");
  check("grant gone after disconnect", !readConfig()?.sourceOAuth?.spotify);
  check("gcal grant untouched", Boolean(readConfig()?.sourceOAuth?.gcal));

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

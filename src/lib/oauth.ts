import crypto from "crypto";
import { readConfig, writeConfig, type AppConfig, type OAuthGrant } from "./config";
import { pluginInstanceById, pluginInstanceName } from "./importers/registry";
import {
  resolveSyncCredential,
  type FetchLike,
  type ImporterPlugin,
  type OAuthProviderConfig,
} from "./importers/plugin";

/**
 * The OAuth2 authorization-code dance for expiring-token sources (Spotify,
 * Google Calendar, Fitbit, Strava). Pasting an access token can't work there —
 * it dies within hours and there is no way to mint one without a registered
 * app — so connect is: register an app with the provider (the form shows the
 * EXACT redirect URI to enter), paste client id + secret, authorize in the
 * browser, and from then on every sync mints a fresh access token from the
 * stored refresh token. The grant lives in config.sourceOAuth — a stored,
 * revocable credential, exactly like a pasted key (connected ⇔ stored credential).
 */

/** The one callback endpoint every provider redirects back to. Shown in the
 *  connect form so the user registers it verbatim (Spotify rejects "localhost" —
 *  open the app via http://127.0.0.1:<port> and the origin follows). */
export function oauthRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/oauth/callback`;
}

function oauthPlugin(instanceId: string): { plugin: ImporterPlugin; o: OAuthProviderConfig } {
  const inst = pluginInstanceById(instanceId);
  if (!inst) throw new Error(`Unknown API source "${instanceId}".`);
  if (!inst.plugin.oauth) {
    throw new Error(`${inst.plugin.name} does not use the OAuth connect — paste its ${inst.plugin.credentialLabel}.`);
  }
  return { plugin: inst.plugin, o: inst.plugin.oauth };
}

/** Save the user's app credentials + a state nonce, return the authorize URL to
 *  send the browser to. Re-running overwrites the app creds but keeps any
 *  previously minted tokens until the new dance completes. */
export function beginOAuth(
  instanceId: string,
  clientId: string,
  clientSecret: string,
  origin: string,
): { authorizeUrl: string; redirectUri: string } {
  const { o } = oauthPlugin(instanceId);
  if (!clientId?.trim() || !clientSecret?.trim()) {
    throw new Error("Both the Client ID and the Client Secret are required.");
  }
  const cfg = readConfig();
  if (!cfg) throw new Error("Run setup first.");
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = oauthRedirectUri(origin);
  cfg.sourceOAuth = {
    ...(cfg.sourceOAuth ?? {}),
    [instanceId]: {
      ...(cfg.sourceOAuth?.[instanceId] ?? {}),
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
    },
  };
  cfg.oauthPending = { state, instanceId, redirectUri, createdAt: new Date().toISOString() };
  writeConfig(cfg);
  const url = new URL(o.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId.trim());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", o.scope);
  url.searchParams.set("state", state);
  for (const [k, v] of Object.entries(o.extraAuthParams ?? {})) url.searchParams.set(k, v);
  return { authorizeUrl: url.toString(), redirectUri };
}

interface TokenReply {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/** Withings wraps every reply in {status, body}; status !== 0 is the error
 *  channel even on HTTP 200. */
interface WithingsEnvelope {
  status?: number;
  error?: string;
  body?: TokenReply;
}

/** POST the token request — form-encoded by default, JSON for providers that
 *  demand it (Trakt); client creds per the provider's style. */
async function tokenRequest(
  o: OAuthProviderConfig,
  grant: OAuthGrant,
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenReply> {
  const all: Record<string, string> = { ...params, ...(o.tokenExtraParams ?? {}) };
  const headers: Record<string, string> = { Accept: "application/json" };
  if (o.tokenAuth === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${grant.clientId}:${grant.clientSecret}`).toString("base64")}`;
  } else {
    all.client_id = grant.clientId;
    all.client_secret = grant.clientSecret;
  }
  let body: string;
  if (o.tokenBody === "json") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(all);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(all).toString();
  }
  const res = await fetchImpl(o.tokenUrl, { method: "POST", headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}${text ? ` — ${text.trim().slice(0, 200)}` : ""}`);
  let reply = JSON.parse(text) as TokenReply;
  if (o.tokenUnwrap === "withings") {
    const env = reply as WithingsEnvelope;
    if (env.status !== 0 || !env.body) {
      throw new Error(`status ${env.status ?? "?"}${env.error ? ` — ${env.error}` : ""}`);
    }
    reply = env.body;
  }
  if (!reply.access_token) throw new Error(`token endpoint returned no access_token`);
  return reply;
}

function expiryISO(expiresIn: number | undefined): string | undefined {
  // Renew a minute early so a token never dies mid-sync.
  return typeof expiresIn === "number" && expiresIn > 0
    ? new Date(Date.now() + Math.max(0, expiresIn - 60) * 1000).toISOString()
    : undefined;
}

function saveGrant(instanceId: string, grant: OAuthGrant, mutate?: (cfg: AppConfig) => void): void {
  const cfg = readConfig();
  if (!cfg) return;
  cfg.sourceOAuth = { ...(cfg.sourceOAuth ?? {}), [instanceId]: grant };
  mutate?.(cfg);
  writeConfig(cfg);
}

/** The provider redirected back: validate state, exchange the code, store the
 *  tokens. A fresh OAuth connect defaults to daily — auto-sync for a source,
 *  auto-backup for a backup target (whose cadence lives under `config.backup`,
 *  never in `sourceIntervals`). Returns the connected instance for the redirect. */
export async function completeOAuth(
  code: string,
  state: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ instanceId: string; name: string }> {
  const cfg = readConfig();
  const pending = cfg?.oauthPending;
  if (!cfg || !pending || !state || pending.state !== state) {
    throw new Error("No matching authorization in progress — start the connect again from Pipeline.");
  }
  const inst = pluginInstanceById(pending.instanceId);
  const grant = cfg.sourceOAuth?.[pending.instanceId];
  if (!inst?.plugin.oauth || !grant) {
    throw new Error("The pending authorization lost its app credentials — start the connect again.");
  }
  const tok = await tokenRequest(
    inst.plugin.oauth,
    grant,
    { grant_type: "authorization_code", code, redirect_uri: pending.redirectUri },
    fetchImpl,
  );
  saveGrant(
    pending.instanceId,
    {
      ...grant,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? grant.refreshToken,
      expiresAt: expiryISO(tok.expires_in),
    },
    (latest) => {
      delete latest.oauthPending;
      if (inst.plugin.backupTarget) {
        if (!latest.backup?.drive?.interval) {
          latest.backup = { ...(latest.backup ?? {}), drive: { ...(latest.backup?.drive ?? {}), interval: "daily" } };
        }
      } else if (!latest.sourceIntervals?.[pending.instanceId]) {
        latest.sourceIntervals = { ...(latest.sourceIntervals ?? {}), [pending.instanceId]: "daily" };
      }
    },
  );
  return { instanceId: pending.instanceId, name: pluginInstanceName(inst) };
}

/** A valid access token for a sync — refreshed (and persisted, keeping a rotated
 *  refresh token) when the stored one is past its expiry. */
export async function freshOAuthToken(
  instanceId: string,
  cfg: AppConfig | null = readConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<string | undefined> {
  const grant = cfg?.sourceOAuth?.[instanceId];
  if (!grant?.accessToken && !grant?.refreshToken) return undefined;
  const valid = grant.accessToken && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now());
  if (valid) return grant.accessToken;
  const { plugin, o } = oauthPlugin(instanceId);
  if (!grant.refreshToken) {
    throw new Error(`${plugin.name} access token expired and no refresh token is stored — reconnect in Pipeline.`);
  }
  let tok: TokenReply;
  try {
    tok = await tokenRequest(o, grant, { grant_type: "refresh_token", refresh_token: grant.refreshToken }, fetchImpl);
  } catch (e) {
    throw new Error(`${plugin.name} token refresh failed (${(e as Error).message}) — reconnect in Pipeline.`);
  }
  const updated: OAuthGrant = {
    ...grant,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? grant.refreshToken,
    expiresAt: expiryISO(tok.expires_in),
  };
  try {
    saveGrant(instanceId, updated);
  } catch {
    /* non-fatal: the sync still runs with the fresh token */
  }
  return updated.accessToken;
}

/** Sync-time credential: explicit → fresh OAuth token → key/env/saved (a
 *  discovered desktop-app token still never syncs uninvited). A
 *  `grantCredential: "clientId:token"` provider (Trakt) gets the credential in
 *  the plugin's own combined format, so the importer needs no OAuth awareness. */
export async function resolveSyncCredentialFresh(
  plugin: ImporterPlugin,
  explicit: string | undefined,
  cfg: AppConfig | null,
  instanceId: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | undefined> {
  if (explicit && explicit.trim()) return explicit.trim();
  const grant = cfg?.sourceOAuth?.[instanceId];
  if (grant?.accessToken || grant?.refreshToken) {
    const token = await freshOAuthToken(instanceId, cfg, fetchImpl);
    if (token && plugin.oauth?.grantCredential === "clientId:token") {
      return `${grant.clientId}:${token}`;
    }
    return token;
  }
  return resolveSyncCredential(plugin, undefined, cfg, instanceId);
}

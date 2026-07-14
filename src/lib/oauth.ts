import crypto from "crypto";
import { readConfig, writeConfig, type AppConfig, type OAuthApp, type OAuthGrant } from "./config";
import { pluginInstanceById, pluginInstanceName } from "./importers/registry";
import {
  oauthGrantKey,
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

/**
 * Where this instance's grant lives. Usually its own id — but Google Calendar and
 * Gmail are ONE Google account with ONE key, so both resolve to `sourceOAuth.google`
 * (see `oauthGrantKey`). Reads fall back to the plugin's own id, which is where a
 * grant minted before the shared key existed still sits; the next write migrates it
 * to the shared slot without ever deleting the old one.
 */
function grantKeyOf(instanceId: string): string {
  const inst = pluginInstanceById(instanceId);
  return inst ? oauthGrantKey(inst.plugin, instanceId) : instanceId;
}

function readGrant(cfg: AppConfig | null, instanceId: string): { grant?: OAuthGrant; key: string } {
  const key = grantKeyOf(instanceId);
  return { grant: cfg?.sourceOAuth?.[key] ?? cfg?.sourceOAuth?.[instanceId], key };
}

/**
 * WHERE THE APP KEY LIVES — the provider, not the account. Registering an app with
 * Google and signing in to a Google account are two different acts: the key is
 * registered once and every account you ever add rides it. Keying it per account
 * (which is what storing it on the grant did) forced the user to re-paste the client
 * id + secret to add a second account or to simply log back in after a revoke. The
 * key never changed. It is the same key.
 */
export function appKeyOf(instanceId: string): string {
  const inst = pluginInstanceById(instanceId);
  if (!inst) return instanceId;
  // Extra accounts ("spotify-2") share the BASE provider's app — that is the whole
  // point of an app key. `oauthGrantKey` deliberately splits them, because the
  // GRANT is per account; the app is not.
  return inst.plugin.oauth?.providerKey ?? inst.plugin.id;
}

/**
 * The registered app for this source. Reads the modern per-provider slot first, then
 * falls back to any app creds stored inside an existing grant (where they used to
 * live) — so a user who connected before this split never re-enters anything, and
 * their next save migrates the key to the shared slot.
 */
export function readOAuthApp(cfg: AppConfig | null, instanceId: string): OAuthApp | undefined {
  const app = cfg?.oauthApps?.[appKeyOf(instanceId)];
  if (app?.clientId && app?.clientSecret) return app;
  // Legacy: the key on the grant — this instance's, then the provider's base.
  for (const g of [cfg?.sourceOAuth?.[grantKeyOf(instanceId)], cfg?.sourceOAuth?.[appKeyOf(instanceId)]]) {
    if (g?.clientId && g?.clientSecret) return { clientId: g.clientId, clientSecret: g.clientSecret };
  }
  return undefined;
}

/** Save the app key for a provider WITHOUT starting a dance. "Save the key" and
 *  "sign in" are separate buttons because they are separate acts. */
export function saveOAuthApp(instanceId: string, clientId: string, clientSecret: string): { provider: string } {
  oauthPlugin(instanceId); // must be an OAuth source
  if (!clientId?.trim() || !clientSecret?.trim()) {
    throw new Error("Both the Client ID and the Client Secret are required.");
  }
  const cfg = readConfig();
  if (!cfg) throw new Error("Run setup first.");
  const provider = appKeyOf(instanceId);
  cfg.oauthApps = {
    ...(cfg.oauthApps ?? {}),
    [provider]: { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
  };
  writeConfig(cfg);
  return { provider };
}

/** Forget the app key for a provider ("use another key"). The grants it minted are
 *  left alone — they die on their own when the provider revokes them. */
export function forgetOAuthApp(instanceId: string): void {
  const cfg = readConfig();
  if (!cfg?.oauthApps) return;
  delete cfg.oauthApps[appKeyOf(instanceId)];
  writeConfig(cfg);
}

/** The scope to ask for. Static for most providers; for Google it is the union over
 *  the products the user actually TICKED, so unchecking Gmail stops us asking for
 *  mail access on the next authorize. */
function scopeToRequest(o: OAuthProviderConfig, cfg: AppConfig | null): string {
  return o.scopeFor?.(cfg) ?? o.scope;
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
  // Signing in does NOT require the app key again. It was saved when the app was
  // registered; pass it only to REPLACE it ("use another key"). Re-demanding it to
  // add a second account, or just to log back in, is asking the user to re-do
  // paperwork that never expired.
  if (clientId?.trim() || clientSecret?.trim()) {
    saveOAuthApp(instanceId, clientId, clientSecret);
  }
  const cfg = readConfig();
  if (!cfg) throw new Error("Run setup first.");
  const app = readOAuthApp(cfg, instanceId);
  if (!app) {
    throw new Error(
      `No ${pluginInstanceName(pluginInstanceById(instanceId)!)} app key saved yet — add the Client ID + Secret once, then sign in.`,
    );
  }
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = oauthRedirectUri(origin);
  cfg.oauthPending = { state, instanceId, redirectUri, createdAt: new Date().toISOString() };
  writeConfig(cfg);
  const url = new URL(o.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopeToRequest(o, cfg));
  url.searchParams.set("state", state);
  for (const [k, v] of Object.entries(o.extraAuthParams ?? {})) url.searchParams.set(k, v);
  return { authorizeUrl: url.toString(), redirectUri };
}

interface TokenReply {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  /** What the provider actually GRANTED. Google returns this and it is the truth —
   *  the user can untick a scope on the consent screen, so what we asked for and
   *  what we got are not the same thing. */
  scope?: string;
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
  app: OAuthApp,
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenReply> {
  const all: Record<string, string> = { ...params, ...(o.tokenExtraParams ?? {}) };
  const headers: Record<string, string> = { Accept: "application/json" };
  if (o.tokenAuth === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;
  } else {
    all.client_id = app.clientId;
    all.client_secret = app.clientSecret;
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

/** `key` is the GRANT key (`grantKeyOf`), not necessarily the instance id — a
 *  shared provider (Google) writes both its products to the one slot. */
function saveGrant(key: string, grant: OAuthGrant, mutate?: (cfg: AppConfig) => void): void {
  const cfg = readConfig();
  if (!cfg) return;
  cfg.sourceOAuth = { ...(cfg.sourceOAuth ?? {}), [key]: grant };
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
  const { grant, key } = readGrant(cfg, pending.instanceId);
  // The code is exchanged with the PROVIDER'S app key, which is saved independently
  // of any grant — so this works for the very first login (no grant yet) and for a
  // second account just the same.
  const app = readOAuthApp(cfg, pending.instanceId);
  if (!inst?.plugin.oauth || !app) {
    throw new Error("The pending authorization lost its app key — start the connect again.");
  }
  const tok = await tokenRequest(
    inst.plugin.oauth,
    app,
    { grant_type: "authorization_code", code, redirect_uri: pending.redirectUri },
    fetchImpl,
  );
  saveGrant(
    key,
    {
      // No grant yet on a FIRST login (the app key alone got us here) — that is the
      // normal path now, not an error.
      ...(grant ?? {}),
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? grant?.refreshToken,
      expiresAt: expiryISO(tok.expires_in),
      // What we GOT, not what we asked for — the consent screen lets the user drop a
      // scope, and a Google card that then claims Gmail is on would be lying.
      scopes: tok.scope ?? scopeToRequest(inst.plugin.oauth, cfg),
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
  const { grant, key } = readGrant(cfg, instanceId);
  if (!grant?.accessToken && !grant?.refreshToken) return undefined;
  const valid = grant.accessToken && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now());
  if (valid) return grant.accessToken;
  const { plugin, o } = oauthPlugin(instanceId);
  if (!grant.refreshToken) {
    throw new Error(`${plugin.name} access token expired and no refresh token is stored — reconnect in Pipeline.`);
  }
  const app = readOAuthApp(cfg, instanceId);
  if (!app) {
    throw new Error(`${plugin.name} has no app key saved — add the Client ID + Secret in Pipeline, then sign in.`);
  }
  let tok: TokenReply;
  try {
    tok = await tokenRequest(o, app, { grant_type: "refresh_token", refresh_token: grant.refreshToken }, fetchImpl);
  } catch (e) {
    throw new Error(`${plugin.name} token refresh failed (${(e as Error).message}) — reconnect in Pipeline.`);
  }
  const updated: OAuthGrant = {
    ...grant,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? grant.refreshToken,
    expiresAt: expiryISO(tok.expires_in),
    scopes: tok.scope ?? grant.scopes,
  };
  try {
    saveGrant(key, updated);
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
  const { grant } = readGrant(cfg, instanceId);
  if (grant?.accessToken || grant?.refreshToken) {
    const token = await freshOAuthToken(instanceId, cfg, fetchImpl);
    if (token && plugin.oauth?.grantCredential === "clientId:token") {
      // The client id comes from the APP KEY now, not the grant — reading it off the
      // grant here would silently produce "undefined:<token>" for anyone whose key
      // lives in the shared slot.
      const app = readOAuthApp(cfg, instanceId);
      if (!app) throw new Error(`${plugin.name} has no app key saved — add the Client ID + Secret in Pipeline.`);
      return `${app.clientId}:${token}`;
    }
    return token;
  }
  return resolveSyncCredential(plugin, undefined, cfg, instanceId);
}

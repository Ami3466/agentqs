import type { AppConfig } from "../config";
import {
  resolveClientCreds,
  resolveCredential,
  type FetchLike,
  type ImporterPlugin,
  type OAuthConfig,
} from "./plugin";

/**
 * OAuth 2 authorization-code helpers — the connect flow behind WHOOP. Pure and
 * fetch-injectable (like the importer plugins) so the code→token and refresh
 * exchanges run offline against a fixture in the test harness. WHOOP specifics
 * that are easy to miss and are baked in here:
 *
 *   - the `offline` scope must be requested to be issued a refresh token, and
 *   - the token endpoint is form-encoded (application/x-www-form-urlencoded),
 *     returning { access_token, refresh_token, expires_in, scope }.
 */

const OFFLINE_SCOPE = "offline";
/** Refresh a bit early so an in-flight sync never races the expiry. */
const REFRESH_SKEW_MS = 60_000;

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string; // ISO
  scope?: string;
}

/** Space-joined scope string including `offline` (required for a refresh token). */
export function scopeString(oauth: OAuthConfig): string {
  const set = new Set([...oauth.scopes, OFFLINE_SCOPE]);
  return Array.from(set).join(" ");
}

/** Build the provider consent URL to redirect the browser to. */
export function buildAuthorizeUrl(
  oauth: OAuthConfig,
  opts: { clientId: string; redirectUri: string; state: string },
): string {
  const u = new URL(oauth.authUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", scopeString(oauth));
  u.searchParams.set("state", opts.state);
  return u.toString();
}

function toTokens(raw: unknown): OAuthTokens {
  const j = (raw ?? {}) as Record<string, unknown>;
  const accessToken = typeof j.access_token === "string" ? j.access_token : "";
  if (!accessToken) throw new Error("no access_token in token response");
  const expiresIn = Number(j.expires_in);
  return {
    accessToken,
    refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : undefined,
    expiresAt: Number.isFinite(expiresIn)
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : undefined,
    scope: typeof j.scope === "string" ? j.scope : undefined,
  };
}

async function tokenRequest(
  tokenUrl: string,
  form: Record<string, string>,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokens> {
  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).trim().slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`token exchange ${res.status}${body ? ` — ${body}` : ""}`);
  }
  return toTokens(await res.json());
}

/** Exchange an authorization code for an access + refresh token. */
export function exchangeCode(
  oauth: OAuthConfig,
  args: { code: string; clientId: string; clientSecret: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokens> {
  return tokenRequest(
    oauth.tokenUrl,
    {
      grant_type: "authorization_code",
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
    },
    fetchImpl,
  );
}

/** Trade a refresh token for a fresh access (+ rotated refresh) token. */
export function refreshTokens(
  oauth: OAuthConfig,
  args: { refreshToken: string; clientId: string; clientSecret: string },
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokens> {
  return tokenRequest(
    oauth.tokenUrl,
    {
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      scope: OFFLINE_SCOPE,
    },
    fetchImpl,
  );
}

/** Write a token bundle into config in place (access token → sourceCreds so the
 *  generic sync path reads it; refresh bundle → sourceOAuth). Does not persist. */
export function storeTokens(
  cfg: AppConfig,
  plugin: ImporterPlugin,
  tokens: OAuthTokens,
  clientCreds: { clientId?: string; clientSecret?: string } = {},
): void {
  cfg.sourceCreds = { ...(cfg.sourceCreds ?? {}), [plugin.id]: tokens.accessToken };
  const prev = cfg.sourceOAuth?.[plugin.id] ?? {};
  cfg.sourceOAuth = {
    ...(cfg.sourceOAuth ?? {}),
    [plugin.id]: {
      ...prev,
      refreshToken: tokens.refreshToken ?? prev.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope ?? prev.scope,
      clientId: clientCreds.clientId ?? prev.clientId,
      clientSecret: clientCreds.clientSecret ?? prev.clientSecret,
    },
  };
}

/**
 * Return a usable access token for an OAuth plugin, refreshing it in place (into
 * `cfg`) when it has lapsed and a refresh token is available. `changed` tells the
 * caller to persist. For a non-OAuth plugin this is just `resolveCredential`.
 */
export async function ensureFreshToken(
  plugin: ImporterPlugin,
  cfg: AppConfig,
  fetchImpl: FetchLike = fetch,
): Promise<{ credential?: string; changed: boolean }> {
  const oauth = plugin.oauth;
  const current = resolveCredential(plugin, undefined, cfg);
  if (!oauth) return { credential: current, changed: false };

  const store = cfg.sourceOAuth?.[plugin.id];
  const notExpiring =
    current &&
    store?.expiresAt &&
    new Date(store.expiresAt).getTime() - Date.now() > REFRESH_SKEW_MS;
  if (notExpiring) return { credential: current, changed: false };

  if (store?.refreshToken) {
    const { clientId, clientSecret } = resolveClientCreds(plugin, cfg);
    if (clientId && clientSecret) {
      const tokens = await refreshTokens(
        oauth,
        { refreshToken: store.refreshToken, clientId, clientSecret },
        fetchImpl,
      );
      storeTokens(cfg, plugin, tokens, { clientId, clientSecret });
      return { credential: tokens.accessToken, changed: true };
    }
  }
  return { credential: current, changed: false };
}

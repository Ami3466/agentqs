/**
 * The origin the BROWSER used to reach us — never the socket we listen on.
 *
 * Next's standalone server (what the Docker image runs) builds `req.url` from
 * HOSTNAME + PORT, so behind any reverse proxy `new URL(req.url).origin` reads
 * back as `https://0.0.0.0:3000` — a dead address. Anything we hand the browser
 * (the OAuth callback's bounce to /pipeline) or a provider (the redirect_uri)
 * must come from the proxy's forwarded headers instead, or the user lands on a
 * page that cannot load.
 */

/** A bind-any host is the server's socket, not an address a browser can reach. */
const WILDCARD_HOST = /^(0\.0\.0\.0|\[::\]|\[::0\]|::)(:\d+)?$/i;

function firstHeader(req: Request, name: string): string {
  return (req.headers.get(name) ?? "").split(",")[0].trim();
}

/** Public origin of this request. `fallback` (e.g. the origin the OAuth dance
 *  was started from) is used only when the headers carry nothing usable. */
export function requestOrigin(req: Request, fallback?: string): string {
  const host = firstHeader(req, "x-forwarded-host") || firstHeader(req, "host");
  let url: URL | null = null;
  try {
    url = new URL(req.url);
  } catch {
    /* a relative req.url — headers are all we have */
  }
  const proto = firstHeader(req, "x-forwarded-proto") || url?.protocol.replace(":", "") || "http";
  if (host && !WILDCARD_HOST.test(host)) return `${proto}://${host}`;
  const fb = fallback?.trim().replace(/\/+$/, "");
  if (fb) return fb;
  return url?.origin ?? "";
}

/** The origin of a stored absolute URL (a pending redirect URI), or undefined. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

import { NextResponse } from "next/server";
import { viewEtag } from "./cache-stamp";
import { dbPath } from "./paths";

/** Uniform JSON error body for an API route, so an unexpected throw returns
 *  `{error}` with a real status instead of Next's default non-JSON 500. Wrap a
 *  route body's work in try/catch and return this from the catch. */
export function apiError(e: unknown, status = 500): NextResponse {
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
}

/**
 * A read view answered with an ETag, and a 304 when the client already has it.
 *
 * Every read route is a pure function of the derived cache file, so its
 * fingerprint IS its version. With that on the wire the browser stops re-parsing
 * a multi-megabyte journal on every tab visit and the server stops BUILDING one:
 * on a match, `build` is never called — which matters because better-sqlite3 is
 * synchronous, so each avoided build is time the process can spend serving
 * everything else instead of blocking on it.
 *
 * `must-revalidate` with `max-age=0`: the client always asks, but the answer is
 * usually 304-and-nothing. Private, because a record is one person's life.
 *
 * `extra` is anything besides the cache that shapes the payload — the requested
 * window, the day it was asked on.
 */
export function cachedJson<T>(
  req: Request,
  build: () => T,
  extra: Array<string | number | boolean> = [],
): NextResponse {
  const etag = viewEtag(dbPath(), ...extra);
  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "private, max-age=0, must-revalidate" },
    });
  }
  return NextResponse.json(build(), {
    headers: { ETag: etag, "Cache-Control": "private, max-age=0, must-revalidate" },
  });
}

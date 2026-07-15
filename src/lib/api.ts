import { NextResponse } from "next/server";

/** Uniform JSON error body for an API route, so an unexpected throw returns
 *  `{error}` with a real status instead of Next's default non-JSON 500. Wrap a
 *  route body's work in try/catch and return this from the catch. */
export function apiError(e: unknown, status = 500): NextResponse {
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
}

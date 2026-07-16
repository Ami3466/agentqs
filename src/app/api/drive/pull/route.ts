import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { apiError } from "@/lib/api";
import { drivePull } from "@/lib/cli-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/drive/pull {"file":"<id | name | substring>"} — read ONE raw file from
 * the Drive import folder ON REQUEST. The extracted text comes back for the caller
 * to reason over; NOTHING lands in the record (this is a read, like /api/query).
 * Binary and oversize files return a described stub (name, mime, size, note), never
 * megabytes of bytes.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  let body: { file?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* validated below */
  }
  if (!body.file || !body.file.trim()) {
    return NextResponse.json({ error: "Provide a file (Drive id, name, or a unique substring)." }, { status: 400 });
  }
  try {
    return NextResponse.json(await drivePull(body.file));
  } catch (e) {
    return apiError(e);
  }
}

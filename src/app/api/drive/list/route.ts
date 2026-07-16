import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { apiError } from "@/lib/api";
import { driveList } from "@/lib/cli-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/drive/list[?folderId=…] — the manifest of the raw-import folder (file
 * names, ids, mime types, sizes, dates). Read-only: nothing is synced into the
 * record. `folderId` defaults to the configured folder; pass an empty one to list
 * the account's top-level folders (to find the id to point at). An agent GETs this
 * to find a file, then POSTs /api/drive/pull to read it.
 */
export async function GET(req: Request) {
  if (!getCurrentUser()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  try {
    const folderId = new URL(req.url).searchParams.get("folderId") ?? undefined;
    return NextResponse.json(await driveList(folderId ?? undefined));
  } catch (e) {
    return apiError(e);
  }
}

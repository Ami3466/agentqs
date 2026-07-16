import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { apiError } from "@/lib/api";
import { driveImportStatus, driveFolderSet } from "@/lib/cli-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/drive — Drive-import status: is the read-only grant connected, and which
 * folder agentqs may read. The panel derives its state from THIS (survives reload),
 * never one-shot UI state.
 */
export async function GET() {
  if (!getCurrentUser()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  try {
    return NextResponse.json(driveImportStatus());
  } catch (e) {
    return apiError(e);
  }
}

/**
 * POST /api/drive — point agentqs at a folder to read: {"folderId":"…","folderName":"…"}.
 * `{"clear":true}` (or an empty folderId) stops reading any folder without touching
 * the OAuth grant. Nothing here reads a file — that is POST /api/drive/pull.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  let body: { folderId?: string; folderName?: string; clear?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body → clears */
  }
  try {
    const folderId = body.clear ? "" : (body.folderId ?? "").trim();
    return NextResponse.json(driveFolderSet(folderId, body.folderName));
  } catch (e) {
    return apiError(e);
  }
}

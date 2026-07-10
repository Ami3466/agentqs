import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { photosImport, photosStatus } from "@/lib/cli-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Photos under the Pipeline tab. All local — EXIF + thumbnails + CLIP embedding run on the
 * machine; the ORIGINALS never leave it (only metadata is recorded). GET reports the
 * status the panel shows; POST imports a folder (or the Mac Photos library).
 */
export async function GET() {
  if (!getCurrentUser()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  return NextResponse.json(photosStatus());
}

export async function POST(req: Request) {
  if (!getCurrentUser()) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    folder?: string;
    library?: boolean;
    since?: string;
    caption?: boolean;
    push?: boolean;
  };
  if (!body.folder && !body.library) {
    return NextResponse.json({ error: "Give a folder path or turn on the Mac library." }, { status: 400 });
  }
  try {
    const result = await photosImport(body);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

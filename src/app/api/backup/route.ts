import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { backupGithub, backupStatus, syncSource } from "@/lib/cli-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Off-site backup status: GitHub snapshot branch + encrypted Drive archive. */
export async function GET() {
  if (!getCurrentUser()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(backupStatus());
}

/** Run a backup now: {"target":"github"} pushes the record snapshot,
 *  {"target":"drive"} uploads one encrypted archive (the gdrive_backup sync). */
export async function POST(req: Request) {
  if (!getCurrentUser()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { target?: string; remote?: string; branch?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body → validation below */
  }
  try {
    if (body.target === "github") {
      return NextResponse.json(await backupGithub({ remote: body.remote, branch: body.branch }));
    }
    if (body.target === "drive") {
      return NextResponse.json(await syncSource({ id: "gdrive_backup" }));
    }
    return NextResponse.json({ error: 'target must be "github" or "drive"' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

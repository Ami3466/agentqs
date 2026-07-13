import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { backupGithub, backupRestore, backupStatus, syncSource } from "@/lib/cli-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Off-site backup status: GitHub snapshot branch + encrypted Drive archive. */
export async function GET() {
  if (!getCurrentUser()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(backupStatus());
}

/** Run a backup now: {"target":"github"} pushes the record snapshot,
 *  {"target":"drive"} uploads one encrypted archive (the gdrive_backup sync).
 *  {"target":"restore","confirm":"replace-record"} pulls the newest Drive
 *  archive INTO the live store — the migration path onto a fresh instance
 *  (record replaced + retired beside the store; this instance's config kept). */
export async function POST(req: Request) {
  if (!getCurrentUser()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { target?: string; remote?: string; branch?: string; confirm?: string; latest?: boolean; file?: string } = {};
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
    if (body.target === "restore") {
      if (body.confirm !== "replace-record") {
        return NextResponse.json(
          { error: 'restoring into the live store replaces the record — pass confirm:"replace-record"' },
          { status: 400 },
        );
      }
      return NextResponse.json(
        await backupRestore({ latest: body.latest !== false && !body.file, file: body.file, intoStore: true }),
      );
    }
    return NextResponse.json({ error: 'target must be "github", "drive" or "restore"' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

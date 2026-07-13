import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import {
  backupGithub,
  backupRestore,
  backupStatus,
  setBackupPassphrase,
  setGithubBackupInterval,
  syncSource,
} from "@/lib/cli-core";
import { isValidInterval } from "@/lib/sources";

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
  let body: {
    target?: string;
    remote?: string;
    branch?: string;
    token?: string;
    confirm?: string;
    latest?: boolean;
    file?: string;
    value?: string;
    generate?: boolean;
    schedule?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body → validation below */
  }
  try {
    if (body.target === "github") {
      // schedule alone flips the switch (off pauses, daily resumes) — no push.
      if (body.schedule !== undefined) {
        if (!isValidInterval(body.schedule)) return NextResponse.json({ error: "Invalid schedule." }, { status: 400 });
        return NextResponse.json(setGithubBackupInterval(body.schedule));
      }
      return NextResponse.json(await backupGithub({ remote: body.remote, branch: body.branch, token: body.token }));
    }
    if (body.target === "drive") {
      return NextResponse.json(await syncSource({ id: "gdrive_backup" }));
    }
    if (body.target === "passphrase") {
      // Returned ONCE when generated — the UI tells the user to store it off-machine.
      return NextResponse.json(setBackupPassphrase({ value: body.value, generate: body.generate }));
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
    return NextResponse.json({ error: 'target must be "github", "drive", "restore" or "passphrase"' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

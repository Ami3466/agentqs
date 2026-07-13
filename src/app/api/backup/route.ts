import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { backupDrive, backupGithub, backupRestore, backupStatus, setBackupInterval, setBackupPassphrase } from "@/lib/cli-core";
import { readSyncJob, startSyncJob } from "@/lib/sync-jobs";
import { isValidInterval } from "@/lib/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The job id the Drive upload runs under. A BACKUP, not a source sync — it
 *  only borrows the background-job queue so a multi-minute upload survives a
 *  page reload; no source row ever claims this id. */
const DRIVE_JOB = "backup_drive";

/** Off-site backup status: GitHub snapshot branch + encrypted Drive archive,
 *  plus the live Drive upload job (the panel's progress + "still running"). */
export async function GET() {
  if (!getCurrentUser()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ ...backupStatus(), driveJob: readSyncJob(DRIVE_JOB) });
}

/** Run a backup now: {"target":"github"} pushes the record snapshot branch,
 *  {"target":"drive"} uploads one encrypted archive as a background job (202 —
 *  poll GET for its phase). {"target":"github"|"drive","schedule":"daily|off"}
 *  just sets the cadence `sync --due` sweeps. {"target":"restore","confirm":
 *  "replace-record"} pulls the newest Drive archive INTO the live store — the
 *  migration path onto a fresh instance (record replaced + retired beside it;
 *  this instance's config kept). */
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
    // schedule alone flips the switch (off pauses, daily resumes) — no run.
    if ((body.target === "github" || body.target === "drive") && body.schedule !== undefined) {
      if (!isValidInterval(body.schedule)) return NextResponse.json({ error: "Invalid schedule." }, { status: 400 });
      return NextResponse.json(setBackupInterval(body.target, body.schedule));
    }
    if (body.target === "github") {
      return NextResponse.json(await backupGithub({ remote: body.remote, branch: body.branch, token: body.token }));
    }
    if (body.target === "drive") {
      // Encrypting + uploading the whole store takes minutes: run it in the
      // background and hand back the job, exactly like a long import.
      const job = startSyncJob(DRIVE_JOB, async (progress) => {
        progress("encrypting and uploading the archive", 20);
        const r = await backupDrive();
        progress(`uploaded ${r.file}`, 100);
        return {};
      });
      return NextResponse.json({ ok: true, job }, { status: 202 });
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

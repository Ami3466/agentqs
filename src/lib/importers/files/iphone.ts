import fs from "fs";
import os from "os";
import path from "path";
import type { DailyTable } from "../plugin";
import type { FileImporter, FileImportContext, FileImportResult } from "../file-plugin";

/**
 * iPhone backup — a Tier-2 file importer, shipped as a STUB adapter (like WHOOP
 * on the API side). An unencrypted iTunes/Finder backup is a directory holding a
 * `Manifest.db` SQLite whose `Files` table maps every backed-up file to its
 * domain (HomeDomain, CameraRollDomain, …). The heavy extraction — reading the
 * per-domain SQLite files for calls / iMessage / screen-time and bucketing them
 * by day — isn't wired yet, so this reads the manifest and lands a real *snapshot*
 * row for the backup's day:
 *
 *   date, files_backed_up, domains
 *
 * The read path is real and fixture-provable; `live: false` marks it not-yet-full
 * in the Data tab until the per-domain extraction lands (a later loop).
 */

interface ManifestSummary {
  files: number;
  domains: number;
  topDomains: Array<{ domain: string; files: number }>;
}

/** Locate the Manifest.db for a backup, accepting a Manifest.db file, a single
 *  backup dir, or the MobileSync/Backup root (newest device backup wins). */
export function resolveBackupManifest(input: string): { manifest: string; backupDir: string } {
  const stat = fs.statSync(input);
  if (stat.isFile()) {
    if (path.basename(input) !== "Manifest.db") {
      throw new Error(`expected a Manifest.db, got ${path.basename(input)}`);
    }
    return { manifest: input, backupDir: path.dirname(input) };
  }
  // A directory: either the backup itself, or the Backup root of many devices.
  const direct = path.join(input, "Manifest.db");
  if (fs.existsSync(direct)) return { manifest: direct, backupDir: input };

  const candidates = fs
    .readdirSync(input)
    .map((name) => path.join(input, name))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "Manifest.db"));
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`no Manifest.db under ${input} (not an iPhone backup?)`);
  }
  return { manifest: path.join(candidates[0], "Manifest.db"), backupDir: candidates[0] };
}

async function readManifest(manifest: string): Promise<ManifestSummary> {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(manifest, { readonly: true, fileMustExist: true });
  try {
    const hasFiles = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Files'")
      .get();
    if (!hasFiles) throw new Error("no 'Files' table (is this an iOS Manifest.db?)");
    const files = (db.prepare("SELECT COUNT(*) AS n FROM Files").get() as { n: number }).n;
    const domains = (
      db.prepare("SELECT COUNT(DISTINCT domain) AS n FROM Files").get() as { n: number }
    ).n;
    const topDomains = db
      .prepare(
        "SELECT domain, COUNT(*) AS files FROM Files GROUP BY domain ORDER BY files DESC LIMIT 8",
      )
      .all() as Array<{ domain: string; files: number }>;
    return { files, domains, topDomains };
  } finally {
    db.close();
  }
}

/** Backup day: "Last Backup Date" from Info.plist if present, else file mtime. */
function backupDay(backupDir: string, manifest: string): string {
  const info = path.join(backupDir, "Info.plist");
  try {
    const xml = fs.readFileSync(info, "utf8");
    const m = xml.match(/<key>Last Backup Date<\/key>\s*<date>([^<]+)<\/date>/);
    if (m) {
      const d = new Date(m[1]);
      if (Number.isFinite(d.getTime())) return d.toISOString().slice(0, 10);
    }
  } catch {
    /* fall through to mtime */
  }
  return fs.statSync(manifest).mtime.toISOString().slice(0, 10);
}

export async function readIphoneBackup(
  input: string,
  from: string,
  to: string,
): Promise<FileImportResult> {
  const { manifest, backupDir } = resolveBackupManifest(input);
  const summary = await readManifest(manifest);
  const day = backupDay(backupDir, manifest);

  const header = ["date", "files_backed_up", "domains"];
  const rows: string[][] =
    day >= from && day <= to
      ? [[day, String(summary.files), String(summary.domains)]]
      : [];
  const table: DailyTable = { header, rows };
  return {
    table,
    meta: {
      backupDir,
      backupDay: day,
      files: summary.files,
      domains: summary.domains,
      topDomains: summary.topDomains,
      note: "stub: snapshot only — per-domain call/message/screen-time extraction not yet wired",
    },
  };
}

function iphoneDefaultPaths(): string[] {
  const home = os.homedir();
  const paths: string[] = [];
  if (process.platform === "darwin") {
    paths.push(path.join(home, "Library/Application Support/MobileSync/Backup"));
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData/Roaming");
    paths.push(path.join(appData, "Apple Computer/MobileSync/Backup"));
    paths.push(path.join(appData, "Apple/MobileSync/Backup"));
  }
  // Docker: mount your backup dir at /host/iphone-backup:ro.
  paths.push("/host/iphone-backup");
  return paths;
}

export const iphoneImporter: FileImporter = {
  id: "iphone",
  name: "iPhone backup",
  detail: "backup snapshot · local file, stub (agentqs import:file --source iphone)",
  live: false, // stub: snapshot read is real; per-domain extraction not yet wired
  primaryMetric: "files_backed_up",
  unit: "files",
  defaultPaths: iphoneDefaultPaths,
  read(ctx: FileImportContext): Promise<FileImportResult> {
    return readIphoneBackup(ctx.path, ctx.from, ctx.to);
  },
};

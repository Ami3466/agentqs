import { execFileSync, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";
import { readConfig, writeConfig } from "./config";
import { dataDir, recordDir } from "./paths";
import { rebuild } from "./record";
import { isDue, isValidInterval, type Interval } from "./sources";
import type { FetchLike } from "./importers/plugin";

/**
 * Off-site backups — two targets that together cover every byte that matters:
 *
 *   github → a SNAPSHOT BRANCH of the plain-text record. Built with git
 *            plumbing against a temporary index, so the record repo's own
 *            branches (the product's checkpoint commits) are never touched
 *            and their history — which may hold blobs past GitHub's 100 MB
 *            push limit — is never pushed. Files over the limit are excluded
 *            LOUDLY: each is named in the result and covered by Drive.
 *   drive  → ONE encrypted archive of the whole store (record/ + config.json,
 *            minus rebuildable caches, git history and *.bak-* repair copies):
 *            tar → gzip → AES-256-GCM with an scrypt key from
 *            `backup.passphrase`. Uploaded with the gdrive_backup OAuth grant
 *            (drive.file scope — the app only ever sees files it created),
 *            then rotated to the newest `keep`.
 *
 * Restore is the inverse and must stay working: `agentqs backup restore`
 * decrypts + unpacks an archive (local file or --latest from Drive) into a
 * FRESH directory — never over the live store.
 */

// ---- encryption ------------------------------------------------------------

const MAGIC = Buffer.from("AQSBK1"); // archive format tag, bumps on layout change
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // scrypt N=2^15 → ~32 MB, strong enough for an offline-attackable archive.
  return crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}

/** Encrypt a stream to `dst`: MAGIC + salt + iv + ciphertext + GCM tag. */
export async function encryptStreamToFile(
  input: NodeJS.ReadableStream,
  dst: string,
  passphrase: string,
): Promise<void> {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const out = fs.createWriteStream(dst);
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(input, cipher, out);
  fs.appendFileSync(dst, cipher.getAuthTag());
}

/** Decrypt an archive file to `dst`. GCM authenticates: a wrong passphrase or
 *  a flipped byte fails the whole restore instead of yielding garbage. */
export async function decryptFileTo(src: string, dst: string, passphrase: string): Promise<void> {
  const size = fs.statSync(src).size;
  if (size < HEADER_LEN + TAG_LEN) throw new Error(`${src} is not an agentqs backup archive (too small).`);
  const fd = fs.openSync(src, "r");
  const header = Buffer.alloc(HEADER_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  try {
    fs.readSync(fd, header, 0, HEADER_LEN, 0);
    fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`${src} is not an agentqs backup archive (bad header).`);
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = header.subarray(MAGIC.length + SALT_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      fs.createReadStream(src, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
      decipher,
      fs.createWriteStream(dst),
    );
  } catch {
    fs.rmSync(dst, { force: true });
    throw new Error("Decryption failed — wrong passphrase or corrupted archive.");
  }
}

// ---- archive (tar) ----------------------------------------------------------

/** Caches (*.db, models/, browser/) rebuild; git history is GitHub's copy;
 *  *.bak-* repair snapshots are transient. Everything else in record/ +
 *  config.json IS the data. */
const ARCHIVE_EXCLUDES = ["record/.git", "record/.git/*", "*.bak-*", "*.bak"];

export async function createEncryptedArchive(opts: {
  passphrase: string;
  outFile: string;
  dir?: string;
}): Promise<{ bytes: number }> {
  const dir = opts.dir ?? dataDir();
  const members = ["record", "config.json"].filter((m) => fs.existsSync(path.join(dir, m)));
  if (!members.includes("record")) throw new Error(`No record at ${path.join(dir, "record")} — nothing to back up.`);
  const args = ["-cz", ...ARCHIVE_EXCLUDES.flatMap((x) => ["--exclude", x]), "-f", "-", "-C", dir, ...members];
  const tar = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
  let tarErr = "";
  tar.stderr.on("data", (d) => (tarErr += d));
  // Subscribe BEFORE the pipeline await: a fast tar can close before a late
  // listener attaches, and a never-resolving promise exits the process silently.
  const closed = new Promise<number>((resolve) => tar.on("close", resolve));
  await encryptStreamToFile(tar.stdout, opts.outFile, opts.passphrase);
  const code = await closed;
  if (code !== 0) {
    fs.rmSync(opts.outFile, { force: true });
    throw new Error(`tar failed (exit ${code}): ${tarErr.trim()}`);
  }
  return { bytes: fs.statSync(opts.outFile).size };
}

// ---- passphrase --------------------------------------------------------------

export function setBackupPassphrase(opts: { value?: string; generate?: boolean }): {
  set: boolean;
  generated?: string;
} {
  const cfg = readConfig();
  if (!cfg) throw new Error("agentqs isn't set up yet — run the app once (or POST /api/setup) first.");
  let value = opts.value?.trim();
  let generated: string | undefined;
  if (opts.generate) {
    generated = crypto.randomBytes(24).toString("base64url");
    value = generated;
  }
  if (!value) throw new Error("Pass a passphrase or --generate.");
  if (value.length < 8) throw new Error("Passphrase too short — use at least 8 characters.");
  cfg.backup = { ...(cfg.backup ?? {}), passphrase: value };
  writeConfig(cfg);
  return { set: true, generated };
}

/** The GitHub switch: on = ride `sync --due` daily, off = paused. Remote and
 *  token stay saved either way, so flipping back on is instant. */
export function setGithubBackupInterval(interval: string): { interval: Interval } {
  if (!isValidInterval(interval)) throw new Error("Schedule must be off | hourly | daily | weekly.");
  const cfg = readConfig();
  if (!cfg) throw new Error("agentqs isn't set up yet — run the app once (or POST /api/setup) first.");
  cfg.backup = { ...(cfg.backup ?? {}), github: { remote: "", ...(cfg.backup?.github ?? {}), interval } };
  writeConfig(cfg);
  return { interval };
}

function requirePassphrase(): string {
  const pass = readConfig()?.backup?.passphrase;
  if (!pass) {
    throw new Error(
      "No backup passphrase set — run `agentqs backup passphrase --generate` first, " +
        "and store it OUTSIDE this machine: archives are unreadable without it.",
    );
  }
  return pass;
}

// ---- github snapshot branch --------------------------------------------------

/** Leave headroom under GitHub's hard 100 MB per-file push reject. */
const GITHUB_FILE_LIMIT = 95 * 1024 * 1024;
/** Local ref the snapshots accumulate on — the record's own branches stay untouched. */
const BACKUP_REF = "refs/heads/agentqs-backup";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "agentqs backup",
  GIT_AUTHOR_EMAIL: "backup@agentqs.local",
  GIT_COMMITTER_NAME: "agentqs backup",
  GIT_COMMITTER_EMAIL: "backup@agentqs.local",
};

function git(dir: string, args: string[], env?: Record<string, string>): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_IDENTITY, ...env },
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/** Credentials must never surface in errors or status. */
function scrub(msg: string): string {
  return msg.replace(/\/\/[^@/\s]+@/g, "//***@");
}

function injectToken(remote: string, token?: string): string {
  if (!token || !/^https:\/\//.test(remote)) return remote;
  return remote.replace(/^https:\/\//, `https://x-access-token:${token}@`);
}

export interface OversizedFile {
  path: string;
  bytes: number;
}

function oversizedFiles(root: string, limit: number): OversizedFile[] {
  const out: OversizedFile[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (rel === "" && e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && fs.statSync(path.join(root, r)).size > limit) {
        out.push({ path: r, bytes: fs.statSync(path.join(root, r)).size });
      }
    }
  };
  walk("");
  return out;
}

export interface GithubBackupResult {
  remote: string;
  branch: string;
  commit: string;
  changed: boolean; // false = record identical to the last snapshot
  files: number; // files in the pushed snapshot
  excluded: OversizedFile[]; // over the GitHub limit — covered by the Drive archive
  message: string;
}

export interface GithubBackupOpts {
  remote?: string;
  branch?: string;
  token?: string;
  dir?: string; // record dir override (tests)
  sizeLimitBytes?: number; // limit override (tests)
}

/**
 * Snapshot the record and push it. The snapshot is a commit built on a TEMP
 * index (`GIT_INDEX_FILE`), parented only on the previous snapshot, so pushes
 * carry exactly the snapshot chain — never the record repo's own history.
 */
export async function backupGithub(opts: GithubBackupOpts = {}): Promise<GithubBackupResult> {
  const rDir = opts.dir ?? recordDir();
  const cfg = opts.dir ? null : readConfig();
  const saved = cfg?.backup?.github;
  const remote = opts.remote?.trim() || saved?.remote;
  if (!remote) {
    throw new Error(
      "No backup remote configured — run `agentqs backup github --remote <url>` with a PRIVATE GitHub repo URL.",
    );
  }
  const branch = opts.branch?.trim() || saved?.branch || "main";
  const token = opts.token ?? saved?.token ?? cfg?.githubToken ?? process.env.GITHUB_TOKEN;
  const limit = opts.sizeLimitBytes ?? GITHUB_FILE_LIMIT;

  try {
    git(rDir, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    git(rDir, ["init"]);
  }

  const excluded = oversizedFiles(rDir, limit);
  const idx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-bk-")), "index");
  const env = { GIT_INDEX_FILE: idx };
  let commit: string;
  let changed = true;
  let files = 0;
  try {
    git(rDir, ["read-tree", "--empty"], env);
    git(rDir, ["add", "-A", "--", ".", ...excluded.map((e) => `:(exclude)${e.path}`)], env);
    const tree = git(rDir, ["write-tree"], env);
    files = git(rDir, ["ls-files"], env).split("\n").filter(Boolean).length;
    let prev: string | undefined;
    try {
      prev = git(rDir, ["rev-parse", "-q", "--verify", BACKUP_REF]);
    } catch {
      /* first snapshot */
    }
    if (prev && git(rDir, ["rev-parse", `${prev}^{tree}`]) === tree) {
      changed = false;
      commit = prev;
    } else {
      const msg = `backup: ${new Date().toISOString()} — ${files} files${
        excluded.length ? `, ${excluded.length} oversized excluded` : ""
      }`;
      commit = git(rDir, ["commit-tree", tree, ...(prev ? ["-p", prev] : []), "-m", msg], env);
      git(rDir, ["update-ref", BACKUP_REF, commit]);
    }
  } finally {
    fs.rmSync(path.dirname(idx), { recursive: true, force: true });
  }

  const persist = (error?: string) => {
    const c = readConfig();
    if (!c || opts.dir) return; // test runs against an explicit dir don't touch config
    c.backup = {
      ...(c.backup ?? {}),
      github: {
        ...(c.backup?.github ?? {}),
        remote,
        branch,
        ...(opts.token ? { token: opts.token } : {}),
        ...(error ? { lastError: error } : { lastError: undefined, lastAt: new Date().toISOString(), lastCommit: commit }),
      },
    };
    writeConfig(c);
  };

  try {
    git(rDir, ["push", injectToken(remote, token), `${BACKUP_REF}:refs/heads/${branch}`]);
  } catch (e) {
    const err = scrub(String((e as { stderr?: string }).stderr || (e as Error).message));
    persist(err.slice(0, 500));
    throw new Error(`git push failed: ${err}`);
  }
  persist();

  const note = excluded.length
    ? ` ${excluded.length} file(s) over ${Math.round(limit / 1e6)}MB excluded (${excluded
        .map((e) => `${e.path} ${Math.round(e.bytes / 1e6)}MB`)
        .join(", ")}) — covered by the Drive archive.`
    : "";
  return {
    remote: scrub(remote),
    branch,
    commit,
    changed,
    files,
    excluded,
    message: `${changed ? `Pushed snapshot ${commit.slice(0, 7)}` : "No changes since last snapshot"} → ${scrub(remote)} (${branch}).${note}`,
  };
}

// ---- google drive archive -----------------------------------------------------

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
const FOLDER_NAME = "agentqs-backups";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const ARCHIVE_PREFIX = "agentqs-backup-";

interface DriveFile {
  id: string;
  name: string;
  createdTime?: string;
  size?: string;
}

async function driveJson(
  fetchImpl: FetchLike,
  token: string,
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Drive ${init?.method ?? "GET"} ${url.split("?")[0]} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function ensureBackupFolder(fetchImpl: FetchLike, token: string): Promise<string> {
  const cfg = readConfig();
  const savedId = cfg?.backup?.drive?.folderId;
  if (savedId) {
    try {
      const f = (await driveJson(fetchImpl, token, `${DRIVE_API}/files/${savedId}?fields=id,trashed`)) as {
        id?: string;
        trashed?: boolean;
      };
      if (f.id && !f.trashed) return savedId;
    } catch {
      /* deleted remotely — fall through and recreate */
    }
  }
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`);
  const found = (await driveJson(fetchImpl, token, `${DRIVE_API}/files?q=${q}&fields=files(id,name)`)) as {
    files?: DriveFile[];
  };
  if (found.files?.[0]?.id) return found.files[0].id;
  const created = (await driveJson(fetchImpl, token, `${DRIVE_API}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  })) as { id?: string };
  if (!created.id) throw new Error("Drive folder create returned no id.");
  return created.id;
}

async function listArchives(fetchImpl: FetchLike, token: string, folderId: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = (await driveJson(
    fetchImpl,
    token,
    `${DRIVE_API}/files?q=${q}&orderBy=createdTime desc&pageSize=100&fields=files(id,name,createdTime,size)`,
  )) as { files?: DriveFile[] };
  return (res.files ?? []).filter((f) => f.name.startsWith(ARCHIVE_PREFIX));
}

export interface DriveBackupResult {
  date: string; // YYYY-MM-DD the receipt row lands on
  file: string;
  bytes: number;
  mb: number;
  folderId: string;
  rotation: { kept: number; deleted: string[] };
}

export interface DriveBackupOpts {
  credential: string; // fresh OAuth access token (drive.file)
  fetchImpl?: FetchLike;
  dir?: string; // store dir override (tests)
}

/** The Drive backup brain — the gdrive_backup plugin's sync IS this. */
export async function runDriveBackup(opts: DriveBackupOpts): Promise<DriveBackupResult> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const passphrase = requirePassphrase();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  // random suffix: two runs in the same second must never overwrite each other
  const name = `${ARCHIVE_PREFIX}${stamp}-${crypto.randomBytes(2).toString("hex")}.tar.gz.enc`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-drive-"));
  const outFile = path.join(tmp, name);

  const persistError = (error: string) => {
    const c = readConfig();
    if (!c) return;
    c.backup = { ...(c.backup ?? {}), drive: { ...(c.backup?.drive ?? {}), lastError: error.slice(0, 500) } };
    writeConfig(c);
  };

  try {
    const { bytes } = await createEncryptedArchive({ passphrase, outFile, dir: opts.dir });
    const folderId = await ensureBackupFolder(fetchImpl, opts.credential);

    const initiate = await fetchImpl(DRIVE_UPLOAD, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.credential}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/octet-stream",
      },
      body: JSON.stringify({ name, parents: [folderId] }),
    });
    if (!initiate.ok) {
      throw new Error(`Drive upload initiate → HTTP ${initiate.status}: ${(await initiate.text()).slice(0, 300)}`);
    }
    const session = initiate.headers.get("location");
    if (!session) throw new Error("Drive resumable upload returned no session URL.");
    const put = await fetchImpl(session, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: fs.readFileSync(outFile),
    });
    if (!put.ok) throw new Error(`Drive upload → HTTP ${put.status}: ${(await put.text()).slice(0, 300)}`);

    const keep = readConfig()?.backup?.drive?.keep ?? 8;
    const archives = await listArchives(fetchImpl, opts.credential, folderId);
    const deleted: string[] = [];
    for (const old of archives.slice(keep)) {
      await driveJson(fetchImpl, opts.credential, `${DRIVE_API}/files/${old.id}`, { method: "DELETE" });
      deleted.push(old.name);
    }

    const c = readConfig();
    if (c) {
      c.backup = {
        ...(c.backup ?? {}),
        drive: {
          ...(c.backup?.drive ?? {}),
          folderId,
          lastAt: new Date().toISOString(),
          lastFile: name,
          lastBytes: bytes,
          lastError: undefined,
        },
      };
      writeConfig(c);
    }
    return {
      date: new Date().toISOString().slice(0, 10),
      file: name,
      bytes,
      mb: Math.max(1, Math.round(bytes / 1e6)),
      folderId,
      rotation: { kept: Math.min(archives.length, keep), deleted },
    };
  } catch (e) {
    persistError((e as Error).message);
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- restore -------------------------------------------------------------------

export interface RestoreResult {
  out: string;
  archive: string;
  members: string[]; // top-level entries restored (record, config.json)
}

export interface RestoreOpts {
  file?: string; // local .enc archive
  latest?: boolean; // download the newest archive from Drive instead
  credential?: string; // required with latest
  fetchImpl?: FetchLike;
  out: string; // destination dir — must be empty/new; NEVER the live store
  passphrase?: string; // defaults to the configured one
}

/** Resolve the archive to a local file: the given path, or the newest one in
 *  the Drive backup folder downloaded into `tmp`. */
async function acquireArchive(
  opts: { file?: string; latest?: boolean; credential?: string; fetchImpl?: FetchLike },
  tmp: string,
): Promise<{ src: string; name: string }> {
  if (opts.latest) {
    if (!opts.credential) throw new Error("--latest needs the connected gdrive_backup grant.");
    const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
    const folderId = await ensureBackupFolder(fetchImpl, opts.credential);
    const newest = (await listArchives(fetchImpl, opts.credential, folderId))[0];
    if (!newest) throw new Error("No archives in the Drive backup folder yet.");
    const res = await fetchImpl(`${DRIVE_API}/files/${newest.id}?alt=media`, {
      headers: { Authorization: `Bearer ${opts.credential}` },
    });
    if (!res.ok) throw new Error(`Drive download → HTTP ${res.status}`);
    const src = path.join(tmp, newest.name);
    fs.writeFileSync(src, Buffer.from(await res.arrayBuffer()));
    return { src, name: newest.name };
  }
  if (!opts.file) throw new Error("Pass an archive file or --latest.");
  return { src: opts.file, name: path.basename(opts.file) };
}

export async function restoreArchive(opts: RestoreOpts): Promise<RestoreResult> {
  const passphrase = opts.passphrase?.trim() || readConfig()?.backup?.passphrase;
  if (!passphrase) throw new Error("Pass --passphrase (or set one with `agentqs backup passphrase`).");
  const out = path.resolve(opts.out);
  fs.mkdirSync(out, { recursive: true });
  if (fs.readdirSync(out).length > 0) {
    throw new Error(`Refusing to restore into non-empty ${out} — restores always land in a fresh directory.`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-restore-"));
  try {
    const got = await acquireArchive(opts, tmp);
    const tarball = path.join(tmp, "restore.tar.gz");
    await decryptFileTo(got.src, tarball, passphrase);
    execFileSync("tar", ["-xzf", tarball, "-C", out], { encoding: "utf8" });
    return { out, archive: got.name, members: fs.readdirSync(out).sort() };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export interface RestoreIntoStoreResult {
  archive: string;
  retired: string | null; // where the previous record went — kept, never deleted
  dailyRows: number;
}

/**
 * Bring an archive's RECORD into the LIVE store — the migration path onto a
 * fresh instance: deploy, connect gdrive_backup + set the same passphrase,
 * one call, and the whole history is here. Moves DATA, not identity: the
 * instance's own config.json (auth, keys, grants) stays untouched. The
 * previous record is RETIRED beside the store (record.retired-<stamp>) so the
 * replace is revertible by hand, and the cache is rebuilt from the restored
 * text.
 */
export async function restoreIntoStore(opts: {
  file?: string;
  latest?: boolean;
  credential?: string;
  fetchImpl?: FetchLike;
  passphrase?: string;
  dir?: string; // store override (tests)
}): Promise<RestoreIntoStoreResult> {
  const dir = opts.dir ?? dataDir();
  const passphrase = opts.passphrase?.trim() || readConfig()?.backup?.passphrase;
  if (!passphrase) throw new Error("Pass --passphrase (or set one with `agentqs backup passphrase`).");
  // Same filesystem as the store → the final renames are atomic.
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, ".restore-"));
  try {
    const got = await acquireArchive(opts, tmp);
    const tarball = path.join(tmp, "restore.tar.gz");
    await decryptFileTo(got.src, tarball, passphrase);
    const extract = path.join(tmp, "x");
    fs.mkdirSync(extract);
    execFileSync("tar", ["-xzf", tarball, "-C", extract], { encoding: "utf8" });
    const incoming = path.join(extract, "record");
    if (!fs.existsSync(incoming)) throw new Error("Archive holds no record/ — not an agentqs store archive.");

    const live = path.join(dir, "record");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    let retired: string | null = null;
    if (fs.existsSync(live)) {
      retired = path.join(dir, `record.retired-${stamp}`);
      fs.renameSync(live, retired);
    }
    fs.renameSync(incoming, live);
    const dailyRows = rebuild({ dataDir: dir }).daily;
    return { archive: got.name, retired, dailyRows };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- status ---------------------------------------------------------------------

export interface BackupStatusView {
  github: {
    configured: boolean;
    remote?: string;
    branch?: string;
    interval: Interval;
    dueNow: boolean;
    lastAt: string | null;
    lastCommit?: string;
    lastError?: string;
  };
  drive: {
    connected: boolean; // gdrive_backup grant present (the connection rule)
    passphraseSet: boolean;
    keep: number;
    interval: Interval;
    lastAt: string | null;
    lastFile?: string;
    lastError?: string;
  };
}

export function backupStatus(): BackupStatusView {
  const cfg = readConfig();
  const gh = cfg?.backup?.github;
  const dr = cfg?.backup?.drive;
  const grant = cfg?.sourceOAuth?.["gdrive_backup"];
  const ghInterval: Interval = gh?.interval ?? "daily";
  return {
    github: {
      configured: Boolean(gh?.remote),
      remote: gh?.remote ? scrub(gh.remote) : undefined,
      branch: gh?.branch ?? "main",
      interval: ghInterval,
      dueNow: Boolean(gh?.remote) && isDue(gh?.lastAt ?? null, ghInterval),
      lastAt: gh?.lastAt ?? null,
      lastCommit: gh?.lastCommit,
      lastError: gh?.lastError,
    },
    drive: {
      connected: Boolean(grant?.refreshToken || grant?.accessToken || cfg?.sourceCreds?.["gdrive_backup"]),
      passphraseSet: Boolean(cfg?.backup?.passphrase),
      keep: dr?.keep ?? 8,
      interval: cfg?.sourceIntervals?.["gdrive_backup"] ?? "off",
      lastAt: dr?.lastAt ?? null,
      lastFile: dr?.lastFile,
      lastError: dr?.lastError,
    },
  };
}

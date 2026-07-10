import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { dataDir, defaultStoreDir, storeCandidates, storeRank } from "./paths";
import { readSyncJobs } from "./sync-jobs";

/**
 * Store health + migration. File-sync engines (iCloud Desktop & Documents,
 * Dropbox, OneDrive, Google Drive) are the one environment a store cannot
 * survive: they evict file contents (macOS "dataless" placeholders that hang
 * reads), rename conflicting files to "X 2" and resurrect deleted dirs from
 * cloud state. The doctor detects a store living in that world; migrateStore
 * moves it to the platform app-data dir (or an explicit target) with hash
 * verification, retires the source so no ghost can shadow the new store, and
 * re-points the schedulers agentqs installed.
 */

export interface StoreCheck {
  id: "location" | "eviction" | "conflicts" | "split";
  severity: "ok" | "warn" | "bad";
  title: string;
  detail: string;
}

export interface DoctorReport {
  dataDir: string;
  safeDir: string;
  atDefault: boolean;
  /** No "bad" findings (warns don't flip this). */
  safe: boolean;
  checks: StoreCheck[];
}

/** The one-line version for the Settings payload. */
export interface StoreSummary {
  safe: boolean;
  atDefault: boolean;
  /** AGENTQS_DATA_DIR pins the location — in-app migration would strand the store. */
  envPinned: boolean;
  safeDir: string;
  issues: string[];
}

function safeReal(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function under(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Which sync engine's domain a path lives in, or null. Best-effort per platform. */
export function syncDomainOf(p: string): string | null {
  const real = safeReal(p);
  const home = os.homedir();
  if (under(real, path.join(home, "Library", "Mobile Documents"))) return "iCloud Drive";
  if (under(real, path.join(home, "Library", "CloudStorage"))) {
    const rel = path.relative(path.join(home, "Library", "CloudStorage"), real);
    return rel.split(path.sep)[0] || "a cloud provider";
  }
  // Classic (non-FileProvider) roots by name — real Dropbox roots are often
  // "Dropbox (Personal)"/"Dropbox (Team)". Normalize separators so win32
  // paths match too.
  const posix = real.split(path.sep).join("/");
  const marker = posix.match(/(^|\/)(Dropbox( \([^/]+\))?|OneDrive[^/]*|Google Drive)(\/|$)/i);
  if (marker) return marker[2];
  if (process.platform === "darwin") {
    for (const root of [path.join(home, "Desktop"), path.join(home, "Documents")]) {
      if (!under(real, root)) continue;
      try {
        execFileSync("xattr", ["-p", "com.apple.file-provider-domain-id", root], {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        });
        return "iCloud (Desktop & Documents sync)";
      } catch {
        /* xattr absent -> that folder isn't iCloud-managed */
      }
    }
  }
  return null;
}

/** iCloud skips any dir whose name ends in .nosync — contents are exempt even inside the domain. */
function nosyncExempt(p: string): boolean {
  return safeReal(p)
    .split(path.sep)
    .some((seg) => seg.endsWith(".nosync"));
}

function datalessFiles(dir: string): string[] {
  if (process.platform !== "darwin") return [];
  try {
    const out = execFileSync("/usr/bin/find", [dir, "-flags", "+dataless"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** "X 2.csv" beside an existing "X.csv" — the rename a sync engine leaves next
 *  to a conflicted file. Requiring the ORIGINAL to exist keeps legitimate
 *  names like "trip 2025.md" or a "meetings 3" dir out of the findings. */
const CONFLICT_TWIN = /^(.*\S)\s\d+$/;

function conflictTwins(dir: string): string[] {
  const hits: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6 || hits.length >= 20) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const full = path.join(d, e.name);
      const dot = e.isFile() ? e.name.lastIndexOf(".") : -1;
      const ext = dot > 0 ? e.name.slice(dot) : "";
      const base = dot > 0 ? e.name.slice(0, dot) : e.name;
      const m = base.match(CONFLICT_TWIN);
      if (m && names.has(m[1] + ext)) hits.push(full);
      if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(dir, 0);
  return hits;
}

/** Initialized stores visible from here that are NOT the active one. */
function shadowStores(active: string): string[] {
  const activeReal = safeReal(active);
  return storeCandidates().filter((c) => storeRank(c) > 0 && safeReal(c) !== activeReal);
}

export function doctorReport(dir: string = dataDir()): DoctorReport {
  const checks: StoreCheck[] = [];
  const safeDir = defaultStoreDir();
  const atDefault = safeReal(dir) === safeReal(safeDir);

  const domain = syncDomainOf(dir);
  if (!domain) {
    checks.push({ id: "location", severity: "ok", title: "Store location", detail: `Outside every sync engine's domain (${dir}).` });
  } else if (nosyncExempt(dir)) {
    checks.push({
      id: "location",
      severity: "warn",
      title: "Store location",
      detail: `Inside ${domain} but exempt via .nosync — the store itself is skipped, yet the surrounding folder still gets conflict renames and resurrected ghosts. Migrate to ${safeDir}.`,
    });
  } else {
    checks.push({
      id: "location",
      severity: "bad",
      title: "Store location",
      detail: `Inside ${domain}. Sync engines evict contents, rename files to "X 2" and resurrect deleted dirs — move the store: agentqs migrate-store.`,
    });
  }

  const dataless = datalessFiles(dir);
  checks.push(
    dataless.length
      ? {
          id: "eviction",
          severity: "bad",
          title: "Evicted files",
          detail: `${dataless.length} file(s) are cloud-evicted placeholders (reads hang): ${dataless.slice(0, 3).join(", ")}${dataless.length > 3 ? ", …" : ""}. Materialize: brctl download '${dir}'.`,
        }
      : {
          id: "eviction",
          severity: "ok",
          title: "Evicted files",
          detail:
            process.platform === "darwin"
              ? "All file contents are on disk."
              : "No eviction probe on this platform — checked on macOS only.",
        },
  );

  const twins = conflictTwins(dir);
  checks.push(
    twins.length
      ? {
          id: "conflicts",
          severity: "warn",
          title: "Conflict twins",
          detail: `${twins.length} sync-conflict cop${twins.length === 1 ? "y" : "ies"} ("X 2"): ${twins.slice(0, 3).join(", ")}${twins.length > 3 ? ", …" : ""}. Diff against the original before deleting.`,
        }
      : { id: "conflicts", severity: "ok", title: "Conflict twins", detail: "No 'X 2' sync-conflict copies." },
  );

  const shadows = shadowStores(dir);
  checks.push(
    shadows.length
      ? {
          id: "split",
          severity: "warn",
          title: "Split store",
          detail: `Other initialized store(s) visible: ${shadows.join(", ")}. Active is ${dir}; retire the others (rename or delete) so nothing can shadow it.`,
        }
      : { id: "split", severity: "ok", title: "Split store", detail: "Exactly one store visible." },
  );

  return { dataDir: dir, safeDir, atDefault, safe: checks.every((c) => c.severity !== "bad"), checks };
}

/** doctorReport shells out (xattr, find) and walks the store — too heavy for
 *  publicConfig's callers (chat + inbox fetch /api/settings on every mount).
 *  The location can't change while the process runs, so cache per dir with a
 *  short TTL; migrateStore busts the cache. */
let summaryCache: { dir: string; at: number; value: StoreSummary } | null = null;
const SUMMARY_TTL_MS = 60_000;

export function storeSummary(dir: string = dataDir()): StoreSummary {
  if (summaryCache && summaryCache.dir === dir && Date.now() - summaryCache.at < SUMMARY_TTL_MS) {
    return summaryCache.value;
  }
  const r = doctorReport(dir);
  const value: StoreSummary = {
    safe: r.safe,
    atDefault: r.atDefault,
    envPinned: Boolean(process.env.AGENTQS_DATA_DIR),
    safeDir: r.safeDir,
    issues: r.checks.filter((c) => c.severity !== "ok").map((c) => c.detail),
  };
  summaryCache = { dir, at: Date.now(), value };
  return value;
}

// ---- migration -------------------------------------------------------------

export interface MigrateResult {
  from: string;
  to: string;
  files: number;
  bytes: number;
  verified: boolean;
  retiredTo: string | null;
  schedulers: string[];
  dryRun: boolean;
  next: string[];
}

interface Manifest {
  files: Map<string, string>;
  bytes: number;
}

function manifestOf(root: string): Manifest {
  const files = new Map<string, string>();
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const f = sha256File(full);
        bytes += f.bytes;
        files.set(path.relative(root, full), f.hash);
      }
    }
  };
  walk(root);
  return { files, bytes };
}

/** Chunked hashing: readFileSync would buffer whole files (RSS spikes by the
 *  largest file, hard ERR_FS_FILE_TOO_LARGE at 2 GiB — agentqs.db grows
 *  monotonically toward it). 1 MiB chunks keep memory flat with no size cap. */
function sha256File(full: string): { hash: string; bytes: number } {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(full, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let bytes = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, -1);
      if (n <= 0) break;
      h.update(n === buf.length ? buf : buf.subarray(0, n));
      bytes += n;
    }
    return { hash: h.digest("hex"), bytes };
  } finally {
    fs.closeSync(fd);
  }
}

export interface MigrateOptions {
  to?: string;
  dryRun?: boolean;
  /** Test hooks — default to the real launchd plist / user crontab. */
  plistPath?: string;
  reloadLaunchd?: boolean;
  skipCrontab?: boolean;
}

/**
 * Move the whole store (record incl. its own .git, config, caches, models) to
 * a sync-safe location. Verifies every copied file by hash before retiring the
 * source (renamed, never deleted), then re-points the agentqs schedulers.
 * Run with the app stopped; restart it afterwards.
 */
export function migrateStore(opts: MigrateOptions = {}): MigrateResult {
  const from = dataDir();
  const to = path.resolve(opts.to ?? defaultStoreDir());
  if (storeRank(from) === 0) throw new Error(`No store at ${from} — nothing to migrate.`);
  if (safeReal(from) === safeReal(to)) throw new Error(`Store already lives at ${to}.`);
  if (storeRank(to) > 0) throw new Error(`${to} already holds a store — refusing to overwrite. Pass --to <empty dir>.`);
  if (under(to, from) || under(from, to)) throw new Error("Source and target stores must not nest.");
  // An env-pinned store (Docker's ENV AGENTQS_DATA_DIR=/data, launchd, shell
  // profile) would be STRANDED: after the rename the env var still resolves to
  // the retired path and the app reopens an empty store there.
  if (process.env.AGENTQS_DATA_DIR && safeReal(path.resolve(process.env.AGENTQS_DATA_DIR)) === safeReal(from)) {
    throw new Error(
      `AGENTQS_DATA_DIR pins the store to ${from} — migrating would strand it (the app keeps resolving the env path). ` +
        `Point AGENTQS_DATA_DIR at the new location and move the data yourself, or unset it and re-run.`,
    );
  }
  // A live background sync holds pre-rename record paths and a heartbeat that
  // recreates the retired dir — refuse until the queue is idle. readSyncJobs
  // already flips stale (dead-process) jobs, so a crashed job can't block.
  const activeJobs = Object.values(readSyncJobs(from)).filter((j) => j.status === "queued" || j.status === "running");
  if (activeJobs.length) {
    throw new Error(
      `A sync is running (${activeJobs.map((j) => j.id).join(", ")}) — wait for it to finish (or stop the app), then re-run.`,
    );
  }

  const dataless = datalessFiles(from);
  if (dataless.length) {
    throw new Error(
      `${dataless.length} file(s) in ${from} are cloud-evicted and would hang the copy. ` +
        `Materialize first: brctl download '${from}' (verify with: find '${from}' -flags +dataless)`,
    );
  }

  const src = manifestOf(from);
  const result: MigrateResult = {
    from,
    to,
    files: src.files.size,
    bytes: src.bytes,
    verified: false,
    retiredTo: null,
    schedulers: [],
    dryRun: Boolean(opts.dryRun),
    next: [],
  };
  if (opts.dryRun) {
    result.next.push(`Would copy ${src.files.size} files (${Math.round(src.bytes / 1e6)} MB) to ${to}, verify, retire ${from}.`);
    return result;
  }

  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });

  const dst = manifestOf(to);
  const missing = [...src.files].filter(([rel, hash]) => dst.files.get(rel) !== hash);
  if (missing.length) {
    fs.rmSync(to, { recursive: true, force: true });
    throw new Error(
      `Copy verification failed for ${missing.length} file(s) (first: ${missing[0]?.[0]}) — target removed, source untouched. ` +
        `Stop anything writing to the store and re-run.`,
    );
  }
  result.verified = true;

  // Capture every spelling of the source path BEFORE the rename — schedulers
  // may carry any of them: the as-resolved path, its realpath, and the macOS
  // /var <-> /private/var pair.
  const fromAliases = Array.from(
    new Set(
      [from, safeReal(from)].flatMap((p) =>
        p.startsWith("/private/") ? [p, p.slice("/private".length)] : [p, `/private${p}`],
      ),
    ),
  );

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  // Keep a .nosync suffix on the retired copy: if the source sat in an iCloud
  // domain exempt via .nosync, dropping the suffix would start UPLOADING the
  // retired store (record + secrets) the moment it is renamed.
  const retired = `${from}.migrated-${stamp}.nosync`;
  fs.renameSync(from, retired);
  result.retiredTo = retired;

  result.schedulers = repointSchedulers(fromAliases, to, opts);
  // dataDir() only auto-finds the app-data default and checkout-local stores —
  // a custom target is unreachable without the env var.
  const autoFound =
    safeReal(to) === safeReal(defaultStoreDir()) ||
    [path.join(process.cwd(), "data.nosync"), path.join(process.cwd(), "data")].some((c) => safeReal(c) === safeReal(to));
  if (!autoFound) {
    result.next.push(
      `Custom location: set AGENTQS_DATA_DIR=${to} everywhere the app runs (shell profile, launchd, Docker env) — resolution only auto-finds ${defaultStoreDir()} and checkout-local stores.`,
    );
  }
  result.next.push("Restart the app / dev server so it opens the new store.");
  result.next.push(`Revert: mv '${retired}' '${from}' && rm -rf '${to}' (then restore scheduler paths).`);
  summaryCache = null;
  return result;
}

function replacePaths(text: string, fromAliases: string[], to: string): string {
  let out = text;
  for (const alias of fromAliases) out = out.split(alias).join(to);
  return out;
}

/** Rewrite the agentqs launchd job and crontab lines that reference the old store. */
function repointSchedulers(fromAliases: string[], to: string, opts: MigrateOptions): string[] {
  const done: string[] = [];
  const plist = opts.plistPath ?? path.join(os.homedir(), "Library", "LaunchAgents", "com.agentqs.autosync.plist");
  try {
    if (fs.existsSync(plist)) {
      const text = fs.readFileSync(plist, "utf8");
      if (replacePaths(text, fromAliases, to) !== text) {
        fs.writeFileSync(plist, replacePaths(text, fromAliases, to), "utf8");
        done.push(`launchd: ${plist} now points at ${to}`);
        if (opts.reloadLaunchd !== false) {
          try {
            execFileSync("launchctl", ["unload", plist], { stdio: "ignore", timeout: 10_000 });
            execFileSync("launchctl", ["load", plist], { stdio: "ignore", timeout: 10_000 });
            done.push("launchd: agent reloaded");
          } catch {
            done.push("launchd: reload it manually (launchctl unload/load)");
          }
        }
      }
    }
  } catch {
    done.push(`launchd: could not update ${plist} — edit it manually`);
  }
  if (!opts.skipCrontab && process.platform !== "win32") {
    try {
      const cron = execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (/agentqs/.test(cron) && replacePaths(cron, fromAliases, to) !== cron) {
        execFileSync("crontab", ["-"], { input: replacePaths(cron, fromAliases, to), timeout: 10_000 });
        done.push(`crontab: agentqs lines now point at ${to}`);
      }
    } catch {
      /* no crontab — nothing to re-point */
    }
  }
  return done;
}

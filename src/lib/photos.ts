import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  dataDir,
  recordDir as recordDirFor,
  photoThumbDir as photoThumbDirFor,
  photoVecPath as photoVecPathFor,
} from "./paths";
import { mergeDailyCsv } from "./record";
import { vectorToBlob, blobToVector, cosine } from "./embed";
import { getImageEmbedder } from "./photo-embedder";
import { getCaptioner, captionToTags } from "./caption";

const execFileP = promisify(execFile);

/**
 * Photos (Batch C · Photos). Bring a folder or the Mac photo library into the record
 * — all LOCAL, no key, no cloud. Per image:
 *   - exifr  → date / GPS / camera  → git-record JSONL {id,date,ref,exif}
 *   - sharp  → a small thumbnail in /data (originals + thumbnails NEVER committed)
 *   - CLIP   → a 512-d vector in sqlite-vec (never committed) for text→image recall
 *   - (opt.) a local caption model → scene tags → back into the record
 * EXIF also rolls up into daily features (photo_count, has_location, scene tags) so
 * the mentor can correlate photos vs mood/sleep. Server-only (fs + native deps).
 */

// ---- Record shape ---------------------------------------------------------

export interface PhotoExif {
  ts?: string; // full ISO timestamp the photo was taken
  gps?: { lat: number; lng: number };
  camera?: string; // "Apple iPhone 15 Pro"
}

export interface PhotoRecord {
  id: string; // content hash — stable across path/renames, dedupes re-imports
  date: string; // YYYY-MM-DD the photo was taken (EXIF, else file mtime)
  ref: string; // absolute original path — a POINTER; the bytes never leave the machine
  exif: PhotoExif;
  thumb?: string; // thumbnail path relative to the data dir
  caption?: string; // optional local caption
  tags?: string[]; // scene tags derived from the caption
}

const IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".tif", ".tiff", ".bmp",
]);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---- Record read / write --------------------------------------------------

function photosFile(recordDir: string): string {
  return path.join(recordDir, "photos.jsonl");
}

export function readPhotos(recordDir: string = recordDirFor()): PhotoRecord[] {
  const file = photosFile(recordDir);
  if (!fs.existsSync(file)) return [];
  const out: PhotoRecord[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as PhotoRecord);
    } catch {
      /* skip a malformed line */
    }
  }
  return out;
}

/** Serialise a photo record with stable key order so the JSONL diffs cleanly. */
function serializePhoto(p: PhotoRecord): string {
  const o: Record<string, unknown> = { id: p.id, date: p.date, ref: p.ref, exif: p.exif };
  if (p.thumb) o.thumb = p.thumb;
  if (p.caption) o.caption = p.caption;
  if (p.tags && p.tags.length) o.tags = p.tags;
  return JSON.stringify(o);
}

function writePhotos(recordDir: string, photos: PhotoRecord[]): void {
  fs.mkdirSync(recordDir, { recursive: true });
  const sorted = [...photos].sort((a, b) => cmp(a.date, b.date) || cmp(a.id, b.id));
  fs.writeFileSync(photosFile(recordDir), sorted.map(serializePhoto).join("\n") + "\n", "utf8");
}

// ---- Scanning + EXIF + thumbnails -----------------------------------------

/** Walk a folder for image files (recursively), skipping hidden dirs. */
function walkImages(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  }
  return out.sort(cmp);
}

/** Content id: sha1 of file size + the first 64 KB. Stable across moves/renames and
 *  cheap on huge libraries (no full-file read). */
function photoId(filePath: string, size: number): string {
  const h = crypto.createHash("sha1");
  h.update(String(size));
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(Math.min(65536, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    h.update(buf);
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex").slice(0, 16);
}

/** Pull the useful EXIF: capture timestamp, GPS, camera. Best-effort — a photo with
 *  no EXIF still imports (date falls back to file mtime). */
async function readExif(filePath: string, mtime: Date): Promise<{ date: string; exif: PhotoExif }> {
  const exif: PhotoExif = {};
  let taken: Date | null = null;
  try {
    const exifr = (await import("exifr")).default;
    // No `pick`: exifr only derives the GPS latitude/longitude virtuals when it parses
    // the whole EXIF block. We still read just a few fields off the result.
    const d = await exifr.parse(filePath, { gps: true });
    if (d) {
      const dt = d.DateTimeOriginal || d.CreateDate;
      if (dt instanceof Date && !Number.isNaN(dt.getTime())) taken = dt;
      if (typeof d.latitude === "number" && typeof d.longitude === "number") {
        exif.gps = { lat: round6(d.latitude), lng: round6(d.longitude) };
      }
      const camera = [d.Make, d.Model].filter(Boolean).join(" ").trim();
      if (camera) exif.camera = camera;
    }
  } catch {
    /* no/broken EXIF — fall through to mtime */
  }
  const when = taken ?? mtime;
  exif.ts = when.toISOString();
  return { date: exif.ts.slice(0, 10), exif };
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Make a 256px webp thumbnail under data/photos/thumbs/<id>.webp. Returns the path
 *  relative to the data dir, or null if the image can't be decoded (e.g. HEIC on a
 *  sharp build without libheif) — EXIF still gets recorded. */
async function makeThumb(filePath: string, id: string): Promise<string | null> {
  try {
    const sharp = (await import("sharp")).default;
    const dir = photoThumbDirFor();
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, `${id}.webp`);
    await sharp(filePath, { failOn: "none" })
      .rotate()
      .resize(256, 256, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(abs);
    return path.relative(dataDir(), abs);
  } catch {
    return null;
  }
}

// ---- The photo semantic index (CLIP + sqlite-vec) -------------------------

interface PhotoVecDb {
  db: Database.Database;
  vec: boolean;
}

const PHOTO_DDL = `
CREATE TABLE IF NOT EXISTS photos (
  rowid    INTEGER PRIMARY KEY,
  photo_id TEXT NOT NULL UNIQUE,
  date     TEXT NOT NULL,
  thumb    TEXT,
  caption  TEXT,
  tags     TEXT,
  gps      TEXT,
  vector   BLOB
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function openPhotoVec(file: string, create: boolean): PhotoVecDb {
  const db = new Database(file, create ? {} : { readonly: true, fileMustExist: true });
  let vec = false;
  try {
    sqliteVec.load(db);
    db.prepare("SELECT vec_version()").get();
    vec = true;
  } catch {
    vec = false;
  }
  return { db, vec };
}

// ---- Import ---------------------------------------------------------------

export interface ImportOptions {
  folder?: string; // a folder of images (Google Takeout export, screenshots, …)
  library?: boolean; // scan the macOS Photos library originals
  since?: string; // only files modified on/after this ISO date
  caption?: boolean; // run the local caption model → scene tags
  push?: boolean; // git commit + push the record after import
  recordDir?: string;
  onProgress?: (done: number, total: number) => void;
}

export interface ImportResult {
  scanned: number;
  imported: number;
  skipped: number; // already in the record
  thumbnails: number;
  embedded: number;
  captioned: number;
  withGps: number;
  total: number; // photos in the record after import
  embedBackend: "clip" | null;
  pushed: boolean;
  sources: string[];
}

/** The default macOS Photos library originals directory. */
export function macPhotoLibraryDir(): string | null {
  const guesses = [
    path.join(os.homedir(), "Pictures", "Photos Library.photoslibrary", "originals"),
    path.join(os.homedir(), "Pictures", "Photos Library.photoslibrary", "Masters"),
  ];
  return guesses.find((g) => fs.existsSync(g)) ?? null;
}

function resolveSources(opts: ImportOptions): string[] {
  const dirs: string[] = [];
  if (opts.library) {
    const lib = macPhotoLibraryDir();
    if (lib) dirs.push(lib);
  }
  if (opts.folder) dirs.push(path.resolve(opts.folder));
  return dirs.filter((d) => fs.existsSync(d));
}

export async function importPhotos(opts: ImportOptions): Promise<ImportResult> {
  const recordDir = opts.recordDir ?? recordDirFor();
  const sources = resolveSources(opts);
  const sinceMs = opts.since ? Date.parse(opts.since) : null;

  const existing = readPhotos(recordDir);
  const byId = new Map(existing.map((p) => [p.id, p]));

  // Gather candidate files across all sources.
  const files: string[] = [];
  for (const dir of sources) files.push(...walkImages(dir));

  const embedder = await getImageEmbedder();
  const captioner = opts.caption ? await getCaptioner() : null;

  const vecFile = photoVecPathFor();
  fs.mkdirSync(path.dirname(vecFile), { recursive: true });
  const { db, vec } = openPhotoVec(vecFile, true);
  db.exec(PHOTO_DDL);
  if (vec) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_photos USING vec0(embedding float[${embedder?.dim ?? 512}])`);
    } catch {
      /* table exists with a different dim — leave it */
    }
  }
  const upsert = db.prepare(
    `INSERT INTO photos (photo_id, date, thumb, caption, tags, gps, vector)
       VALUES (@photo_id, @date, @thumb, @caption, @tags, @gps, @vector)
     ON CONFLICT(photo_id) DO UPDATE SET
       date=excluded.date, thumb=excluded.thumb, caption=excluded.caption,
       tags=excluded.tags, gps=excluded.gps,
       vector=COALESCE(excluded.vector, photos.vector)`,
  );
  const getRow = db.prepare("SELECT rowid, vector FROM photos WHERE photo_id = ?");
  const insVec = vec ? db.prepare("INSERT OR REPLACE INTO vec_photos (rowid, embedding) VALUES (?,?)") : null;

  const res: ImportResult = {
    scanned: files.length,
    imported: 0,
    skipped: 0,
    thumbnails: 0,
    embedded: 0,
    captioned: 0,
    withGps: 0,
    total: 0,
    embedBackend: embedder ? "clip" : null,
    pushed: false,
    sources: sources.map((s) => s),
  };

  let done = 0;
  for (const file of files) {
    done++;
    opts.onProgress?.(done, files.length);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (sinceMs !== null && stat.mtimeMs < sinceMs) continue;

    const id = photoId(file, stat.size);
    const already = byId.get(id);
    // Skip re-work unless we're adding captions this pass and it has none yet.
    const wantCaption = !!captioner && !already?.caption;
    if (already && !wantCaption) {
      res.skipped++;
      continue;
    }

    let rec: PhotoRecord;
    if (already) {
      rec = { ...already };
    } else {
      const { date, exif } = await readExif(file, stat.mtime);
      rec = { id, date, ref: path.resolve(file), exif };
      const thumb = await makeThumb(file, id);
      if (thumb) {
        rec.thumb = thumb;
        res.thumbnails++;
      }
      res.imported++;
      byId.set(id, rec);
    }

    // Caption (optional) → scene tags.
    if (wantCaption && rec.thumb) {
      const thumbAbs = path.join(dataDir(), rec.thumb);
      const caption = await captioner!.caption(thumbAbs);
      if (caption) {
        rec.caption = caption;
        rec.tags = captionToTags(caption);
        res.captioned++;
        byId.set(id, rec);
      }
    }

    if (rec.exif.gps) res.withGps++;

    // CLIP embed (from the thumbnail so the index rebuilds without the originals).
    let vector: Buffer | null = null;
    const existingRow = getRow.get(id) as { rowid: number; vector: Buffer | null } | undefined;
    if (embedder && rec.thumb && !(existingRow?.vector)) {
      const v = await embedder.embedImage(path.join(dataDir(), rec.thumb));
      if (v) {
        vector = vectorToBlob(v);
        res.embedded++;
      }
    }

    upsert.run({
      photo_id: id,
      date: rec.date,
      thumb: rec.thumb ?? null,
      caption: rec.caption ?? null,
      tags: rec.tags?.length ? JSON.stringify(rec.tags) : null,
      gps: rec.exif.gps ? JSON.stringify(rec.exif.gps) : null,
      vector,
    });
    if (insVec && vector) {
      const row = getRow.get(id) as { rowid: number } | undefined;
      if (row) insVec.run(BigInt(row.rowid), vector);
    }
  }

  const setMeta = db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)");
  setMeta.run("model", embedder?.id ?? "none");
  setMeta.run("dim", String(embedder?.dim ?? 0));
  setMeta.run("backend", vec ? "sqlite-vec" : "js-cosine");
  db.close();

  // Persist the record + daily rollups.
  const all = [...byId.values()];
  writePhotos(recordDir, all);
  writeDailyFeatures(recordDir, all);
  res.total = all.length;

  if (opts.push) res.pushed = await gitPushRecord(recordDir);

  return res;
}

// ---- Daily features (correlate photos vs mood / sleep) --------------------

/** Roll photos up into daily columns: how many, whether any was geotagged, and (when
 *  captioned) how many carried each scene tag — so the mentor can line photos up
 *  against mood + sleep in the daily table. */
export function writeDailyFeatures(recordDir: string, photos: PhotoRecord[]): void {
  const byDate = new Map<string, { count: number; gps: number; scenes: Map<string, number> }>();
  for (const p of photos) {
    const day = byDate.get(p.date) ?? { count: 0, gps: 0, scenes: new Map() };
    day.count++;
    if (p.exif.gps) day.gps++;
    for (const t of p.tags ?? []) day.scenes.set(t, (day.scenes.get(t) ?? 0) + 1);
    byDate.set(p.date, day);
  }
  // Stable metric columns: core two first, then any scene tags seen, alphabetised.
  const scenes = new Set<string>();
  for (const d of byDate.values()) for (const s of d.scenes.keys()) scenes.add(s);
  const sceneCols = [...scenes].sort(cmp);
  const header = ["date", "photo_count", "photo_geotagged", ...sceneCols.map((s) => `scene_${s}`)];
  const rows = [...byDate.keys()].sort(cmp).map((date) => {
    const d = byDate.get(date)!;
    return [
      date,
      String(d.count),
      String(d.gps),
      ...sceneCols.map((s) => (d.scenes.get(s) ? String(d.scenes.get(s)) : "")),
    ];
  });
  if (rows.length) mergeDailyCsv(recordDir, "photos", { header, rows });
}

// ---- Status ---------------------------------------------------------------

export interface PhotosStatus {
  count: number;
  withGps: number;
  captioned: number;
  cameras: string[];
  firstDate: string | null;
  lastDate: string | null;
  indexed: number; // photos with a CLIP vector
  backend: string | null;
}

export function photosStatus(recordDir: string = recordDirFor()): PhotosStatus {
  const photos = readPhotos(recordDir);
  const dates = photos.map((p) => p.date).filter(Boolean).sort(cmp);
  const cameras = [...new Set(photos.map((p) => p.exif.camera).filter(Boolean) as string[])].sort(cmp);

  let indexed = 0;
  let backend: string | null = null;
  const vecFile = photoVecPathFor();
  if (fs.existsSync(vecFile)) {
    try {
      const db = new Database(vecFile, { readonly: true, fileMustExist: true });
      indexed = (db.prepare("SELECT COUNT(*) n FROM photos WHERE vector IS NOT NULL").get() as { n: number }).n;
      const m = db.prepare("SELECT value FROM meta WHERE key='backend'").get() as { value: string } | undefined;
      backend = m?.value ?? null;
      db.close();
    } catch {
      /* no index yet */
    }
  }

  return {
    count: photos.length,
    withGps: photos.filter((p) => p.exif.gps).length,
    captioned: photos.filter((p) => p.caption).length,
    cameras,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    indexed,
    backend,
  };
}

// ---- Text → image recall --------------------------------------------------

export interface ImageHit {
  id: string;
  date: string;
  thumb: string | null;
  caption: string | null;
  tags: string[];
  gps: { lat: number; lng: number } | null;
  score: number;
}

/** Recall photos by a natural-language description — "beach at sunset", "my dog",
 *  "whiteboard sketches". CLIP text embed → nearest photo vectors. No key, all local.
 *  Returns [] when nothing is indexed yet or the CLIP model isn't available. */
export async function findSimilarImages(query: string, limit = 8): Promise<ImageHit[]> {
  const q = query.trim();
  if (!q) return [];
  const vecFile = photoVecPathFor();
  if (!fs.existsSync(vecFile)) return [];
  const embedder = await getImageEmbedder();
  if (!embedder) return [];
  const qvec = await embedder.embedText(q);
  if (!qvec) return [];

  const k = Math.max(1, Math.min(limit, 50));
  const { db, vec } = openPhotoVec(vecFile, false);
  try {
    let rows: (RawPhotoRow & { score: number })[] = [];
    if (vec) {
      rows = (
        db
          .prepare(
            `WITH knn AS (
               SELECT rowid, distance FROM vec_photos WHERE embedding MATCH ? AND k = ?
             )
             SELECT p.photo_id, p.date, p.thumb, p.caption, p.tags, p.gps, knn.distance
             FROM knn JOIN photos p ON p.rowid = knn.rowid
             ORDER BY knn.distance`,
          )
          .all(vectorToBlob(qvec), k) as (RawPhotoRow & { distance: number })[]
      ).map((r) => ({ ...r, score: 1 - (r.distance * r.distance) / 2 }));
    } else {
      rows = (db.prepare("SELECT photo_id, date, thumb, caption, tags, gps, vector FROM photos WHERE vector IS NOT NULL").all() as (RawPhotoRow & { vector: Buffer })[])
        .map((r) => ({ ...r, score: cosine(qvec, blobToVector(r.vector)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    }
    return rows.map(rowToHit);
  } finally {
    db.close();
  }
}

interface RawPhotoRow {
  photo_id: string;
  date: string;
  thumb: string | null;
  caption: string | null;
  tags: string | null;
  gps: string | null;
}

function rowToHit(r: RawPhotoRow & { score: number }): ImageHit {
  return {
    id: r.photo_id,
    date: r.date,
    thumb: r.thumb,
    caption: r.caption,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
    gps: r.gps ? (JSON.parse(r.gps) as { lat: number; lng: number }) : null,
    score: Math.round(Math.max(0, r.score) * 1000) / 1000,
  };
}

// ---- Photo context for a date (mentor tool) -------------------------------

export interface PhotoContext {
  date: string;
  windowDays: number;
  count: number;
  geotagged: number;
  cameras: string[];
  captions: string[];
  tags: string[]; // scene tags seen, most-frequent first
  photos: { id: string; date: string; caption: string | null; thumb: string | null }[];
}

/** What the photos say about a stretch of time around a date — count, where (geotag),
 *  what (captions/scene tags). Feeds "what was going on around <date>?". */
export function photoContext(
  date: string,
  windowDays = 1,
  recordDir: string = recordDirFor(),
): PhotoContext {
  const center = Date.parse(date + "T00:00:00Z");
  const span = Math.max(0, windowDays) * 86400000;
  const inWindow = readPhotos(recordDir).filter((p) => {
    const t = Date.parse(p.date + "T00:00:00Z");
    return !Number.isNaN(t) && Math.abs(t - center) <= span;
  });
  const tagCount = new Map<string, number>();
  for (const p of inWindow) for (const t of p.tags ?? []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  return {
    date,
    windowDays,
    count: inWindow.length,
    geotagged: inWindow.filter((p) => p.exif.gps).length,
    cameras: [...new Set(inWindow.map((p) => p.exif.camera).filter(Boolean) as string[])].sort(cmp),
    captions: inWindow.map((p) => p.caption).filter(Boolean) as string[],
    tags: [...tagCount.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([t]) => t),
    photos: inWindow
      .sort((a, b) => cmp(a.date, b.date) || cmp(a.id, b.id))
      .map((p) => ({ id: p.id, date: p.date, caption: p.caption ?? null, thumb: p.thumb ?? null })),
  };
}

// ---- Git push (best-effort) -----------------------------------------------

async function gitPushRecord(recordDir: string): Promise<boolean> {
  try {
    const cwd = recordDir;
    await execFileP("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
    await execFileP("git", ["-C", cwd, "add", "-A"]);
    await execFileP("git", ["-C", cwd, "commit", "-m", "photos: import"]);
    await execFileP("git", ["-C", cwd, "push"]);
    return true;
  } catch {
    return false;
  }
}

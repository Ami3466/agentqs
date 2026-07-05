import fs from "fs";
import os from "os";
import path from "path";
import type { DailyTable } from "../plugin";
import type { FileImporter, FileImportContext, FileImportResult } from "../file-plugin";

/**
 * Location via OwnTracks — a Tier-3 file importer. OwnTracks (open-source, self-
 * hosted) logs your location to its Recorder as `.rec` files (one JSON message per
 * line) or exports it as JSON. Each `location` message carries `lat`, `lon`, and
 * `tst` (Unix seconds). This reads those points and rolls up per day:
 *
 *   date, points, km (great-circle distance travelled)
 *
 * Accepts a `.rec` line file, a JSONL file, a JSON array, or an export object
 * whose array values hold the messages. Deterministic given the same file.
 */

interface Loc {
  lat: number;
  lon: number;
  tst: number; // Unix seconds
}

function asLoc(o: unknown): Loc | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r._type !== "location") return null;
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  const tst = Number(r.tst);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(tst)) return null;
  return { lat, lon, tst };
}

/** Extract every location message from raw file text (.rec lines · JSONL · JSON). */
export function collectLocations(text: string): Loc[] {
  const out: Loc[] = [];
  const push = (o: unknown) => {
    const l = asLoc(o);
    if (l) out.push(l);
  };
  const whole = text.trim();
  try {
    const parsed = JSON.parse(whole);
    if (Array.isArray(parsed)) parsed.forEach(push);
    else if (parsed && typeof parsed === "object") {
      for (const v of Object.values(parsed as Record<string, unknown>)) {
        if (Array.isArray(v)) v.forEach(push);
        else push(v);
      }
    }
    if (out.length) return out;
  } catch {
    /* not a single JSON doc — fall through to line parsing */
  }
  for (const line of whole.split(/\r?\n/)) {
    const brace = line.indexOf("{");
    if (brace < 0) continue;
    try {
      push(JSON.parse(line.slice(brace)));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Great-circle distance between two points, in kilometres. */
export function haversineKm(a: Loc, b: Loc): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Roll location points up into the wide per-day table (points + km travelled). */
export function normalizeLocations(locs: Loc[], from: string, to: string): DailyTable {
  const header = ["date", "points", "km"];
  const byDay = new Map<string, Loc[]>();
  for (const l of locs) {
    const day = new Date(l.tst * 1000).toISOString().slice(0, 10);
    if (day < from || day > to) continue;
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(l);
  }
  const rows = [...byDay.keys()].sort().map((day) => {
    const pts = byDay.get(day)!.sort((a, b) => a.tst - b.tst);
    let km = 0;
    for (let i = 1; i < pts.length; i++) km += haversineKm(pts[i - 1], pts[i]);
    return [day, String(pts.length), String(Math.round(km * 100) / 100)];
  });
  return { header, rows };
}

export async function readOwntracks(
  file: string,
  from: string,
  to: string,
): Promise<FileImportResult> {
  if (!fs.existsSync(file)) throw new Error(`OwnTracks export not found at ${file}`);
  const locs = collectLocations(fs.readFileSync(file, "utf8"));
  if (!locs.length) {
    throw new Error(`no OwnTracks location messages in ${file} (expected _type:location with lat/lon/tst)`);
  }
  const table = normalizeLocations(locs, from, to);
  return { table, meta: { pointsScanned: locs.length, daysWithData: table.rows.length } };
}

function owntracksDefaultPaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, "owntracks.rec"),
    path.join(home, "Downloads/owntracks.rec"),
    path.join(home, "Downloads/owntracks.json"),
    "/host/owntracks/last.rec", // Docker: mount your Recorder store at /host/owntracks:ro
  ];
}

export const owntracksImporter: FileImporter = {
  id: "owntracks",
  name: "Location (OwnTracks)",
  detail: "location points & distance travelled per day",
  connectHint:
    "OwnTracks Recorder export (.rec / JSON). Or run OwnTracks → Export, then point --path at the file.",
  live: true,
  primaryMetric: "points",
  unit: "points",
  defaultPaths: owntracksDefaultPaths,
  read(ctx: FileImportContext): Promise<FileImportResult> {
    return readOwntracks(ctx.path, ctx.from, ctx.to);
  },
};

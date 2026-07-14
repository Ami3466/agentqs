import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { num, type DailyTable } from "../plugin";
import type { FileImporter, FileImportContext, FileImportResult } from "../file-plugin";

/**
 * Spotify's own account export — the ONLY place your listening history exists.
 *
 * The live API cannot give you one. `recently-played` serves the last 50 plays and
 * accepts no date range, so a sync covers a few DAYS at most — that is Spotify's
 * ceiling, not a broken importer, and no window we ask for will move it. Asking for
 * a lifetime from that endpoint is asking a question it has no answer to.
 *
 * The export does have the answer, going back to the day you joined. Ask Spotify for
 * it (Privacy Settings → "Extended streaming history" — they email a zip within a few
 * days; the smaller "Account data" export works too, it just reaches back one year),
 * then drop the zip in.
 *
 * It lands in `spotify` — the SAME daily source the API sync writes, with the same
 * `tracks` / `minutes` columns. That is the whole point: the export is the history and
 * the API keeps the last few days fresh, so ONE Spotify row shows a lifetime instead
 * of the three days the endpoint happens to remember. (Same shape as Apple Health
 * backfilling `health_daily` under the live sources.)
 *
 * Two file shapes, both accepted:
 *   extended  Streaming_History_Audio_2015-2017_0.json
 *             { ts, ms_played, master_metadata_track_name, spotify_track_uri, … }
 *   account   StreamingHistory0.json / StreamingHistory_music_0.json
 *             { endTime, artistName, trackName, msPlayed }
 */

/** Extended export ("Streaming_History_Audio_*.json"). */
interface ExtendedPlay {
  ts?: string; // ISO, UTC — when the play ENDED
  ms_played?: number;
  master_metadata_track_name?: string | null;
  spotify_track_uri?: string | null;
  spotify_episode_uri?: string | null;
}
/** Account-data export ("StreamingHistory0.json"). */
interface AccountPlay {
  endTime?: string; // "YYYY-MM-DD HH:MM", local
  trackName?: string | null;
  msPlayed?: number;
}
export type SpotifyPlay = ExtendedPlay & AccountPlay;

/** Both exports name the file the same way, whichever era it came from. Video
 *  history is a different animal (episodes, not tracks) and is left alone. */
export function isStreamingHistoryFile(name: string): boolean {
  const base = path.basename(name);
  if (/video/i.test(base)) return false;
  return /^streaming[_ ]?history.*\.json$/i.test(base);
}

/**
 * Pure: raw plays → the daily table, in the API sync's own columns.
 *
 * A play counts when it is a MUSIC TRACK that actually played (`ms_played > 0`).
 * Podcast episodes ride in the same file but the API's `tracks` column has never
 * counted them, and a column whose meaning changes with its source is worse than a
 * missing one. A 0ms play is a skip Spotify still logs — it is not listening.
 */
interface Rollup {
  tracks: Map<string, number>;
  ms: Map<string, number>;
}

/** Fold one file's worth of plays into the running per-day totals. */
function foldPlays(plays: SpotifyPlay[], from: string, to: string, into: Rollup): void {
  for (const p of plays) {
    // Extended writes `ts` (ISO, UTC); the account export writes `endTime`
    // ("YYYY-MM-DD HH:MM", local). Both start with the day, which is all we need.
    const day = (p.ts ?? p.endTime ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < from || day > to) continue;
    const played = p.ms_played ?? p.msPlayed ?? 0;
    if (!(played > 0)) continue;
    const isTrack = Boolean(p.spotify_track_uri ?? p.master_metadata_track_name ?? p.trackName);
    if (!isTrack || p.spotify_episode_uri) continue;
    into.tracks.set(day, (into.tracks.get(day) ?? 0) + 1);
    into.ms.set(day, (into.ms.get(day) ?? 0) + played);
  }
}

/** Milliseconds are summed for the whole export and rounded ONCE, at the end — a
 *  per-file round would drift on an export Spotify happens to split differently. */
function rollupTable(r: Rollup): DailyTable {
  const rows = [...r.tracks.keys()]
    .sort()
    .map((d) => [d, String(r.tracks.get(d) ?? 0), num((r.ms.get(d) ?? 0) / 60_000)]);
  return { header: ["date", "tracks", "minutes"], rows };
}

export function normalizeSpotifyExport(plays: SpotifyPlay[], from: string, to: string): DailyTable {
  const rollup: Rollup = { tracks: new Map(), ms: new Map() };
  foldPlays(plays, from, to, rollup);
  return rollupTable(rollup);
}

/** unzip's member argument is a GLOB — a member path holding `[ ] * ?` would
 *  extract nothing without escaping (the trap Apple Health documents too). */
function escGlob(s: string): string {
  return s.replace(/[[\]*?\\]/g, (c) => `\\${c}`);
}

function walkJson(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkJson(abs, out);
    else if (e.isFile() && isStreamingHistoryFile(e.name)) out.push(abs);
  }
}

/** Every play in the export, whether it arrives as a zip, a folder or one json.
 *  Files are parsed ONE AT A TIME so a lifetime export never sits in memory whole. */
function* readPlays(file: string): Generator<SpotifyPlay[]> {
  const stat = fs.statSync(file);
  if (stat.isDirectory()) {
    const found: string[] = [];
    walkJson(file, found);
    if (!found.length) {
      throw new Error(
        `no streaming-history JSON inside ${file} — point at the Spotify export zip, its folder, or a Streaming_History_*.json.`,
      );
    }
    for (const f of found.sort()) yield JSON.parse(fs.readFileSync(f, "utf8")) as SpotifyPlay[];
    return;
  }
  if (/\.zip$/i.test(file)) {
    const members = execFileSync("unzip", ["-Z1", file], { encoding: "utf8", maxBuffer: 1024 * 1024 * 50 })
      .split(/\r?\n/)
      .filter((m) => m && isStreamingHistoryFile(m));
    if (!members.length) {
      throw new Error(
        `${file} holds no streaming-history JSON — is this Spotify's export? (Privacy Settings → Extended streaming history)`,
      );
    }
    for (const member of members.sort()) {
      // execFileSync throws on a non-zero exit, so a corrupt zip fails loudly here
      // rather than landing a silently partial lifetime.
      const body = execFileSync("unzip", ["-p", file, escGlob(member)], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 512,
      });
      yield JSON.parse(body) as SpotifyPlay[];
    }
    return;
  }
  yield JSON.parse(fs.readFileSync(file, "utf8")) as SpotifyPlay[];
}

export async function readSpotifyExport(file: string, from: string, to: string): Promise<FileImportResult> {
  const rollup: Rollup = { tracks: new Map(), ms: new Map() };
  let plays = 0;
  let files = 0;
  for (const batch of readPlays(file)) {
    files++;
    plays += batch.length;
    foldPlays(batch, from, to, rollup);
  }
  const table = rollupTable(rollup);
  return { table, meta: { files, plays, days: table.rows.length } };
}

export const spotifyExportImporter: FileImporter = {
  // The SAME id as the API plugin, on purpose: the export backfills the very source
  // the sync keeps fresh, so `spotify` holds one continuous history instead of a
  // three-day window next to a stranger called `spotify_history`.
  id: "spotify",
  name: "Spotify export",
  detail: "account export (streaming history) · your listening history, all of it",
  live: true,
  primaryMetric: "tracks",
  unit: "tracks",
  // A one-shot lifetime export — never clipped to a trailing window. A file is finite
  // and already on your disk; throwing away the years inside it would be absurd.
  fullHistoryDefault: true,
  defaultPaths(): string[] {
    const home = os.homedir();
    return [
      path.join(home, "Downloads/my_spotify_data.zip"),
      path.join(home, "Downloads/Spotify Extended Streaming History"),
      path.join(home, "Downloads/my_spotify_data"),
      path.join(home, "Downloads/MyData"),
    ];
  },
  async read(ctx: FileImportContext): Promise<FileImportResult> {
    return readSpotifyExport(ctx.path, ctx.from, ctx.to);
  },
};

#!/usr/bin/env tsx
/**
 * Spotify "Download your data" export → the record.
 *
 * The Spotify API only serves the last 50 plays (that's the `spotify` Tier-1
 * plugin). The GDPR export is the only way to get the *year* of listening behind
 * it, so this is an archive import in the shape of the Takeout one: read the zip
 * (or an unpacked folder), fan it out into the four record streams, rebuild.
 *
 *   record/daily/spotify_history.csv        tracks · minutes · artists · podcasts · searches
 *   record/daily/spotify_history_texts.csv  a searchable digest of each day's listening
 *   record/events.jsonl                     one event per play and per search
 *   record/inbox.jsonl                      taste profile, Wrapped, playlists, library
 *
 * It writes `spotify_history`, not `spotify`, so a later API sync of the live
 * source can never overwrite a full day of history with its 50-play window.
 *
 * Usage:
 *   npm run import:spotify -- [--zip ~/Downloads/my_spotify_data.zip] [--dir <folder>] [--dry]
 */
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { readConfig, writeConfig } from "../src/lib/config";
import { wipeDemoOnImport } from "../src/lib/demo";
import { dbPath, recordDir } from "../src/lib/paths";
import {
  appendEvents,
  appendInboxItems,
  mergeDailyCsv,
  rebuild,
  type AppendEventInput,
  type AppendInboxInput,
} from "../src/lib/record";

const SOURCE = "spotify_history";
const TEXT_SOURCE = `${SOURCE}_texts`;

// ---- Export shapes --------------------------------------------------------

interface MusicPlay {
  endTime: string; // "2025-07-07 20:55" — UTC, minute resolution
  artistName: string;
  trackName: string;
  msPlayed: number;
}
interface PodcastPlay {
  endTime: string;
  podcastName: string;
  episodeName: string;
  msPlayed: number;
}
interface SearchQuery {
  searchTime: string; // ISO, "…Z[UTC]"
  searchQuery: string;
  platform?: string;
  searchInteractionURIs?: string[];
}
interface Playlist {
  name: string;
  lastModifiedDate?: string;
  items?: Array<{ track?: { trackName?: string; artistName?: string; albumName?: string } }>;
}

// ---- Reading the archive ---------------------------------------------------

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** A flat name → JSON reader over either an unpacked folder or the zip itself. */
interface Archive {
  label: string;
  names: string[];
  read(name: string): unknown;
}

function folderArchive(dir: string): Archive {
  const root = fs.existsSync(path.join(dir, "Spotify Account Data"))
    ? path.join(dir, "Spotify Account Data")
    : dir;
  const names = fs.readdirSync(root).filter((f) => f.endsWith(".json"));
  return {
    label: dir,
    names,
    read: (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")),
  };
}

function zipArchive(zip: string): Archive {
  const listing = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".json"));
  return {
    label: zip,
    names: listing.map((l) => path.basename(l)),
    read: (name) => {
      const member = listing.find((l) => path.basename(l) === name);
      if (!member) throw new Error(`missing ${name}`);
      const buf = execFileSync("unzip", ["-p", zip, member], { maxBuffer: 1 << 28 });
      return JSON.parse(buf.toString("utf8"));
    },
  };
}

function openArchive(argv: string[]): Archive {
  const zipArg = flag(argv, "--zip");
  const dirArg = flag(argv, "--dir");
  if (dirArg) return folderArchive(expandHome(dirArg));
  const zip = expandHome(zipArg ?? "~/Downloads/my_spotify_data.zip");
  if (!fs.existsSync(zip)) {
    throw new Error(`No Spotify export at ${zip} — pass --zip <file> or --dir <folder>.`);
  }
  return zipArchive(zip);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Every JSON member matching a prefix, in export order (…_0, …_1, …). */
function readAll<T>(archive: Archive, prefix: string): T[] {
  const out: T[] = [];
  for (const name of archive.names.filter((n) => n.startsWith(prefix)).sort()) {
    const parsed = archive.read(name);
    if (Array.isArray(parsed)) out.push(...(parsed as T[]));
  }
  return out;
}

function readOne<T>(archive: Archive, name: string): T | null {
  return archive.names.includes(name) ? (archive.read(name) as T) : null;
}

// ---- Normalizing ----------------------------------------------------------

/** "2025-07-07 20:55" → "2025-07-07T20:55:00.000Z". Spotify stamps these in UTC. */
export function playTimestamp(endTime: string): string {
  const m = endTime.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return new Date(endTime).toISOString();
  return `${m[1]}T${m[2]}:${m[3]}:00.000Z`;
}

/**
 * A play id that survives re-importing a newer export. The natural key
 * (time, artist, track) is *not* unique — Spotify records a skip and a replay of
 * the same track in the same minute as two rows — so msPlayed and an occurrence
 * counter join it. Export order is stable, which makes the counter stable.
 */
function playId(seen: Map<string, number>, parts: string[]): string {
  const key = parts.join("\0");
  const n = seen.get(key) ?? 0;
  seen.set(key, n + 1);
  return crypto.createHash("sha256").update(`${key}\0${n}`).digest("hex").slice(0, 24);
}

interface DayAgg {
  tracks: number;
  ms: number;
  artists: Set<string>;
  podcastEpisodes: number;
  podcastMs: number;
  searches: number;
  plays: Map<string, number>; // "Artist — Track" → play count, for the text digest
}

function emptyDay(): DayAgg {
  return { tracks: 0, ms: 0, artists: new Set(), podcastEpisodes: 0, podcastMs: 0, searches: 0, plays: new Map() };
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

/** The searchable prose for a day: what got played most, and who. */
export function dayDigest(agg: DayAgg): string {
  const top = [...agg.plays.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8)
    .map(([label, n]) => (n > 1 ? `${label} (×${n})` : label));
  const parts: string[] = [];
  if (agg.tracks) {
    parts.push(
      `Listened to ${agg.tracks} track${agg.tracks === 1 ? "" : "s"} (${minutes(agg.ms)} min) from ${agg.artists.size} artist${agg.artists.size === 1 ? "" : "s"}.`,
    );
  }
  if (agg.podcastEpisodes) {
    parts.push(`Played ${agg.podcastEpisodes} podcast episode${agg.podcastEpisodes === 1 ? "" : "s"} (${minutes(agg.podcastMs)} min).`);
  }
  if (top.length) parts.push(`Most played: ${top.join(" · ")}.`);
  return parts.join(" ");
}

// ---- Main -----------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const archive = openArchive(argv);

  const music = readAll<MusicPlay>(archive, "StreamingHistory_music_");
  const podcasts = readAll<PodcastPlay>(archive, "StreamingHistory_podcast_");
  const searches = readAll<SearchQuery>(archive, "SearchQueries");
  const playlists = readOne<{ playlists?: Playlist[] }>(archive, "Playlist1.json")?.playlists ?? [];
  const library = readOne<Record<string, unknown[]>>(archive, "YourLibrary.json");
  const taste = readOne<{ tasteProfile?: Record<string, string> }>(archive, "TasteProfile.json");
  const wrapped = readOne<Record<string, unknown>>(archive, "Wrapped2025.json");

  const byDate = new Map<string, DayAgg>();
  const day = (d: string) => {
    const existing = byDate.get(d);
    if (existing) return existing;
    const fresh = emptyDay();
    byDate.set(d, fresh);
    return fresh;
  };

  const events: AppendEventInput[] = [];
  const seen = new Map<string, number>();

  for (const p of music) {
    if (!p.endTime || !p.trackName) continue;
    const ts = playTimestamp(p.endTime);
    const date = ts.slice(0, 10);
    const agg = day(date);
    agg.tracks += 1;
    agg.ms += p.msPlayed ?? 0;
    agg.artists.add(p.artistName);
    const label = `${p.artistName} — ${p.trackName}`;
    agg.plays.set(label, (agg.plays.get(label) ?? 0) + 1);
    events.push({
      id: playId(seen, ["track", p.endTime, p.artistName, p.trackName, String(p.msPlayed ?? 0)]),
      date,
      ts,
      source: SOURCE,
      title: p.trackName,
      text: label,
      meta: { kind: "track", artist: p.artistName, track: p.trackName, ms_played: p.msPlayed ?? 0 },
    });
  }

  for (const p of podcasts) {
    if (!p.endTime || !p.episodeName) continue;
    const ts = playTimestamp(p.endTime);
    const date = ts.slice(0, 10);
    const agg = day(date);
    agg.podcastEpisodes += 1;
    agg.podcastMs += p.msPlayed ?? 0;
    events.push({
      id: playId(seen, ["podcast", p.endTime, p.podcastName, p.episodeName, String(p.msPlayed ?? 0)]),
      date,
      ts,
      source: SOURCE,
      title: p.episodeName,
      text: `${p.podcastName} — ${p.episodeName}`,
      meta: { kind: "podcast", podcast: p.podcastName, episode: p.episodeName, ms_played: p.msPlayed ?? 0 },
    });
  }

  for (const s of searches) {
    const query = (s.searchQuery ?? "").trim();
    if (!query || !s.searchTime) continue;
    const ts = new Date(s.searchTime.replace(/\[UTC\]$/, "")).toISOString();
    const date = ts.slice(0, 10);
    day(date).searches += 1;
    const uri = s.searchInteractionURIs?.[0];
    events.push({
      id: playId(seen, ["search", s.searchTime, query]),
      date,
      ts,
      source: SOURCE,
      title: `Searched “${query}”`,
      text: query,
      url: uri ? `https://open.spotify.com/${uri.replace("spotify:", "").replace(":", "/")}` : null,
      meta: { kind: "search", query, platform: s.platform || null },
    });
  }

  const dates = [...byDate.keys()].sort();
  const daily = {
    header: ["date", "tracks", "minutes", "artists", "podcast_episodes", "podcast_minutes", "searches"],
    rows: dates.map((d) => {
      const a = byDate.get(d)!;
      return [
        d,
        String(a.tracks),
        String(minutes(a.ms)),
        String(a.artists.size),
        String(a.podcastEpisodes),
        String(minutes(a.podcastMs)),
        String(a.searches),
      ];
    }),
  };

  const textRows = dates
    .map((d) => [d, dayDigest(byDate.get(d)!)] as const)
    .filter(([, text]) => text.length >= 20)
    .map(([d, text]) => [d, String(text.length), text]);
  const texts = { header: ["date", "chars", "text"], rows: textRows };

  // The one-off documents: not a time series, so they land in the inbox, where
  // long-form captures get embedded and full-text indexed. Their ids say what they
  // are, so re-importing a refreshed export re-appends none of them.
  // status "reference": searchable + recall-able, but never queued in the pending
  // inbox nor fed to the structuring LLM — these are finished documents, not memos.
  const captures: AppendInboxInput[] = [];
  const capture = (key: string, text: string, meta: Record<string, unknown>) =>
    captures.push({ id: `spotify:${key}`, text, source: "spotify", kind: "text", status: "reference", meta });

  for (const [field, value] of Object.entries(taste?.tasteProfile ?? {})) {
    if (typeof value === "string" && value.trim().length >= 40) {
      capture(`taste_profile:${field}`, `Spotify taste profile — ${field}\n\n${value.trim()}`, {
        kind: "taste_profile",
        field,
      });
    }
  }
  for (const pl of playlists) {
    const tracks = (pl.items ?? [])
      .map((i) => (i.track ? `${i.track.artistName} — ${i.track.trackName}` : ""))
      .filter(Boolean);
    if (!tracks.length) continue;
    capture(`playlist:${pl.name}`, `Spotify playlist “${pl.name}” (${tracks.length} tracks)\n\n${tracks.join("\n")}`, {
      kind: "playlist",
      name: pl.name,
      tracks: tracks.length,
      last_modified: pl.lastModifiedDate ?? null,
    });
  }
  const saved = (library?.tracks as Array<{ artist?: string; track?: string }> | undefined) ?? [];
  if (saved.length) {
    capture(
      "library:tracks",
      `Spotify saved tracks (${saved.length})\n\n${saved.map((t) => `${t.artist} — ${t.track}`).join("\n")}`,
      { kind: "library", tracks: saved.length },
    );
  }
  if (wrapped) capture("wrapped", `Spotify Wrapped\n\n${JSON.stringify(wrapped, null, 2)}`, { kind: "wrapped" });

  if (dry) {
    console.log(
      JSON.stringify(
        {
          archive: archive.label,
          plays: music.length,
          podcasts: podcasts.length,
          searches: searches.length,
          days: dates.length,
          from: dates[0] ?? null,
          to: dates.at(-1) ?? null,
          events: events.length,
          textDays: textRows.length,
          captures: captures.length,
          sampleDigest: textRows[0]?.[2] ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  wipeDemoOnImport(); // the first real import clears the generic demo record

  const rDir = recordDir();
  const dailyMerge = mergeDailyCsv(rDir, SOURCE, daily);
  const textMerge = mergeDailyCsv(rDir, TEXT_SOURCE, texts);
  const added = appendEvents(events, { recordDir: rDir }).added;
  const capturesAdded = appendInboxItems(captures, { recordDir: rDir }).added;

  const r = rebuild({ recordDir: rDir, dbPath: dbPath() });

  const cfg = readConfig();
  if (cfg) {
    const now = new Date().toISOString();
    cfg.sourceSyncedAt = { ...(cfg.sourceSyncedAt ?? {}), [SOURCE]: now, [TEXT_SOURCE]: now };
    writeConfig(cfg);
  }

  console.log(
    JSON.stringify(
      {
        archive: archive.label,
        from: dates[0] ?? null,
        to: dates.at(-1) ?? null,
        days: dailyMerge.dates.length,
        metrics: dailyMerge.metrics,
        textDays: textMerge.dates.length,
        eventsAdded: added,
        eventsSeen: events.length,
        capturesAdded,
        capturesSeen: captures.length,
        dailyRows: r.daily,
      },
      null,
      2,
    ),
  );
}

void main().catch((e) => {
  console.error(`spotify import failed: ${(e as Error).message}`);
  process.exit(1);
});

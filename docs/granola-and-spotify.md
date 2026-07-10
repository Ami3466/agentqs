# Granola & Spotify

Two personal sources added on top of the built-in integrations: **Granola**
(meetings, notes, transcripts — a live API source) and the **Spotify data export**
(a year of listening history — an archive import). Both land in the same daily
record every other source uses, so they show up in the Journal, the graphs, search
and recall with no special handling.

---

## Granola — meetings, notes & transcripts

Granola ships no public OAuth app, but the desktop client already holds a login on
your machine and Granola's own API accepts it. The plugin picks that up
automatically — there is nothing to paste — trades the desktop client's long-lived
refresh token for a short access token, and pulls your meetings.

Each meeting lands three ways, because each is read differently:

| Where | What | Read by |
| --- | --- | --- |
| `daily/granola.csv` | `meetings · notes · minutes · words` per day | graphs, the Pipeline-tab sparkline |
| `daily/granola_texts.csv` | the day's notes/summary as prose | search + semantic recall |
| `events.jsonl` | one event per meeting, verbatim transcript in `meta.transcript` | the Journal timeline |

A Granola document that was never a meeting — its onboarding note, a scratchpad —
is counted as a `note`, not a `meeting`, and contributes no meeting minutes.
Meeting length comes from the transcript (what actually happened), falling back to
the calendar block only when nothing was recorded; an implausible block (Granola's
onboarding doc ships a week-long placeholder) is ignored.

### Run it

It's a normal Tier-1 source, so every surface works with no arguments:

```bash
agentqs sync granola                 # CLI
```

```bash
# HTTP API — <KEY> is the token from Settings → Connect
curl -X POST http://localhost:3000/api/import/granola \
  -H "Authorization: Bearer <KEY>" \
  -H "content-type: application/json" \
  -d '{"days":365}'
```

Over MCP it appears in the generic `sync` tool. Re-running is safe: events are keyed
by Granola's document id, so a re-sync updates a renamed or re-summarized meeting in
place and never duplicates one.

If the desktop app isn't installed or signed in, paste a refresh token instead —
set `GRANOLA_REFRESH_TOKEN`, or connect the source with the token as its credential.

Verify the plugin end to end (offline fixture; `--live` also does one real
read-only sync if Granola is signed in):

```bash
npm run granola:test
npm run granola:test -- --live
```

---

## Spotify — the data export

The Spotify Web API only returns your last 50 plays (that's the built-in `spotify`
source). To get the *year* behind it, request **Account data** at
[spotify.com/account/privacy](https://www.spotify.com/account/privacy) — the zip
arrives by email in a few days. It's an archive, not an API, so it imports from disk
via the CLI (the server can't reach your `~/Downloads`), writing to `spotify_history`
so a later live `spotify` sync can never overwrite a full day with its 50-play window.

```bash
npm run import:spotify                                  # reads ~/Downloads/my_spotify_data.zip
npm run import:spotify -- --zip ~/Downloads/export.zip  # a specific zip
npm run import:spotify -- --dir "~/Spotify Account Data" # an unpacked folder
npm run import:spotify -- --dry                         # counts only, writes nothing
```

What it produces:

| Where | What |
| --- | --- |
| `daily/spotify_history.csv` | `tracks · minutes · artists · podcast_episodes · podcast_minutes · searches` per day |
| `daily/spotify_history_texts.csv` | a searchable digest of each day's listening (top tracks/artists) |
| `events.jsonl` | one event per play, per podcast episode, and per search |
| `inbox.jsonl` | taste profile, Wrapped, playlists, saved tracks — as `reference` documents (searchable, never queued for structuring) |

Re-running is idempotent end to end: plays are deduped by a stable per-play id, and
the one-off reference documents by a stable id derived from what they are.

---

## After either import

Both call `rebuild()` themselves, so the record and the SQLite cache are already in
sync. The embedding index self-heals on the next search/recall (the first call after
a large import rebuilds it, which can take a minute). To rebuild it up front:

```bash
agentqs rebuild
```

<p align="center">
  <img src="public/logo.svg" alt="agentqs" width="200" />
</p>

<h1 align="center">agentqs</h1>
<p align="center"><b>A journal that builds itself — and the best mentor and therapist you've ever had.</b></p>
<p align="center">It knows everything about you. It finds your patterns, helps you replicate what works, keeps you on your good habits, and gives you real clarity and awareness over your own life.</p>

<p align="center">
  <a href="#run-locally"><b>Run locally →</b></a>
  &nbsp;·&nbsp;
  <a href="#self-host-with-docker"><b>Self-host with Docker →</b></a>
  &nbsp;·&nbsp;
  <a href="#license"><b>License →</b></a>
</p>

---

You don't fill it in. You live your life, connect your sources, and talk to it like a friend — and the record **builds itself.** Then ask it anything and get an answer grounded in **your** numbers, not generic advice.

- ✅ **Talk to your life** — "why have I felt off this week?" → an answer from your actual sleep, heart rate, calendar and messages
- ✅ **Every source, one record** — WHOOP, Apple Health, calendar, Spotify, GitHub, browsing, WhatsApp, location — merged into one daily table
- ✅ **Capture anything** — type it, drop a file, or hit record for a voice memo; turn it into structured data with one click
- ✅ **It remembers** — dated mentor sessions and the patterns that emerge across them build over time
- ✅ **Any AI provider** — Claude, OpenAI, Gemini. Paste your key; models load in.
- ✅ **Built for Claude Code** — every screen shows its CLI command, API call, and MCP config

Runs on **your own server** and **your own AI key**. Your data lives in your own private git repo — nothing leaves except the questions you send your model.

---

## What you'd use it for

- **"Why am I tired / off / anxious lately?"** — grounded in the week's real signals, not a horoscope
- **Weekly review** — what changed, what correlated, what to try next week
- **Decisions with your own history** — "should I take this on? what happened last time I did?"
- **Spot your patterns** — "fire days cost me +10 bpm and 47 minutes of sleep"
- **A journal that talks back** — capture a memo, get reflection, never a blank page

## Set up in 4 steps

Sign in with an email or username, connect a source or two, ask your first question, and you're in. No terminal required — though it's right there if you want it.

1. **Connect data** — link APIs from the Data tab, or just drop a file
2. **Ask anything** — get an answer grounded in your own record
3. **Capture** — type `//`, voice-memo, or drag-and-drop
4. **Bring your AI** — paste any key in the header **Connect / API** panel; models load in live

## Chat — your mentor

One conversation, Claude-Code style. Plain text talks to the mentor. `//` logs a memo — appended raw to your inbox, no LLM, no reply. `/` runs a command.

Or **start a live voice session** — talk it out with a therapist grounded in the methodology *you* choose (CBT, ACT, schema, IFS…), or any persona you build. It listens, reflects, and quietly **writes the key points back into your daily record.** No forms, no data entry — **the database builds itself from your conversations.**

Replies **stream in token-by-token** and always quote your real numbers — a grounded answer lands with a **grounded in your record** badge and an inline **sparkline** of the metric it cited (its shape over time, plus the latest / avg / range). Switch persona any time.

## Journal — your life on one timeline

Every day in one place: metrics, memos, and the mentor session you had that day, side by side. The Notion-style table is the default — reorder and resize columns, then save the layout as a named view (like a **Sleep** view that shows only your sleep column); your views are stored with your account and come back every time. Hit **Edit** to change any cell, add or delete rows and columns — **Save** writes straight back to the record's CSVs (`POST /api/journal/edit`). Flip to **Timeline** for the narrative view.

## Data — one pipe, all your sources

Connect apps, set a sync interval per source, and drop files into the inbox. Hit **Structure** to turn raw notes and exports into clean daily data — you only pay the AI when you press the button. Below it, a **Log** keeps every capture that entered the record (`GET /api/log`): click one to review the exact cells Structure wrote as a before → after diff, **Reject** it (`POST /api/log/reject` — undoes those cells), or **Ask AI** to hand it to Chat for a review or an improved structuring. A **Photos** panel folds your pictures in too (EXIF + thumbnails + local CLIP recall — see [Photos](#photos--your-pictures-in-the-record-searchable-by-meaning)).

**No API? Automate the site.** For a source with no ready API, the Data tab's **Connections → Automate a site without an API** wizard walks you through it: pick the source, hand it a login, record the click-path to your data once (a real headless browser scrapes the table via Playwright), then schedule how often it replays. The result lands under **Automated imports** as an editable feed — same interval, Run-now, and Remove as any other source. A scraped table with a date column merges into your daily timeline; anything else lands in the inbox for Structure. Needs a one-time `npx playwright install chromium`.

## Built for Claude Code — CLI-first

Every capability is reachable three ways off **one core** (`src/lib/cli-core.ts`): the
`agentqs` **CLI**, a **JSON API** (the Next routes the GUI calls), and an **MCP server**
for Claude Code. The GUI is just a fourth face on the same core — nothing is
GUI-only. A Supabase-style bar on top surfaces the exact CLI command + API call for
whatever screen you're on, plus one-click **Connect to Claude Code**.

**Install the CLI** (private repo — `npm link` exposes the `agentqs` command; or use `npm run cli -- …`):

```bash
npm install && npm run build && npm link      # → `agentqs` on your PATH
```

**Every command:**

```bash
agentqs chat "why have I felt off this week?"    # grounded mentor reply
agentqs chat "recap" --skill therapist           # switch persona per call
agentqs query "select date, value_num from daily where metric='mood'"
agentqs journal --table --limit 30               # your record, wide view
agentqs import ./export.csv --name mood          # drop any file (CSV structures instantly)
agentqs structure                                # turn pending prose into daily rows (uses your key)
agentqs sources                                  # list sources + sync state
agentqs source connect rescuetime <key>          # save an API source's credential
agentqs whoop connect you@email.com <password>   # WHOOP via the unofficial app login
agentqs sync whoop                               # pull per-minute HR + HRV + recovery + sleep + strain
agentqs source interval github daily             # schedule an automated import
agentqs source remove chrome                     # remove an automated import (data + schedule)
agentqs sync github                              # run one source now (omit to sync all connected)
agentqs source file chrome                       # import a local-disk source (Chrome/iPhone)
agentqs automation add "Power bill" --url https://… --cred-type userpass \
  --username you --password ••• --table "table.usage"   # automate a site with no API
agentqs automation run power-bill                # replay it now (Playwright; --headed to watch)
agentqs automation schedule power-bill weekly    # set its cron cadence
agentqs automation list                          # your automations + last-run status
agentqs photos ~/Pictures/export                 # fold photos into the record (local, keyless)
agentqs skill add "Stoic" --system "…"           # add a mentor — answers everywhere
agentqs skill list                               # built-ins + your own
agentqs config set model claude-sonnet-4-5       # provider · model · key · theme
agentqs rebuild --verify                         # rebuild the cache (assert determinism)
```

Add `--json` to any command for machine-readable output. The **same core** backs
`/api/chat`, `/api/journal`, `/api/skills`, `/api/import/[source]`, `/api/structure`,
`/api/log`, `/api/journal/edit`, `/api/models` (live model list from your provider),
`/api/keys`, `/api/demo`, …

**API key:** mint one in the header **Connect / API** panel (or `POST /api/keys`). Pass
it as `Authorization: Bearer <key>` to reach every endpoint from a headless agent — the
panel fills the key straight into copy-paste curl / CLI / MCP / Claude-Code-skill snippets.

**Demo data:** the first-run Welcome popup offers generic sample data (`POST /api/demo`)
so a new instance isn't empty. It's clearly not your data and is **auto-wiped on your
first real import** — no mixing.

**Connect to Claude Code (MCP):** `agentqs serve --mcp` speaks MCP over stdio and
exposes the whole core as tools (`chat`, `query`, `journal`, `sources`, `sync`,
`sync_file`, `import_file`, `structure`, `connect_source`, `set_interval`, `rebuild`,
`config_*`, `skill_*`, `photos_*`). Register it once:

```bash
claude mcp add-json agentqs '{"command":"agentqs","args":["serve","--mcp"]}'
```

Now Claude Code can import a file, connect a source, schedule and run syncs, add a
mentor, rebuild, query, and chat with your grounded record — without leaving the
terminal.

## Integrations

One daily record, fed from wherever your life happens.

**API-first:** every source that ships an API is pulled through it — never a manual export. Manual/file import is only for sources that genuinely have no API (a local Chrome-history SQLite, an iPhone backup, Apple Health on-device).

**Body & health**
- **WHOOP — per-minute.** Not just a daily score: **minute-by-minute heart rate**, HRV, recovery, sleep stages and strain. This is what makes correlations *real* — "that meeting spiked me to 110," "this person costs me +10 bpm," "I never recover on days I skip lunch." Most tools only ever see your daily average. **agentqs sees every minute.**
- **Oura** — readiness score & body-temperature deviation (personal access token)
- **Fitbit** — steps per day (OAuth)
- **Strava** — activities, distance & moving time (OAuth)
- **Apple Health** — steps, heart rate, sleep, workouts, energy (on-device export — no API)
- **Apple Watch** — workouts, heart rate, activity rings (via the Apple Health export — no API)
- **Health Connect** — the Android health + fitness aggregate (on-device export — no API)
- **Garmin** — activities, sleep, body battery (record-login automation — no open API)
- **Withings** — weight, body composition, sleep (record-login automation)

**Focus & work**
- **RescueTime** — where your hours actually go
- **GitHub** — commits per day
- **Toggl Track** — tracked entries & hours
- **Todoist** — tasks completed per day
- **Notion** — pages edited per day (integration token)
- **Instapaper** — articles saved & read (record-login automation)
- **Browsing** — what you read (local Chrome/Firefox/Safari history — no API)
- **Screen Time** — per-app usage from your iPhone (local backup — no API)

**Life**
- **Google Calendar** — meetings, and how they land on your body
- **Spotify** — tracks & minutes listened
- **Deezer** — tracks played per day (OAuth access token)
- **Last.fm** — scrobbles per day (API key + username)
- **Trakt** — shows & movies watched
- **Swarm** — check-ins per day (Foursquare OAuth token)
- **Mastodon** — posts per day (record-login automation)
- **Apple Weather** — daily conditions & temperature (record-login automation)
- **WhatsApp / iMessage** — conversation history
- **Location** — where you were (OwnTracks live, or Google Timeline)

**Anything else** — drag-drop any CSV, text export, or screenshot. The agent works out what it is and structures it. No importer required.

## Run locally

```bash
cp .env.example .env       # AI key optional — add providers in the UI
npm install
npm run dev                # → http://localhost:3000
```

Embeddings run on a real local model (all-MiniLM-L6-v2 via transformers.js) out of the box — no key, no cost. Semantic search ("find days that felt like this") and photo text→image recall (CLIP) both run on-device; the quantized weights cache under `data/models` on first use.

## Self-host with Docker

The container runs the full app — UI, mentor, API syncs, bots, scheduler. Two things to know about **file-based** sources (Chrome history, iPhone backup), because those live on *your* machine, not in the container:

```bash
docker run -d \
  -v ~/agentqs-data:/data \                                  # your record + SQLite (persist this)
  -v "$HOME/Library/Application Support/Google/Chrome:/host/chrome:ro" \  # optional: local file sources
  -e ANTHROPIC_API_KEY=sk-... \
  -p 3000:3000 agentqs
```

- **Docker on the machine that has your data** (your Mac, a NAS): mount those paths read-only (the importer probes `/host/chrome/Default/History`) and agentqs reads them directly.
- **Docker on a remote server** (VPS, Coolify): the container can't reach your laptop's files. Run the local daemon on your machine — `npm run daemon -- run --push` imports your file sources and commits + pushes them into your record repo, and the server pulls. **Git is the sync layer**, so the remote instance still sees everything.
- API sources (WHOOP, Calendar, GitHub…) work anywhere — no local machine needed.

## The record (source of truth)

Your life lives as **plain text in a git repo** — human-readable, diffable, and importable by a script in any language. The SQLite database is just a **rebuildable cache** (never committed); the record is the truth.

```
record/
  daily/<source>.csv   one wide CSV per source, first column `date`
  inbox.jsonl          one raw capture per line (the pending bucket)
  sessions.jsonl       one mentor/therapy session per line
  photos.jsonl         one photo pointer per line (EXIF, never the bytes)
```

Each `daily/*.csv` is melted into long form — `(date, source, metric, value)` — so any new source, or any CSV you drop in, adds its columns with **zero schema migration**.

By default the record lives under `data/` and stays **out of the app repo** (`.gitignore`) — you point it at its own private repo. Prefer one repo for app + record? Flip **Settings → Data → Allow this repo to track data/record** and the managed `.gitignore` lines swap so `data/record/` is versioned with the app (everything else under `data/` — cache, models, thumbnails — stays ignored). Only enable it if the repo is **private**; the switch makes you confirm exactly that.

Rebuild the cache from the record any time — it's pure, so the same record always yields the same database:

```bash
npm run rebuild            # rebuild ./data/agentqs.db from ./data/record
npm run rebuild:verify     # build the sample record twice, prove the bytes are identical
```

## Importers

Each source is a small script behind the record contract: fetch → normalize →
write one `daily/<source>.csv` → rebuild. **GitHub** (commits/day) is the first,
live end to end:

```bash
# your own commits — token from --token, GITHUB_TOKEN, or the Data tab
npm run import:github -- --token ghp_xxx --rebuild

# any public author, no token needed
npm run import:github -- --login torvalds --days 30 --record /tmp/rec --rebuild

# offline: run the same normalize → write → rebuild path against a fixture
npm run import:github -- --fixture samples/github-commits.json --login demo \
  --from 2026-06-01 --to 2026-06-14 --record /tmp/rec --rebuild
```

It pulls commits from the GitHub Search API, buckets them by author-date into a
dense per-day series, and merges them into `record/daily/github.csv`. In the app,
the **Data** tab does the same with one click (paste a token → real commits land
in your record and rebuild into the daily table).

### API plugins — one interface, every API source

Every single-credential API lives behind one shared **plugin** interface
(`src/lib/importers/plugin.ts`): `credential → fetch a window → normalize into a
wide daily table → merge into record/daily/<id>.csv → rebuild`. Adding a source is
one file plus a registry entry — no new route, no new UI. They all share the
generic `/api/import/[source]` route and the `SourceConnect` Data-tab row (paste a
credential → sync → sparkline + interval), one CLI, and the MCP `sync` tool:

```bash
# RescueTime/Oura/Toggl/Todoist use an API key; the OAuth ones (Strava, Spotify,
# Fitbit, Deezer, Swarm) take an access token
npm run import:source -- --source rescuetime --credential <key> --rebuild
npm run import:source -- --source strava --credential <token> --days 30 --rebuild
npm run import:source -- --source deezer --credential <access_token> --rebuild

# Last.fm and Trakt need two values in the one credential slot ("a:b")
agentqs source connect lastfm "<api_key>:<username>" && agentqs sync lastfm
agentqs source connect trakt "<client_id>:<access_token>" && agentqs sync trakt

# offline: run the real fetch → normalize → merge → rebuild path against a fixture
npm run import:source -- --source gcal --fixture samples/gcal-events.json \
  --from 2026-06-01 --to 2026-06-30 --record /tmp/rec --rebuild
```

| Source | Auth | Primary daily metrics |
|---|---|---|
| **RescueTime** | API key | `productivity_pulse`, `productive_hours`, `distracting_hours`, `total_hours` |
| **Google Calendar** | OAuth token | `meetings`, `meeting_hours` |
| **Spotify** | OAuth token | `tracks`, `minutes` |
| **Oura** | personal access token | `readiness_score`, `temp_deviation` |
| **Fitbit** | OAuth token | `steps` |
| **Strava** | OAuth token | `activities`, `km`, `moving_hours` |
| **Last.fm** | API key `:` username | `scrobbles` |
| **Toggl Track** | API token | `entries`, `tracked_hours` |
| **Todoist** | API token | `completed` |
| **Trakt** | client id `:` access token | `plays` |
| **Notion** | integration token | `pages_edited` |

`npm run api:test` drives all of them end to end (fetch → normalize → merge →
assert real numbers) against offline fixtures — no network, no keys.

### WHOOP — the unofficial app login (the differentiator)

WHOOP is bespoke (`src/lib/importers/whoop.ts`), **not** the official public API
(daily summary only). It drives the same reverse-engineered mobile-app auth the
WHOOP app uses: your **email + password** are exchanged for a bearer token at
`POST https://api-7.whoop.com/oauth/token`, then it pulls the app's private
endpoints — `/users/{id}/cycles` (recovery, HRV, resting HR, strain, sleep) and
`/users/{id}/metrics/heart_rate?step=60` (**per-minute heart rate**).

- The per-cycle metrics roll up into `record/daily/whoop.csv` (`recovery`, `hrv`,
  `resting_hr`, `strain`, `sleep_hours`, `sleep_perf`, plus `hr_avg`/`hr_max`
  derived from the minute stream).
- The **per-minute heart rate** is written verbatim to `record/whoop/hr/<date>.csv`
  — a granularity no journaling app captures.
- Email + password are stored in `config.json` (mode `0600`, never committed);
  tokens are cached and refreshed, and the password is re-used only to re-auth
  when a refresh token expires, so the scheduled pull never silently dies.

```bash
agentqs whoop connect you@email.com <password>   # store creds (or the whoop_connect MCP tool)
agentqs sync whoop                               # auth → cycles + per-minute HR → daily table
agentqs source interval whoop daily              # scheduled pull
```

### Tier-2 file importers — Chrome history · iPhone backup

Some sources aren't an API — they're a file on **your own machine** (a Chrome
`History` SQLite, an iPhone backup) that a remote/Docker instance can't reach.
These live behind a sibling contract (`src/lib/importers/file-plugin.ts`): `local
file → read a window → normalize into a wide daily table → merge into
record/daily/<id>.csv → rebuild`. Same idempotent write, same daily table the
mentor reasons over. Because the reader touches your disk they run **locally**
(the CLI / daemon), never on the server:

```bash
# Chrome browsing history — visits, pages, domains per day.
# Omit --path to probe the default profile location for your OS.
npm run import:file -- --source chrome --rebuild
npm run import:file -- --source chrome --path "~/Library/Application Support/Google/Chrome/Default/History" --days 30 --rebuild

# iPhone backup (stub) — a snapshot row from an unencrypted Finder/iTunes backup.
npm run import:file -- --source iphone --path "~/Library/Application Support/MobileSync/Backup" --rebuild
```

Chrome copies the (locked) `History` file to a temp dir and reads the copy, so it
never touches the browser's own file, and converts Chrome's WebKit-microsecond
timestamps to days. **iPhone is a stub adapter**: it reads the backup's
`Manifest.db` and lands a real *snapshot* row (`files_backed_up`, `domains`) for
the backup's day — the per-domain call / iMessage / screen-time extraction isn't
wired yet, so the Data tab marks it *not-live*.

| Source | Reads | Daily metrics |
|---|---|---|
| **Chrome history** | `History` SQLite (`urls` + `visits`) | `visits`, `pages`, `domains` |
| **iPhone backup** *(stub)* | `Manifest.db` | `files_backed_up`, `domains` |

### Local daemon — ingest local files, then git-sync to the cloud

The daemon is the local loop that keeps file sources fresh and hands them to a
cloud replica. **Git is the sync layer**: the daemon commits your record repo on
your machine, the cloud instance pulls it.

```bash
npm run daemon -- ingest          # run every file importer found on THIS machine → rebuild
npm run daemon -- sync            # git add + commit the record repo (--push to send upstream)
npm run daemon -- run --push      # ingest, then commit + push in one shot
```

`ingest` probes each importer's default file locations, imports whatever it finds
(silently skipping the rest), and rebuilds the cache once. `sync` commits the
record and, only with `--push`, pushes it — so a remote/Docker agentqs sees your
Chrome history and everything else after it pulls, without ever reaching your
laptop's disk.

### The agent brain — a mentor that queries your own record

With an AI key the mentor is a real **tool-using agent** (`src/lib/agent.ts`), built
on the **Vercel AI SDK** so it's provider-agnostic — default **Claude**, or paste an
OpenAI / Gemini key and the same agent runs on that model. It doesn't get your
numbers stuffed into its prompt; it **fetches them**, calling its tools until it
can answer:

- **`query_daily`** — runs a read-only SQL `SELECT` over your long/tidy `daily`
  table and gets the real rows back (the connection is read-only, so it can read the
  record but never mutate it).
- **`search_notes`** — FTS5 keyword search over your memos and past sessions for the
  qualitative context behind a number.
- **`find_similar`** — semantic search over the same text via the local embedding
  index (see below): finds days that *felt* like a described feeling even when they
  share no keywords. SQL for numbers, FTS for exact words, embeddings for vibe.
- **`find_similar_images`** / **`photo_context`** — text→image recall over your photos
  (local CLIP) and what a date's pictures show (count, geotag, scene tags). See
  **Photos**, below.

The persona (mentor / therapist / coach) is the system prompt; a compact schema
catalog tells it what's queryable. So *"why have I felt off?"* makes it `SELECT` your
WHOOP sleep + recovery, then reply *"sleep dropped to 6.1h and recovery fell to 41%
— your lowest in the window."* The reply **streams token-by-token** into the Chat tab
(NDJSON over the `curl -N` endpoint); when it closes, a **grounded in your record**
badge names the sources the tools touched and an inline **sparkline** plots a cited
metric over time.

With **no key**, a cross-source question is still answered deterministically from the
numbers (`src/lib/grounding.ts`) — two metrics from different sources are lined up on
their shared days and the relationship reported (e.g. *"commits run 13.25 on your
high-productivity days vs 3 on the low ones"*).

## Sync engine — schedules, lazy-sync, stale badges

The **Data** tab lists every source with its type (`api` / `manual`), last-sync,
and a per-source **interval** dropdown (Manual · Hourly · Daily · Weekly). You
pick the cadence **when you connect** an API/OAuth source (it defaults to **Daily**
so it starts syncing on its own), and can change it any time from the source row.
The cadence is saved per user in `config.json` (`sourceIntervals`).

- **API sources auto-sync (lazy, on open).** When the Data tab opens, any api
  source whose interval has elapsed is **due** — the app runs it in the
  background, then refreshes the daily-table preview. Set **GitHub → Daily** and
  the next time you open the tab it re-pulls your commits with no click. (GitHub
  only auto-runs when a token is available, so it never loops on a failure.)
- **Manual sources get a stale badge.** A dropped/pasted source can't auto-sync,
  so when no fresh data has arrived within its interval it shows an amber
  **stale** badge — a nudge to refresh it. Manual sources are never "due".

The list is composed server-side (`src/lib/source-registry.ts`) from a registry
of known integrations plus any manual sources discovered in `record/daily/*.csv`;
the schedule math (`isDue` / `isStale`) is a pure, browser-safe module
(`src/lib/sources.ts`) shared by the API and the UI.

## Structure — raw → daily

Anything you capture lands raw and free in the **pending inbox**: memos (`//` in
Chat), voice notes, and any CSV or text file you **drag-and-drop** (or Upload) onto
the Data tab. Nothing is parsed until you press **Structure** — that's the only
place you spend tokens, and only for prose. Prefer zero clicks? Turn on **Settings →
Structure → Auto-structure new captures** and every capture (memo, voice note,
file, channel message) merges straight into the daily table, skipping the pending
queue; prose that can't structure (no key, no dated metrics) just stays pending.

- **Clean CSV / TSV → direct column map, no LLM.** The first date column becomes
  `date` (ISO), the rest become metrics, and it's merged into
  `record/daily/<source>.csv`. Deterministic and free.
- **Prose note → LLM.** The model extracts any dated metrics into the same wide
  shape, then merges the same way. Needs an AI key (Settings); if none is set,
  prose items stay pending and CSVs still structure for free.

Either way the cache is rebuilt and the new rows appear in the **daily table**
preview right below the inbox — long form `(date, source, metric, value)`, the
same table the mentor reasons over. And every structure lands in the Data tab's
**Log**, where you can audit the exact cells it wrote, reject them, or hand them
to Chat for a better pass.

## Sessions — memory that carries

Every conversation is a **session**. When you end one (`/new`, or **+ New
session** in the Chat sidebar) it's distilled into a small **synthesis** —
`{title, summary, insights, commitments}` — and appended to
`record/sessions.jsonl`, the typed session store kept **separate from your daily
data**. With an AI key the model does the distilling; with no key a deterministic
heuristic lifts your explicit commitments and a plain summary from your own words
(it never invents insights).

That synthesis is the memory. When a **new** session opens, the mentor reads the
prior sessions' synthesis — summaries, insights, and open commitments, **never
the raw transcripts** — and picks up the most relevant open commitment
("last session you committed to X — how did that go?"). The transcript is still
stored for provenance, but the agent never reads it back.

Sessions surface as dated entries on the **Journal timeline**, side by side with
that day's metrics and memos — one storage layer (typed + synthesis), one merged
view.

## Semantic search — find days that felt like this

Ask *"find days that felt like this"* and agentqs surfaces the days that **rhyme with
a feeling** — matched by meaning, not keywords. Type it in the box on the **Journal**,
ask it in **Chat**, or hit the API — *"wired, couldn't switch off"* still surfaces the
day you wrote *"anxious and stressed."*

It runs on a **real local embedding model + sqlite-vec**, on by default with **nothing
to set up** — no key, no cost, private, runs on-device:

- **The local model** (`src/lib/embedder.ts`) is a genuine sentence-transformer
  (**all-MiniLM-L6-v2**, 384-dim) run locally via transformers.js + onnxruntime
  (CoreML on Mac). The quantized weights are cached under `data/models` (fetched once,
  then offline), so *"couldn't switch off, on edge"* lands next to *"anxious and
  stressed"* by real meaning. If the model can't load on some host, a zero-dependency
  hash featurizer (`src/lib/embed.ts`) stands in so recall never hard-fails. Both sit
  behind one `embed()` seam; the model id versions the vector space and forces a clean
  reindex when it changes.
- **sqlite-vec** (`src/lib/embeddings.ts`) stores the vectors and runs the nearest-
  neighbour search inside SQLite. It self-heals: the index is a separate derived file
  (never committed, kept out of the byte-deterministic main cache) that rebuilds
  whenever your record or the model changes. If the loadable extension can't load on
  some host, the same vectors are ranked by a pure-JS cosine fallback — it never
  hard-fails.

Every memo and session synthesis is indexed with its date; a query collapses to the
best-matching **days**. SQL (`query_daily`) still answers numbers and FTS5
(`search_notes`) still answers exact keywords — embeddings add *vibe*. It all works
with **no AI key**; the mentor also calls it as the `find_similar` tool when a key is
set. Settings shows the index status and a one-click **Reindex**, plus two switches:
**Embed entries** (default on; off = no vectors, recall/search fall back to keywords)
and **Auto-index** (default on; off = the index only updates when you press Reindex).

## Photos — your pictures in the record, searchable by meaning

Point agentqs at a folder (Google Takeout, screenshots, an export) or your **Mac Photos
library** and it folds your pictures into the same record — **all on-device, no key,
and the originals never leave your machine**. Per photo:

- **EXIF** (`exifr`) → capture date, GPS, camera → a git-record line
  `record/photos.jsonl` `{id,date,ref,exif}` (a *pointer* to the original, never its
  bytes).
- **Thumbnail** (`sharp`) → a small webp under `/data` (gitignored — off git and the
  cloud, like the originals).
- **CLIP** (transformers.js, CoreML on Mac) → a 512-dim vector in **sqlite-vec** (never
  committed) so you can recall photos by describing them: *"beach at sunset"*, *"my
  dog"*, *"whiteboard sketches"* — no labels, no key.
- **Caption** (optional `--caption`, a local vit-gpt2/BLIP-family model) → a sentence →
  **scene tags** (people, nature, food, …).

EXIF and tags also roll up into **daily features** — `photo_count`, `photo_geotagged`,
`scene_*` — so the mentor can line photos up against mood and sleep. It exposes two
mentor tools, **`find_similar_images`** (text→image recall) and **`photo_context`**
(what a date's photos show), and a Photos panel under the **Data** tab.

```bash
agentqs photos ~/Pictures/export      # import a folder (EXIF + thumbnails + CLIP)
agentqs photos --library --caption    # the Mac Photos library, with scene captions
agentqs photos status                 # counts: imported · indexed · geotagged
agentqs photos search "beach sunset"  # text → image recall (local CLIP, no key)
```

Flags: `--since <date>` (only newer files), `--caption` (scene tags), `--push` (git
commit + push the record). The same reach through the API (`/api/photos`) and MCP
(`photos_import`, `photos_search`, `photo_context`).

## Voice — a memo you speak, and a session you talk

Two separate voice paths, both landing in the same record.

**Global mic → voice memo.** The mic in the top bar (every tab) records audio,
transcribes it, and drops the transcript **raw into your inbox** — no LLM, no
daily row, exactly like a typed `//` memo. Structure it later like anything else.
Transcription is the only external step, and it's **pluggable**
(`src/lib/voice.ts`):

- **Built-in local Whisper (one click, private, no cost).** Settings → Voice
  memos installs Whisper INTO the app: a quantized ONNX model (tiny ~45 MB /
  base ~85 MB / small ~265 MB) downloaded once into `data/models` — the same
  local-model cache as search embeddings — and run on-device via transformers.js
  (`src/lib/whisper-local.ts`). No binary, no key, no cloud; audio never leaves
  the machine. Pick the spoken language there too (Whisper can't auto-detect
  yet). Manage it over HTTP with `GET/POST/DELETE /api/voice/whisper`.
- **Your own engine (`WHISPER_BIN`, overrides everything).** Point `WHISPER_BIN`
  at any command that takes an audio file path and prints the transcript — wrap
  whisper.cpp, faster-whisper, or a one-line shell script (`WHISPER_ARGS` passes
  extra args before the file). Preferred when set.
- **OpenAI Whisper (cloud fallback).** With nothing local, agentqs uses OpenAI
  Whisper if an OpenAI key is available (`OPENAI_API_KEY`, or your saved key when
  the provider is OpenAI).
- **No backend wired?** The mic stays config-gated — it explains what to set
  instead of recording, and `POST /api/voice/memo` returns a `501` with the hint.

**In-chat live voice session (ElevenLabs).** The toggle beside the chat input
starts a real-time voice conversation — premium voice + natural turn-taking, with
**Claude as the brain** (set the agent's LLM to Claude in the ElevenLabs
dashboard) and the session's key points written back to your record. It's
**config-gated**: a stub until both `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID`
are set. Once configured, `POST /api/voice/session` mints the signed URL the
ElevenLabs Conversational AI widget connects to.

## Channels — talk to your record from Telegram or Slack

Your mentor doesn't have to live in the browser. Point a **Telegram** or **Slack**
bot at your running instance and DM it — *"why am I so tired lately?"* comes back
with the same grounded answer the Chat tab gives, and `// slept badly` still lands
raw in your inbox. It's the cloud replica's job: **message in → memo or grounded
chat → reply out.**

Every channel is the same channel-agnostic adapter
(`src/lib/channels/*`) — a thin shell around the shared reply brain
(`src/lib/reply.ts`, the exact `//`-memo / grounded-chat logic the Chat box uses,
just non-streaming):

- **ingest** — verify the request came from the platform (a Telegram shared secret,
  a Slack signing-secret signature) and parse it into one normalized message.
- **composeReply** — the shared brain: a `//` line is appended raw to the inbox
  (no LLM, no daily row) and acked; anything else is answered grounded — the
  tool-using agent with a key, the deterministic cross-source answer without one.
- **send** — post the reply back out via the platform's official API
  (Telegram `sendMessage` · Slack `chat.postMessage`).

Per channel, **Settings → Channels** sets how it replies: AI replies on/off, which
persona answers, and an optional provider/model override — so Telegram can be the
terse coach on a cheap model while the web Chat stays your full mentor.

Adding a channel is one small file plus a registry entry — the brain, the record,
and the grounding never change. Each is a webhook at `/api/channels/<channel>`:

```bash
# Telegram — create a bot with @BotFather, set TELEGRAM_BOT_TOKEN, then register:
curl "https://api.telegram.org/bot<token>/setWebhook?url=<host>/api/channels/telegram&secret_token=<secret>"

# Slack — set SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET and point the app's
# Events API request URL at <host>/api/channels/slack (the url_verification
# handshake is handled automatically).
```

Channels are official APIs only — **WhatsApp will use the official Cloud API**, never
an unofficial bridge (data + ban risk). The transport carries the message; your
sensitive data never leaves your store.

## Tests — every feature ships with its proof

Each loop of the build plan lands with an executable ships-when proof — real
modules, real built app, offline fixtures, no mocks of the thing under test:

```bash
npm run chat:test          # grounded NDJSON streaming into the Chat tab
npm run smart:test         # the `//` memo / `/` command / plain-chat contract
npm run session:test       # a new session picks up a prior session's commitment
npm run sync:test          # due/stale schedule math over real sources
npm run integration:test   # keyless cross-source answer cites 2+ sources
npm run api:test           # every API plugin end to end against fixtures
npm run whoop:test         # the unofficial-login WHOOP pipeline
npm run files:test         # Chrome-history + iPhone file importers + daemon sync
npm run voice:test         # voice memo → transcript → raw inbox (local Whisper)
npm run channels:test      # Telegram + Slack webhooks → grounded reply out
npm run semantic:test      # local embeddings + sqlite-vec match days by meaning
npm run flags:test         # auto-structure + embed/auto-index switches
npm run photos:test        # EXIF + thumbnails + CLIP recall, all local
npm run agent:test         # the agent calls SQL + FTS tools and cites real numbers
npm run automation:test    # the no-API site automation (Playwright)
npm run edit:test          # journal cell edits write back to the record CSVs
npm run log:test           # the Data-tab capture log, over the built app
```

## Good to know

- **Private by design.** Your data lives in your own git repo and your own server. Nothing is sent anywhere except the slices you ask your model about. BYO key.
- **WHOOP per-minute** rides your WHOOP app connection, not the limited public API — use your own account.
- **Local-first.** Everything works offline except API syncs and the messaging bots.
- **Cheap by design.** Raw capture is free; you only spend tokens when you press *Structure* or ask a question. Embeddings run locally.

## License

**Free for personal use. Not for sale.**

agentqs is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE): use it, self-host it, change it,
share it — for any noncommercial purpose. You may **not** sell it, offer it as a
paid product or service, or use it commercially. For a commercial license, open
an issue.

# agentqs - agent guide

agentqs is a local-first personal data journal: plain-text record (`record/daily/*.csv`,
`inbox.jsonl`, `events.jsonl`, `sessions.jsonl`) -> deterministic SQLite cache -> web app,
CLI, MCP and JSON API, all driving the same core (`src/lib/cli-core.ts`).

## You are the AI - no API key needed

Every action works through the CLI (`npm run cli -- <command>`, or `agentqs <command>`
after `npm link`) or the MCP server (`agentqs serve --mcp`) with NO in-app AI key.
Where the GUI would call a model (structuring prose, chat), YOU do the reasoning and
hand the product deterministic input. Never ask the user for an API key for these flows.

Data lives in the platform app-data dir by default (macOS: `~/Library/Application
Support/agentqs`) — outside every sync engine's reach; legacy `./data` /
`./data.nosync` checkouts keep working. Override with `AGENTQS_DATA_DIR=<dir>`.
Add `--json` to any CLI command for machine-readable output.

### Structure prose captures (the key-free loop)

1. `agentqs inbox --json` - pending captures with FULL text.
2. Read one item and extract its dated metrics YOURSELF into CSV:
   - first column `date`, values `YYYY-MM-DD`
   - every other column one snake_case metric; prefer numbers
   - one row per date. Keep each fact on ITS OWN date - a timeline or multi-day
     document must NEVER collapse onto the capture day. Facts stated "as of" the
     writing date belong on the writing date; a fact about `2024-07-30` belongs
     on `2024-07-30`.
   - only facts explicitly stated in the note; nothing worth structuring ->
     `agentqs inbox keep <id>` (a living document/plan stays as a searchable
     reference memo) or `agentqs inbox discard <id>` (junk, drops it from every
     index). Never leave an unstructurable item pending.
3. `agentqs structure --id <id> --csv '<csv>'` (or `--csv-file <path>`).
   The product validates, merges into `record/daily/`, marks the item structured,
   and records exact undo metadata. `agentqs log reject <id>` reverts it.

MCP equivalents: `inbox_pending` -> `structure {id, csv}` / `inbox_resolve {id, action}`.

### Answer questions about the record (chat without a key)

- `agentqs query "<SELECT ...>"` - read-only SQL. Tables: `daily(date,source,metric,
  value_num,value_text)`, `raw_inbox`, `sessions`, `events`, `search` (FTS). When a
  detail store exists it is attached as `detail` - every point behind the daily
  rollups (`detail.heart_rate` per minute, `detail.chrome_visits` per visit);
  rebuild re-derives `heart_rate` from `record/whoop/hr/*.csv`.
- `agentqs recall "<feeling or situation>"` - local semantic search over memos,
  sessions and journal text (on-device embeddings, no key).
  ⛔ THE EMBEDDING MODEL MUST BE MULTILINGUAL, AND LONG TEXT MUST BE CHUNKED.
  Both were broken, and both failed SILENTLY - the memo was stored, reindexed,
  reported in the index count, and simply never came back from any query:
    - the model was `all-MiniLM-L6-v2`, which is ENGLISH-ONLY, on a record that is
      largely HEBREW. Every Hebrew dream, journal note and letter was unreachable
      in any language. The only Hebrew "hits" came from the English
      `<source>.<metric>:` prefix we prepend, never from the words. It is now
      `multilingual-e5-small` (`embedder.ts`), which is also CROSS-lingual: an
      English question finds the Hebrew day.
    - E5 is ASYMMETRIC: a stored document is embedded as `passage: …` and a search
      string as `query: …`. `embed(texts, role)` takes the role; `buildIndex` passes
      "passage", `semanticSearch` passes "query". Dropping the prefixes costs real
      accuracy.
    - a sentence-transformer's window is finite and the pipeline CLIPS the overflow,
      so ONE vector per document indexed only its OPENING. An 8KB BACKGROUND.md was
      searchable by its first paragraph and invisible after it. `collectItems` now
      splits long text into overlapping windows (`chunkText`), one vector each,
      ref `<base>#NNN`. A document is retrievable by ANY passage in it.
  `semantic:test` seeds a fact buried mid-document and a Hebrew document, and FAILS
  if either regresses. Bumping `NEURAL_ID` forces a clean reindex on next use.
- Combine both, then answer in your own words with the numbers cited.

### Everything else (already key-free)

- `agentqs onboarding` - START HERE on a fresh or unfamiliar instance: the live
  setup checklist (account -> API key -> first capture -> sources -> schedules
  -> GitHub backup -> Drive backup -> channels -> migrate existing data), each
  step with its exact CLI command, MCP tool and API call plus a `done` flag
  derived from real state and `nextStep` = the first thing missing. MCP tool:
  `onboarding`; API: GET `/api/onboarding`.
- `agentqs import <path>` - land any file (clean CSV structures instantly) or a
  WHOLE FOLDER: every file ends in exactly one bucket (structured / inbox /
  routed-to-importer / ignored / residue), the accounting is persisted as an
  inbox notification (one receipt per folder, latest run wins), and residue -
  files nothing claimed - exits 1. Idempotent: re-importing adds nothing twice.
  After a folder import, run the "Run next" importer commands from the receipt,
  then structure/keep the raw text items. MCP tool: `import_tree`. CLI/MCP
  only, deliberately no API route: a synchronous multi-GB walk would block the
  web server; the web face for files is the dropzone.
- `agentqs doctor` - store health: is the store inside a sync-engine domain
  (iCloud/Dropbox/OneDrive), any cloud-evicted files, "X 2" conflict twins,
  split stores. Exit 1 when unsafe. MCP tool: `doctor`; API: GET `/api/doctor`.
- `agentqs migrate-store [--to <dir>] [--dry-run]` - move the store to the
  sync-safe app-data dir: hash-verified copy, source retired (never deleted),
  launchd/crontab re-pointed. Stop the app first, restart after. MCP:
  `migrate_store`; API: POST `/api/store/migrate`.
- `agentqs backup` - off-site copies, two targets that together cover every
  byte: `backup github --remote <url>` pushes a SNAPSHOT branch of the record
  to a private repo (plumbing against a temp index - the record repo's own
  branches/history never leave the machine; files past GitHub's 100MB limit
  are excluded LOUDLY and named in the result); `backup drive` uploads the
  whole store (record + config.json) as ONE tar+AES-256-GCM archive to Google
  Drive, rotated to the newest `keep` (8). BACKUP IS NOT THE PIPELINE: a
  backup target moves data OUT, so Google Drive never appears as a source, is
  never listed by `pipeline`/`sources`, and lands NOTHING in the record -
  syncing or scheduling it as a source is refused. It only borrows the OAuth
  dance to hold its credential (`source authorize gdrive_backup`, drive.file
  scope). Both targets schedule under `config.backup` and ride `sync --due`:
  `backup github --schedule daily|off`, `backup drive --schedule daily|off`.
  (A Drive that IMPORTS files would be a separate, ordinary source - pulling
  data in has nothing to do with backup.) `backup passphrase --generate`
  first - archives are unreadable without it. `backup restore <file>|--latest
  --out <dir>` decrypts into a FRESH dir; `--into-store` instead REPLACES the
  live record with the archive's (previous record retired beside the store,
  instance config kept, cache rebuilt) - THE migration path onto a fresh
  instance: connect gdrive_backup + set the same passphrase there, then
  `backup restore --latest --into-store` (API: `{"target":"restore",
  "confirm":"replace-record"}`). `backup status` = "when did my data last
  leave this machine?". The Settings -> Data switches map 1:1 to the CLI:
  GitHub on/off = `backup github --schedule daily|off`, Drive on/off =
  `backup drive --schedule daily|off`, Drive connect = `source authorize
  gdrive_backup ...`. MCP: `backup_run` (`{"target","schedule"}`),
  `backup_status`, `backup_restore`; API: GET/POST `/api/backup` (the Drive
  run answers 202 + a background job - a multi-minute upload survives a
  reload; poll GET).
- `agentqs audit` - index audit: DETERMINISTIC evidence for an AI review pass -
  impossible dates, single-day sources, coverage holes, gone-quiet sources,
  outlier values. YOU judge each finding (real quiet vs dead import, unit bug
  vs true spike) and fix through the product: `journal-edit` for junk cells,
  re-run the named import, `scan` for duplicate columns. Read-only. MCP tool:
  `audit`; API: GET `/api/audit`.
- `agentqs scan [--fix]` - data-quality scan: duplicate daily columns (one
  metric imported manually AND by a sync), dead all-zero columns, and messy
  numeric values (units, thousands separators, junk placeholders). Findings
  queue as inbox notifications (kind `notification`, shown in Pipeline -> Data
  quality); structuring one applies the fix - merges keep the auto-synced
  column and save a rule so future imports stay merged. MCP tool: `scan`.
- `agentqs source file chrome|safari|iphone|health_daily|spotify` - local file
  importers. `health_daily` streams the iPhone Health app's export
  (export.zip / export.xml; Health -> profile -> Export All Health Data) and
  backfills the existing health_daily table - lifetime by default, device-
  deduped (iPhone + Watch never double-count). `spotify` reads the Spotify
  account export (my_spotify_data.zip / the folder / a Streaming_History_*.json,
  both the extended and account-data shapes) and backfills the SAME `spotify`
  source the API sync keeps fresh - the API serves ~50 plays, so this is the only
  place your listening history exists. `safari` reads
  ~/Library/Safari/History.db (needs Full Disk Access). CLI/MCP/daemon only,
  deliberately no API route: these read files on YOUR disk, which the web
  server can't reach; the web face for files is the dropzone (a dropped Spotify
  export or Health zip routes to its importer, named in the receipt).
- `agentqs source guide <id>` - HOW to connect a source: where its credential
  comes from, step by step, with the start URL. Relay these steps when the user
  asks how to connect something. MCP tool: `source_guide`; the web connect form
  shows the same guide (it lives once, on the plugin's `credentialHelp`).
- THE APP KEY AND THE LOGIN ARE TWO DIFFERENT THINGS. Registering an app with a
  provider (client id + secret) happens ONCE and is saved per PROVIDER in
  `config.oauthApps[<provider>]` (`saveOAuthApp`/`readOAuthApp`, src/lib/oauth.ts);
  the GRANT the dance mints is per ACCOUNT, in `config.sourceOAuth[<instance>]`.
  They have different lifetimes, so they are different buttons: "Save key" (once) ->
  "Sign in with X" (as often as you like, for as many accounts as you like).
  `beginOAuth` therefore does NOT require the client id/secret - pass them only to
  REPLACE the saved key ("use a different app key"). The key used to be stored INSIDE
  the grant, which meant re-pasting the client id + secret to add a second account or
  simply to log back in after a revoke - paperwork that had never expired. Legacy
  grants that still carry `clientId`/`clientSecret` are read as a fallback and
  migrated on the next save, so nobody re-enters anything. Anything reading client
  creds MUST go through `readOAuthApp` (Trakt's `clientId:token` credential silently
  became `undefined:<token>` when it read the grant instead).
- OAuth sources (spotify, gcal, fitbit, strava, whoop-api, withings, trakt -
  expiring/rotating tokens; plus `gdrive_backup`, which is a BACKUP TARGET, not
  a source: same dance, but its face is Settings -> Data / `agentqs backup`):
  connect via the authorize dance -
  in the web app the form shows the redirect URI to register and takes the
  user's app client id + secret (POST `/api/oauth/<id>` -> authorize URL ->
  GET `/api/oauth/callback` stores the grant), or start it from the CLI/MCP:
  `agentqs source authorize <id> --client-id <cid> --client-secret <cs>
  [--origin <app-url>]` (MCP: `source_authorize`) prints the URL to approve -
  the RUNNING app at origin still receives the callback. The grant IS the stored credential (connection rule
  holds); syncs mint fresh access tokens from the refresh token automatically
  (Trakt syncs get the plugin's `<client_id>:<token>` format). Pasted access
  tokens still work but die within hours - steer users to Authorize.
- GOOGLE IS ONE CONNECTION, not three. Calendar + Gmail share ONE OAuth key
  (both plugins carry `oauth.providerKey: "google"`, so the grant lives at
  `sourceOAuth.google` and the Pipeline folds them into a single card via the
  row's `provider` tag). The user TICKS products (a tree: Google -> Gmail ->
  Inbox/Sent, `src/lib/google.ts`); the scope asked for is the UNION over what's
  ticked, so ticking Gmail RE-AUTHORIZES the same key (never a second
  credential) and the card shows `needsAuthorize` until it does. Ticking is NOT
  connecting (connection rule holds); an UNTICKED product still holds the key but
  is never due and refuses to sync ("nothing checked"). Unticking never deletes
  the credential or past rows. Removing one product (`disconnect gcal`) unticks
  it and keeps the shared key while a sibling rides it; removing the LAST forgets
  the key. Faces: web card (GET/POST `/api/google`), `agentqs google
  status|enable|disable <products>`, MCP `google_products {products|enable|
  disable}`, core `google()`. The card (`google-card.tsx`) is MOUNTED by
  `sources-panel.tsx`, which pulls every `provider === "google"` row out of the flat
  connections list and hands them to it. The card had been written but never
  rendered, so Calendar and Gmail sat in the list as two strangers with two Connect
  buttons - a lie about how many Google accounts you have. Whatever filters those
  rows out MUST render the card, or Google vanishes from the tab entirely.
  Gmail COUNTS, never reads (message IDs only ->
  `emails_received`/`emails_sent`). `gdrive_backup` speaks Google OAuth too but
  is a BACKUP TARGET, deliberately NOT in this tree.
- WHOOP unofficial (email + password, per-minute HR) is SHIPPED AND SUPPORTED -
  it is the only source of per-minute heart rate. The login lives at
  `api.prod.whoop.com/auth-service/v2/whoop/sign-in` (the deleted api-7 host is
  gone); a failure there is a NETWORK/DNS failure, never "wrong password" - the
  error says exactly that. If it stops working, FIX it; do NOT disable, hide or
  remove the row. PAYLOAD SHAPE: on `cycles/details`, recovery/HRV/resting-HR sit
  on a nested `recovery` object (`recovery_score`, `hrv_rmssd` in SECONDS ->
  x1000 for the ms column, `resting_heart_rate`); strain is `cycle.scaled_strain`,
  sleep is the longest event under `sleeps`. WHOOP moved these off the record root
  (the old flat `score`/`hrv_rmssd_milli`), and reading the stale fields yielded
  EMPTY cells - recovery, HRV and resting HR silently vanished from the daily table
  for months while strain and sleep kept landing, so the row looked like "no data".
  Both shapes parse. When a column goes quiet, suspect the payload, and make the
  FIXTURE mirror the live response (`scripts/whoop.ts`) - a fixture frozen on the
  old shape keeps the test green while production lands nothing.
  THE WINDOW IS NOT "LAST 90 DAYS". A trailing window is wrong twice over: it
  imports a sliver of a lifetime, and on an account whose strap stopped recording
  months ago it matches NOTHING - which used to land zero days and still report
  "ok", reading as "WHOOP gives no data" while the account held years of it. So:
    - FIRST import (the daily file holds nothing) -> ALL TIME. `fetchAllCycles`
      discovers the account's start by walking back in 180-day windows until 2 in a
      row are empty (WHOOP exposes no "created at"). The walk STARTS at the
      account's newest cycle, not at today - a dormant account would otherwise burn
      the empty-window budget before reaching any data. Judge emptiness on IN-RANGE
      cycles only: WHOOP answers a window it has nothing for with its newest cycles
      anyway, so counting the raw response walks back to 2015 every time.
    - afterwards -> resume from the last recorded day (minus a week of overlap),
      never from today minus 90.
    - `--days N` / `{days}` -> exactly that window, honoured as asked.
    - `--all-time` / `{allTime:true}` (CLI, MCP `sync`, POST /api/import/whoop)
      forces a full backfill on a record that was seeded with only a recent slice.
  Per-minute HR stays capped at `hrDays` (14) - years of it is gigabytes - but it
  hangs off the LAST DAY THAT HAS DATA, not off today, or a dormant account pulls an
  empty minute stream while its cycles land fine. Belt and braces: a non-all-time
  window that normalizes to zero days re-anchors onto `latestCycle`
  (`reanchored` on the summary), and a sync that lands ZERO days THROWS, naming the
  account's newest cycle - landing nothing is never success. MULTI-ACCOUNT: two athletes connect as "whoop" + "whoop-2",
  each its own login (`config.whoopCredsByInstance`), daily file, per-minute dir
  (`record/<id>/hr`) and schedule - CLI `whoop connect <email> <pass> --account
  whoop-2`, MCP `whoop_connect {account}`, web "Add another account", API POST
  `/api/import/whoop?instance=whoop-2`. The base account keeps id "whoop". Do not
  confuse with `whoop-api` (the OFFICIAL OAuth plugin) - `/^whoop-\d+$/` is the
  unofficial-instance test, so `whoop-api` is never treated as one.
- ⛔ NO SOURCE MAY HARDCODE A WINDOW. This bug shipped FOUR times - WHOOP, every
  plugin, GitHub, and the local file importers each carried their own trailing "last
  90 days", and each one silently truncated a lifetime. There is now ONE rule, in ONE
  place (`syncWindow` -> `discoverStart`/`backfillPlugin`, cli-core), and
  `syncSourceInner` holds no trailing default for a new source to reach for.
  `sync:test` scenario 6 FAILS if one reappears. A file gets read WHOLE (it is finite
  and already on disk - clipping your own Chrome history to 90 days throws away years
  that were sitting right there).
- ⛔ NOTHING MAY BE SILENTLY PARTIAL. The bug class that ate this codebase, four
  ways at once. It never errors, never looks empty, and every test stays green -
  the record just quietly holds a fraction of a life. `npm run truncation:test` is
  the ships-when for the CLASS; a new source that truncates fails THERE instead of
  being found by the user opening the app. The four:
    - PAGE TO THE END. 13 of 18 importers read one page and treated it as the whole
      answer (Last.fm: 200 of a year's ~10,000 scrobbles; Strava: the newest 200 per
      year, so Jan-Aug of every year did not exist; Calendar stopped mid-year).
      Every source uses `pageAll` (plugin.ts) - a short page or a missing cursor ends
      the walk, and running out of PAGES THROWS rather than landing a partial history
      as if it were whole. `windowChunks` is its sibling for an API that refuses a
      long RANGE (Todoist, Toggl: ~3 months). WHY IT SURVIVED EVERY TEST: every
      fixture was a single-page blob, so a plugin that COULDN'T page passed exactly
      like one that could. `scripts/paging-fixtures.ts` serves TWO pages in each
      API's own protocol - a plugin that ignores the cursor can only see page one.
    - AN API CEILING IS SPLIT, NOT BELIEVED. GitHub's Search API serves 1,000
      results per query; we asked for 12 years, took the oldest 1,000, and
      `densify()` zero-filled the rest of the window STRAIGHT OVER the real history
      (`date,0` across nine years, reported ok). A window the API cannot answer whole
      is halved and asked again.
    - A PARTIAL VIEW NEVER LOWERS A FULLER ONE. `plugin.mergePolicy: "max"` for a
      source that recomputes a day from a RECENCY BUFFER it can only ever see part of
      (spotify, deezer, swarm, mastodon, notion - last ~50 plays, no date range).
      Replacing meant every day DECAYED as the buffer slid past it, and an imported
      lifetime export was eaten by the first sync that touched one of its days.
      Counts only - a gauge (weight, recovery) still replaces.
    - A ZERO IS NOT A MEASUREMENT. Fitbit's API zero-fills every day in a range,
      including years before the account existed. Writing those made the record
      assert you walked 0 steps a day in 2003, AND made the walk immortal (invented
      zeros look like data). A day the source says nothing about lands NO ROW (Gmail
      does the same).
- THE SYNC WINDOW COMES FROM THE RECORD, never from a constant (`syncWindow` in
  cli-core - the one rule, every source): `--days N` -> exactly that; record EMPTY
  -> the FIRST import DISCOVERS its range: `backfillPlugin` walks back a year at a
  time, floor 2000-01-01. NEVER pick a constant: 5 years of a calendar gave 1,077
  days, 10 gave 1,824, and its history actually began at 1,891 - every number clips
  days the user never learns are missing;
- ⛔ A GAP IN A LIFE IS NOT THE END OF ONE. The walk USED to stop after 2 empty
  chunks, reading an empty year as "the source ran dry". But a life is not a tidy
  run of activity ending in silence - it has GAPS. Two quiet years is a job change,
  a broken strap, a phone you stopped carrying. The walk hit the gap, decided the
  history ended there, and never asked about anything older: everything before it was
  unreachable by ANY command, forever, and the sync said ok. (Gmail: mail in 2026 and
  in 2019, three quiet years between -> it never asked about anything before 2023.)
  So the walk now goes ALL THE WAY TO THE FLOOR, with no early exit - in
  `backfillPlugin`, `discoverStart` AND WHOOP's own walk, which gave up after ONE
  quiet year while its comment called that "long enough to stride over a break from
  the strap" (an injury is longer). `plugin.hasAnyData` keeps it cheap: ONE question
  per year for a source where FETCHING a year is expensive (Gmail counts a day at a
  time - walking 26 years to check for gaps would be 19,000 requests; now it is 26).
  Do not re-add an empty-chunk counter. Any number there is the same bug waiting for
  a longer gap.
- A FIRST IMPORT THAT LANDS NOTHING THROWS. A revoked Calendar scope answers
  `200 {items:[]}`, so every sync landed zero rows, the ledger went green, the row
  said "synced 2 minutes ago", and the calendar quietly stopped recording for months.
  A LATER sync landing zero days is fine (a quiet week); an EMPTY record that just
  walked its whole history and came home with nothing is not.
  record has rows -> resume from the last recorded day minus a week of overlap.
  Every source used to send a flat trailing `windowDays(90)`, which is wrong twice
  over: it lands a sliver of a lifetime, and because every LATER sync re-asks for
  that same 90 days, the years before it are never fetched even once - a source is
  capped forever at whatever its first sync happened to catch.
  `plugin.backfillDays` exists for an API with a REAL hard ceiling - and NO SHIPPED
  PLUGIN SETS IT (`sync:test` fails if one does). SLOW IS NOT A CEILING. Gmail set
  it to 400 because it counts one day at a time (two searches per day), and that
  number was a lie told forever: the first import took the last 400 days, every
  later sync resumed from the NEWEST recorded day, and `--days 3000` was sliced
  straight back to the same recent 400 - there was no command that could reach
  2019, so the record simply reported that your mail began the year you connected
  it. The cost was never Google's limit (its quota allows ~50 list calls/sec), it
  was our patience: the walk was SERIAL. Gmail now fans its days out (`mapPool`,
  8 in flight) and takes the same backward walk as everything else, warning in
  `historyNote` that a first import runs for minutes. Reach for `backfillDays`
  only when the API itself refuses to go further - never to save yourself work.
  A source whose API ignores dates (Spotify returns your last ~50 plays, no date
  range) must keep a WIDE window: it is a client-side filter, so narrowing it
  DISCARDS those plays whenever you have not listened recently. `historyNote` is
  where an API's hard ceiling is explained, so it never reads as a broken importer.
- WHERE AN API HAS NO HISTORY TO GIVE, THE EXPORT IS THE HISTORY. Spotify's
  `recently-played` serves ~50 plays and takes no date range, so `spotify` can only
  ever show a few DAYS - no window fixes that, because the endpoint has no answer.
  The account export does (Privacy Settings -> Extended streaming history), and its
  importer lands in the SAME `spotify` daily source with the SAME `tracks`/`minutes`
  columns (`source file spotify`), exactly as Apple Health backfills `health_daily`.
  So ONE Spotify row shows the lifetime and the API sync keeps its recent end fresh.
  A file importer whose id matches a plugin id BACKFILLS that plugin and gets no row
  of its own (`buildSources`) - a second row would split one Spotify in half and ask
  for a credential the source already has. Landing that history under a different
  name (`spotify_history`) is the bug this replaces: the real source still read
  "3 days" while the years sat beside it under a stranger's name.
- A source sync PATCHES the cache (`refreshSyncCache`), never rebuilds it: a full
  rebuild re-reads the whole record (events.jsonl alone can be hundreds of MB)
  and rewrites the DB synchronously, which blocks every other request for
  minutes on a real record - a 50-track Spotify pull once took the hosted app
  down that way. Only `agentqs rebuild` (and the first import, when no cache
  exists) rebuilds. Anything landing rows in the record must patch the cache the
  same way.
- Hosted instances: the app is behind a reverse proxy, so an absolute URL must
  come from the FORWARDED headers (`requestOrigin`, src/lib/request-origin.ts) -
  Next's standalone server builds `req.url` from HOSTNAME+PORT, and an OAuth
  callback that trusts it redirects the user to `https://0.0.0.0:3000`. The
  Docker image is Debian (glibc), NOT alpine: onnxruntime (local embeddings /
  `recall`) has no musl build, and `backup github` needs the real `git`.
- Importer HTTP goes through `netFetch` (plugin.ts): it retries a transient
  network failure (a cold container's first DNS lookup) and names the real cause
  instead of undici's bare "fetch failed", which reads like a bad credential.
- `agentqs source test <id> [credential]` - prove a credential against the real
  API (one probe, nothing saved). `source connect` runs it first, so only a
  WORKING key is ever stored; the web connect + POST `/api/import/<id>` do the
  same (`{"test": true}` probes without saving). MCP tool: `source_test`.
- `agentqs sync <source> --credential <key>` - API sources use THEIR OWN service keys.
- Web-triggered syncs run as BACKGROUND JOBS (one serial queue, state in
  `<dataDir>/sync-jobs.json`): POST `/api/import/<id>` returns 202 + the job;
  GET reports its live phase/pct — refreshing the page never kills an import.
  A job whose heartbeat goes silent reads back as an interrupted error.
- ⛔ A CONNECTION NEVER LIES (`npm run connection:test`). The second bug class:
  not missing data, data that LOOKS fine.
    - AN APP KEY IS NOT A LOGIN. A `sourceOAuth` entry holding only a clientId +
      secret is the APP KEY, saved before anyone signed in - it is NOT a connection.
      Onboarding counted it with `Object.keys(sourceOAuth)` and ticked "connect a
      source: done" for someone who had connected nothing. A grant counts only if it
      holds `accessToken || refreshToken` (which `connectionState` already knew).
    - TEST THE CREDENTIAL A SYNC WOULD ACTUALLY USE. `source test` gated on the RAW
      instance slot instead of `oauthGrantKey`, so Google never matched (its grant is
      at `sourceOAuth.google`) and it tested a stale token: every Google test more
      than an hour after connecting failed on a healthy connection.
    - A PASTED TOKEN RESCUES A REVOKED GRANT. Precedence is grant -> env ->
      sourceCreds, so once a grant existed the pasted token the connect form OFFERS
      was unreachable: it tested green, saved fine, and every sync still died on the
      dead grant. A failed refresh now falls back to what the user pasted.
    - AN UNTICKED PRODUCT REFUSES TO SYNC ON EVERY DOOR. The tick was enforced only
      in the `due` flag, so the cron obeyed it and `agentqs sync` / POST
      `/api/import/gcal` pulled an unticked Calendar anyway. The guard belongs in
      `syncSource`, where every face goes through.
- ⛔ A DAY IS THE DAY YOU LIVED IT, never the day UTC was having. Eight importers
  bucketed by `new Date(ts).toISOString().slice(0, 10)`, so a New Yorker's 9pm film,
  7pm check-in and evening browsing (all past midnight UTC) were filed on TOMORROW,
  and an Israeli's 1am music on YESTERDAY. Every correlation over those days was then
  comparing the wrong ones - "does late-night browsing hurt my next-day recovery?" was
  a day against ITSELF. Use `localDay(instant, tz)` (plugin.ts); the zone is
  `recordTimeZone()` = `config.timezone` or this machine's (`agentqs config set
  timezone Asia/Jerusalem` - SET IT ON A HOSTED INSTANCE, whose server clock has
  nothing to do with where the user lives). A source that ships its OWN offset
  (Swarm's `timeZoneOffset`, Withings' `timezone`) uses that instead - it is where the
  user physically was. Strava (`start_date_local`), whoop-api and Apple Health already
  did this deliberately; copy them, not the eight that did not.
- A DATE IS NOT ASSUMED. Slashed dates were ALL read as US M/D, so a European export
  silently misfiled half its rows (05/07/2026 is 5 July; it landed on 7 May) and the
  other half became impossible dates (`2026-31-01`) that merged anyway. A cell cannot
  be read alone; a COLUMN gives itself away (`detectDateOrder` - one value over 12
  settles it). Genuinely undecidable -> keep the US reading and SAY it was a guess.
- THE connection rule: connected ⇔ a stored credential (user-saved or env).
  Data in the record NEVER implies connected. A detected desktop-app login
  (Granola) is a hint only — it never syncs; the Pipeline tab's "Connect (use
  detected app)" imports it as a saved credential. There is NO keyless connect
  on any surface (CLI/MCP/API); never mark or treat a source as connected
  without a stored key.
  Every row therefore carries `provenance` (`src/lib/sources.ts`) — the honest
  answer to "connected to WHAT?": `credential` (a key is stored: it has an
  account, it syncs, it is due — the ONLY thing badged "Connected"), `local-file`
  (Chrome/Safari/Health: re-reads a file on THIS machine, no key, no account),
  `imported` (a dropped CSV, an unpacked archive, an extension scrape, an agent
  import — history in the record that nothing syncs), `automation` (a recorded
  recipe). `buildSources` derives it centrally, so a new row cannot forget it.
  This rule was violated in the CORE, not just the UI: `recordSourceRows` and
  `bundleRow` hardcoded `connected: true` and `fileSourceRow` set it from
  `hasRows()`, so every CSV the user ever dropped read back as a live, authorized
  integration — 31 fake "connections" against 3 real ones on the author's own
  record. If you add a row, gate its manage controls on `hasData`, never on
  `connected`: imported data is removable and filterable, it is just not a
  connection.
- `agentqs sync --due` - the crontab mode: runs every source whose interval
  (`agentqs source interval <id> hourly|daily|weekly`, or set in Pipeline) says it's
  due - API sources AND browser automations. One crontab line = auto scraping.
- `agentqs pipeline` - the data-pipeline truth table: per source, how data
  arrives, credential provenance (`saved` = user-connected, `discovered` =
  auto-detected from a local desktop app), schedule, scheduler presence
  (launchd/crontab), last run outcome (failures included, from the sync-run
  ledger) and landed coverage. Answer "is X actually connected/working?" from
  here, never from row presence. MCP tool: `pipeline`; API: GET `/api/pipeline`.
  The Pipeline TAB shows the same facts per row and is the user's way in: every
  row carries a Connected badge, its `coverage` (days/events/range, counted from
  the cache by `coverageBySource` in `src/lib/daily.ts` - the ONE query both the
  tab and this report read) and its last sync. A row with data IS the link to that
  data: clicking it opens `/journal?source=<id>` filtered to that source. So
  `coverage` rides `SourceView` from `buildSources` - anything adding a row
  supplies it, or the row silently claims "no data yet".
  `account` (WHICH login a row is authorized as) is on `SourceView` but is only
  populated by WHOOP, which knows its login email (`source-registry.ts`). Every
  other row leaves it null, so TWO SPOTIFY LOGINS ARE STILL TWINS - a second
  account of the same service is indistinguishable in the list. Filling it needs a
  per-provider identity fetch (Spotify `/v1/me`, Strava `/athlete`, …) at connect
  time, cached on the grant; it is unbuilt, not broken. Do not read this paragraph
  as a shipped feature.
- `agentqs source reset <id>` - WIPE WHAT A SOURCE LANDED, KEEP ITS CONNECTION:
  drops `record/daily/<id>.csv`, the events it wrote and (for WHOOP) its per-minute
  HR, clears only its last-sync stamp, rebuilds the cache - and KEEPS the
  credential, the OAuth grant, the schedule, the automation recipe and every saved
  graph pointing at it. The next `sync <id>` then sees an empty record for it
  (`syncWindow` reads the RECORD, so an empty file IS a first import) and re-walks
  its whole history into a clean file.
  ⛔ THIS IS THE ONLY WAY TO UNDO AN IMPORTER BUG, because fixing the importer does
  NOT fix the record. A sync MERGES into the daily file: it can raise a value, but
  it can never delete a row the corrected importer no longer writes AT ALL. So what
  survives a re-walk is exactly the INVENTED rows - GitHub's `densify()` zeros on
  days that had no commits, a UTC-bucketed row filed on a day the user did not
  live, a count decayed by a recency buffer. Only starting the file empty clears
  them. `disconnectSource` starts it empty too but also FORGETS THE CREDENTIAL, so
  cleaning a poisoned Google or Strava used to mean re-running the whole OAuth
  dance just to drop bad rows; reset is the same wipe with the key left in. The
  repair loop is two commands: `agentqs source reset <id>` then `agentqs sync <id>`
  (add `--all-time` where the source takes it). MCP tool: `reset_source`; API: POST
  `/api/sources` `{"id":"<id>","action":"reset"}`. `npm run reset:test` proves both
  halves: that a re-walk alone leaves the poison, and that reset clears it without
  costing the key.
- `agentqs rebuild` - rebuild the SQLite cache from the record (deterministic).
- `agentqs journal | sources | automation | photos | skill | config` - see `--help`.

## Conventions

- ⛔ NEVER REMOVE, DISABLE, HIDE OR "RETIRE" A FEATURE. Not a source, not a row,
  not a button, not a flag - no matter what a comment, a doc or this file claims
  about it being dead. A broken feature gets FIXED. If you truly believe it must
  go, STOP AND ASK; only the user decides. Deleting a feature because fixing it
  is hard, or because some note says it is retired, is the single worst thing you
  can do here: it is the user's data pipeline, and "it works for me" beats every
  assumption you have. (This rule exists because WHOOP unofficial - the ONLY
  per-minute HR source - was ripped out on the strength of a stale note while the
  user was actively using it.)
- A failure is not a verdict on the feature. Report what actually failed
  (network/DNS vs 401 vs schema change) and fix THAT. Never let an unreachable
  host surface as "wrong password", and never let one broken environment
  (a hosted container) condemn a source that works elsewhere (the user's laptop).
- The record is the source of truth; the DB is a rebuildable cache. Never edit the
  DB directly - write through the CLI/core so undo metadata stays correct.
- `npm run rebuild:verify` must stay green (byte-identical rebuilds).
- Tests: `npm run files:test`, `npm run scan:test`, `npm run extension:test`,
  `npm run paths:test`, `npm run store:test`.
- Typecheck with `npx tsc --noEmit`; build with `npm run build`. ⚠ `npm run build`
  writes `.next` - the SAME dir a running `next dev` serves from - so building
  while the user's dev server is up replaces its chunks with production output and
  every `/_next/static/...` 404s: the page loads but never hydrates, so the client
  panels (the whole Pipeline list) silently render nothing. It looks exactly like
  "you broke the UI". Pass `NEXT_DIST_DIR=.next-verify` (or `.next-e2e`, what
  `log:test` uses) for any build or verify server you spin up while dev is running.

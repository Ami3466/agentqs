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
- `agentqs source file chrome|safari|iphone|health_daily` - local file
  importers. `health_daily` streams the iPhone Health app's export
  (export.zip / export.xml; Health -> profile -> Export All Health Data) and
  backfills the existing health_daily table - lifetime by default, device-
  deduped (iPhone + Watch never double-count). `safari` reads
  ~/Library/Safari/History.db (needs Full Disk Access). CLI/MCP/daemon only,
  deliberately no API route: these read files on YOUR disk, which the web
  server can't reach; the web face for files is the dropzone.
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
- THE SYNC WINDOW COMES FROM THE RECORD, never from a constant (`syncWindow` in
  cli-core - the one rule, every source): `--days N` -> exactly that; record EMPTY
  -> the FIRST import DISCOVERS its range: `backfillPlugin` walks back a year at a
  time until the source runs dry (2 empty chunks), floor 2000-01-01. NEVER pick a
  constant: 5 years of a calendar gave 1,077 days, 10 gave 1,824, and its history
  actually began at 1,891 - every number clips days the user never learns are
  missing. `plugin.backfillDays` is a HARD CAP for an API that cannot walk (Gmail
  counts a day at a time, 400/run), not a default;
  record has rows -> resume from the last recorded day minus a week of overlap.
  Every source used to send a flat trailing `windowDays(90)`, which is wrong twice
  over: it lands a sliver of a lifetime, and because every LATER sync re-asks for
  that same 90 days, the years before it are never fetched even once - a source is
  capped forever at whatever its first sync happened to catch. Lower `backfillDays`
  ONLY where the API itself refuses to go further (Gmail counts a day at a time,
  max 400/run) and say why in `historyNote`. A source whose API ignores dates
  (Spotify returns your last 50 plays, no date range) must keep a WIDE window: it
  is a client-side filter, so narrowing it DISCARDS those plays whenever you have
  not listened recently. `historyNote` is where an API's hard ceiling is explained,
  so it never reads as a broken importer.
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
  row carries a Connected badge, its `account` (which login it is authorized as -
  two WHOOP athletes are otherwise twins), its `coverage` (days/events/range,
  counted from the cache by `coverageBySource` in `src/lib/daily.ts` - the ONE
  query both the tab and this report read) and its last sync. A row with data IS
  the link to that data: clicking it opens `/journal?source=<id>` filtered to that
  source. So `coverage`/`account` ride `SourceView` from `buildSources` - anything
  adding a row supplies them, or the row silently claims "no data yet".
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

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
- WHOOP unofficial (email + password, per-minute HR) is RETIRED upstream -
  api-7.whoop.com no longer exists, so NO face takes a password any more:
  `whoopConnect` / POST `/api/import/whoop` refuse with the retired message, the
  row renders as a headstone (kept data + Remove, no form) and the scheduler
  never runs it. Don't debug the password. Use the official whoop-api row.
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
- `agentqs sync --due` - the crontab mode: runs every source whose interval
  (`agentqs source interval <id> hourly|daily|weekly`, or set in Pipeline) says it's
  due - API sources AND browser automations. One crontab line = auto scraping.
- `agentqs pipeline` - the data-pipeline truth table: per source, how data
  arrives, credential provenance (`saved` = user-connected, `discovered` =
  auto-detected from a local desktop app), schedule, scheduler presence
  (launchd/crontab), last run outcome (failures included, from the sync-run
  ledger) and landed coverage. Answer "is X actually connected/working?" from
  here, never from row presence. MCP tool: `pipeline`; API: GET `/api/pipeline`.
- `agentqs rebuild` - rebuild the SQLite cache from the record (deterministic).
- `agentqs journal | sources | automation | photos | skill | config` - see `--help`.

## Conventions

- The record is the source of truth; the DB is a rebuildable cache. Never edit the
  DB directly - write through the CLI/core so undo metadata stays correct.
- `npm run rebuild:verify` must stay green (byte-identical rebuilds).
- Tests: `npm run files:test`, `npm run scan:test`, `npm run extension:test`,
  `npm run paths:test`, `npm run store:test`.
- Typecheck with `npx tsc --noEmit`; build with `npm run build`.

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
   - only facts explicitly stated in the note; nothing worth structuring -> skip
     the item (it stays as a searchable memo) or discard it.
3. `agentqs structure --id <id> --csv '<csv>'` (or `--csv-file <path>`).
   The product validates, merges into `record/daily/`, marks the item structured,
   and records exact undo metadata. `agentqs log reject <id>` reverts it.

MCP equivalents: `inbox_pending` -> `structure {id, csv}`.

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

- `agentqs import <file>` - land any file; clean CSV structures instantly.
- `agentqs doctor` - store health: is the store inside a sync-engine domain
  (iCloud/Dropbox/OneDrive), any cloud-evicted files, "X 2" conflict twins,
  split stores. Exit 1 when unsafe. MCP tool: `doctor`; API: GET `/api/doctor`.
- `agentqs migrate-store [--to <dir>] [--dry-run]` - move the store to the
  sync-safe app-data dir: hash-verified copy, source retired (never deleted),
  launchd/crontab re-pointed. Stop the app first, restart after. MCP:
  `migrate_store`; API: POST `/api/store/migrate`.
- `agentqs scan [--fix]` - data-quality scan: duplicate daily columns (one
  metric imported manually AND by a sync), dead all-zero columns, and messy
  numeric values (units, thousands separators, junk placeholders). Findings
  queue as inbox notifications (kind `notification`, shown in Pipeline -> Data
  quality); structuring one applies the fix - merges keep the auto-synced
  column and save a rule so future imports stay merged. MCP tool: `scan`.
- `agentqs source file chrome|iphone` - local file importers.
- `agentqs source guide <id>` - HOW to connect a source: where its credential
  comes from, step by step, with the start URL. Relay these steps when the user
  asks how to connect something. MCP tool: `source_guide`; the web connect form
  shows the same guide (it lives once, on the plugin's `credentialHelp`).
- OAuth sources (spotify, gcal, fitbit, strava, whoop-api - expiring tokens):
  connect via the authorize dance in the web app - the form shows the redirect
  URI to register, takes the user's app client id + secret (POST
  `/api/oauth/<id>` -> authorize URL -> GET `/api/oauth/callback` stores the
  grant). The grant IS the stored credential (connection rule holds); syncs
  mint fresh access tokens from the refresh token automatically. Pasted
  access tokens still work but die within hours - steer users to Authorize.
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

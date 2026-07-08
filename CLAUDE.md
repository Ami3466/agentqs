# agentqs - agent guide

agentqs is a local-first personal data journal: plain-text record (`record/daily/*.csv`,
`inbox.jsonl`, `events.jsonl`, `sessions.jsonl`) -> deterministic SQLite cache -> web app,
CLI, MCP and JSON API, all driving the same core (`src/lib/cli-core.ts`).

## You are the AI - no API key needed

Every action works through the CLI (`npm run cli -- <command>`, or `agentqs <command>`
after `npm link`) or the MCP server (`agentqs serve --mcp`) with NO in-app AI key.
Where the GUI would call a model (structuring prose, chat), YOU do the reasoning and
hand the product deterministic input. Never ask the user for an API key for these flows.

Data lives in `./data` by default; override with `AGENTQS_DATA_DIR=<dir>`.
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
  value_num,value_text)`, `raw_inbox`, `sessions`, `events`, `search` (FTS).
- `agentqs recall "<feeling or situation>"` - local semantic search over memos,
  sessions and journal text (on-device embeddings, no key).
- Combine both, then answer in your own words with the numbers cited.

### Everything else (already key-free)

- `agentqs import <file>` - land any file; clean CSV structures instantly.
- `agentqs source file chrome|iphone` - local file importers.
- `agentqs sync <source> --credential <key>` - API sources use THEIR OWN service keys.
- `agentqs rebuild` - rebuild the SQLite cache from the record (deterministic).
- `agentqs journal | sources | automation | photos | skill | config` - see `--help`.

## Conventions

- The record is the source of truth; the DB is a rebuildable cache. Never edit the
  DB directly - write through the CLI/core so undo metadata stays correct.
- `npm run rebuild:verify` must stay green (byte-identical rebuilds).
- Tests: `npm run files:test`, `npx tsx scripts/google-activity-extension-test.ts`.
- Typecheck with `npx tsc --noEmit`; build with `npm run build`.

/**
 * The ONE brain for the HTTP API surface — every door, what it does, and its CLI +
 * MCP equivalents so an agent knows the SAME capability across faces.
 *
 * This lives in `lib` (not a React component) on purpose: it is served verbatim at
 * `GET /api` as a machine-readable discovery manifest. An agent's first call maps the
 * whole surface and routes correctly, instead of guessing (asking /api/chat to run
 * analysis, or POSTing to a /api/query that used to not exist). The Settings → API
 * tab renders this same array, so the human doc and the agent manifest never drift.
 *
 * Keep `cli`/`mcp` filled in wherever a face exists — the cross-face map is the point.
 */
export interface ApiEndpoint {
  method: string;
  path: string;
  body?: string;
  desc: string;
  /** The equivalent `agentqs …` command, if any. */
  cli?: string;
  /** The equivalent MCP tool name, if any. */
  mcp?: string;
}

/**
 * Read FIRST. The routing rules that stop an agent going through the wrong door —
 * the mistakes that read as "the product is broken" when it is just the wrong call.
 */
export const API_ORIENTATION = [
  "agentqs is a local-first data journal: plain-text record → SQLite cache → this API. No in-app AI key is needed; YOU are the model. Every capability here also exists as a CLI command (`agentqs <cmd>`) and an MCP tool (`agentqs serve --mcp`) — the `cli`/`mcp` field on each endpoint is the same capability on another face.",
  "ANALYSIS IS SQL, NOT CHAT. Every real question — a date range, a multi-metric join, a 20-year trend, raw rows — is a SELECT via POST /api/query. `/api/chat` is only a grounded one-liner and, with no AI key, a single canned correlation; asking it for analysis returns the same answer every time. Use /api/query (or the MCP `query` tool) for anything real.",
  "SEMANTIC RECALL is POST /api/search (the `recall` capability): cross-lingual search over memos, sessions and journal text, no key. It is named `search` on HTTP but `recall` on the CLI/MCP.",
  "CONNECT A SOURCE = store a working credential. POST /api/import/{source} tests the key against the real API first, then syncs as a background job (202 + job; poll GET). Data in the record NEVER implies connected. Heavy reads/imports run off the main thread or as background jobs, so a big pull never wedges the server.",
  "Mutating routes need the bearer key (Authorization: Bearer …), minted in Settings → API or GET /api/keys. This manifest and other read shapes are public so an agent can orient before authenticating.",
].join("\n\n");

export const API_CATALOG: ApiEndpoint[] = [
  { method: "POST", path: "/api/query", body: `{"sql":"SELECT ...","limit":500}`, cli: "agentqs query \"<SELECT ...>\"", mcp: "query", desc: "Read-only SQL over the cache — the full analytical door (arbitrary date ranges, multi-metric joins, raw rows). GET this same path FIRST for the live schema + metric catalog + query recipes. `daily` is LONG format: metric names (recovery, steps, …) are VALUES in the `metric` column, not columns — read one with WHERE metric='recovery', pivot several with MAX(CASE WHEN metric='x' THEN value_num END). Tables: daily(date,source,metric,value_num,value_text), raw_inbox, sessions, events, search (FTS); detail.* when present. SELECT/WITH only, capped at 50k rows (paginate with LIMIT/OFFSET), runs on a worker thread with a timeout. For anything beyond a grounded one-liner, USE THIS, not /api/chat." },
  { method: "GET", path: "/api/query", cli: "agentqs journal", mcp: "journal", desc: "Self-describe the record: schema + LIVE metric catalog (every metric with source, day-count, span) + sources + date range + copy-paste query recipes. Call this before writing SQL so you never guess a column name." },
  { method: "POST", path: "/api/chat", body: `{"message":"…"}`, cli: "agentqs chat \"<message>\"", mcp: "chat", desc: "Ask your record in natural language — a grounded one-liner with sources. Without an AI key this is a single deterministic correlation, NOT a query engine: for real analysis (ranges, joins, trends, raw rows) use POST /api/query." },
  { method: "POST", path: "/api/search", body: `{"query":"…","limit":5}`, cli: "agentqs recall \"<feeling or situation>\"", mcp: "recall", desc: "Semantic recall (the `recall` capability): cross-lingual on-device search over memos, sessions and journal text — closest days plus a ready grounded answer. No AI key. Named `search` on HTTP, `recall` on CLI/MCP." },
  { method: "POST", path: "/api/inbox", body: `{"text":"…"}`, cli: "agentqs inbox", mcp: "inbox_pending / inbox_resolve", desc: "Log a capture to the inbox — zero tokens. GET lists pending captures; DELETE discards one; PATCH {id} keeps one as a searchable reference memo." },
  { method: "POST", path: "/api/structure", body: `{"id":"…","csv":"date,…"}`, cli: "agentqs structure --id <id> --csv '<csv>'", mcp: "structure", desc: "Structure a pending capture into daily rows. Pass csv with the extracted date,… rows to structure key-free — YOU do the extraction, the product validates + merges + records undo. Or pass all:true to use a configured AI key." },
  { method: "POST", path: "/api/scan", body: `{}`, cli: "agentqs scan [--fix]", mcp: "scan", desc: "Scan data quality: duplicate columns, dead all-zero columns, messy values; findings queue as inbox notifications. GET lists open findings; fix:true applies them all." },
  { method: "GET", path: "/api/journal", cli: "agentqs journal", mcp: "journal", desc: "Per-day view of the cache: metrics pivoted to columns plus memos/sessions per day (?days=30, ?days=all, ?days=0 for metadata, ?numeric=1)." },
  { method: "POST", path: "/api/journal/edit", body: `{"edits":[…]}`, cli: "agentqs journal-edit '<edits>'", mcp: "journal_edit", desc: "Edit the daily table — set/clear cells, drop rows or columns. Revertible from the Log." },
  { method: "GET", path: "/api/daily", cli: "agentqs query", mcp: "query", desc: "The structured daily table (or query it directly via /api/query)." },
  { method: "GET", path: "/api/events", cli: "agentqs query", mcp: "query", desc: "Raw timeline events (?start=YYYY-MM-DD&end=…&limit=500)." },
  { method: "GET", path: "/api/log", cli: "agentqs log", mcp: "log_list / log_reject", desc: "Captured log items; POST /api/log/reject {\"id\":\"…\"} undoes an import." },
  { method: "GET", path: "/api/sources", cli: "agentqs sources / source …", mcp: "sources / set_interval / reset_source / disconnect_source", desc: "Every source and its sync state. POST sets an interval; POST {\"id\":\"…\",\"action\":\"reset\"} wipes what a source landed but KEEPS its credential and schedule, so the next sync re-walks its whole history into a clean file (the repair path for rows a buggy importer invented — a sync only merges, so it can raise a value but never delete one); DELETE disconnects, taking the credential with it." },
  { method: "GET", path: "/api/pipeline", cli: "agentqs pipeline", mcp: "pipeline", desc: "Pipeline truth table: per-source origin, credential provenance, schedule, last run outcome, coverage. Answer 'is X actually connected/working?' from HERE, never from row presence." },
  { method: "GET", path: "/api/coverage", cli: "agentqs coverage", mcp: "coverage", desc: "The record's SHAPE at a glance: every source with total rows, distinct days, date span, and a per-year row histogram, plus the year axis and record totals (richest source first). GET this to learn what streams exist and how far back each goes before you query — the map behind the Pipeline heatmap." },
  { method: "GET", path: "/api/google", body: `{"enable":["gmail.sent"]}`, cli: "agentqs google status|enable|disable", mcp: "google_products", desc: "Google as ONE connection with a product tree (Calendar, Gmail → Inbox/Sent). POST {\"enable\":[…]} ticks a product; {\"products\":[…]} replaces the set. Ticking is not connecting: a product whose scope the stored key lacks answers needsAuthorize — re-authorize widens the SAME key." },
  { method: "GET", path: "/api/doctor", cli: "agentqs doctor", mcp: "doctor", desc: "Store health: sync-engine exposure (iCloud/Dropbox/OneDrive), evicted files, conflict twins, split stores." },
  { method: "GET", path: "/api/audit", cli: "agentqs audit", mcp: "audit", desc: "Index audit: deterministic evidence for an AI review — impossible dates, one-day sources, coverage holes, stale sources, outlier values. YOU judge each finding and fix through the product." },
  { method: "POST", path: "/api/store/migrate", body: `{"dryRun":true}`, cli: "agentqs migrate-store", mcp: "migrate_store", desc: "Move the store to the sync-safe app-data dir (hash-verified; restart after). Omit dryRun to migrate." },
  { method: "GET", path: "/api/onboarding", cli: "agentqs onboarding", mcp: "onboarding", desc: "The live setup checklist: every step (account → key → capture → sources → schedules → backups → channels → migrate) with its exact CLI / MCP / API call and a done flag. Agents start here." },
  { method: "GET", path: "/api/backup", cli: "agentqs backup status", mcp: "backup_status", desc: "Off-site backup status: GitHub snapshot branch + encrypted Google Drive archive — schedule, last run, last error per target, plus the live Drive upload job. Backups are data going OUT: neither target is a source." },
  { method: "POST", path: "/api/backup", body: `{"target":"github"}`, cli: "agentqs backup github|drive|restore", mcp: "backup_run / backup_restore", desc: "Run a backup now: github pushes the record snapshot branch (oversized files excluded loudly); drive encrypts the whole store and uploads one archive as a background job (202 — poll GET). Add \"schedule\":\"daily|off\" to set the cadence. target restore + confirm:\"replace-record\" pulls the newest Drive archive INTO this store — the migration path onto a fresh instance." },
  { method: "GET", path: "/api/drive", cli: "agentqs drive status / folder", mcp: "—", desc: "Drive IMPORT status: is the read-only grant connected, and which folder agentqs may read. POST {\"folderId\":\"…\",\"folderName\":\"…\"} points it at a folder ({\"clear\":true} unsets). Read-on-request, NOT a synced source — connecting grants read access; nothing lands in the record until you pull a file. Its own drive.readonly grant (`drive_import`), separate from the drive.file backup." },
  { method: "GET", path: "/api/drive/list", cli: "agentqs drive list", mcp: "drive_list", desc: "The manifest of the raw-import folder (file names, ids, mime types, sizes, dates) — read-only, nothing synced. ?folderId= defaults to the configured folder; empty lists top-level folders (to find the id). Find a file here, then POST /api/drive/pull to read it." },
  { method: "POST", path: "/api/drive/pull", body: `{"file":"<id | name>"}`, cli: "agentqs drive pull <file>", mcp: "drive_pull", desc: "Read ONE raw file (email export, message dump, PDF) from the Drive import folder ON REQUEST — the extracted text comes back for you to reason over; NOTHING lands in the record (a read, like /api/query). `file` is a Drive id, or a name / unique substring within the folder. Binary and oversize files return a described stub, not bytes." },
  { method: "POST", path: "/api/import/{source}", body: `{"credential":"…"}`, cli: "agentqs source connect <id> <cred> / sync <id>", mcp: "connect_source / sync / source_test", desc: "Connect an API source: the key is TESTED against the real API first (only a working key is saved), then the sync runs as a background job (202 + job) that survives page reloads — poll GET /api/import/{source} for its phase/progress. Pass {\"test\":true} to probe a credential without saving." },
  { method: "POST", path: "/api/oauth/{source}", body: `{"clientId":"…","clientSecret":"…"}`, cli: "agentqs source authorize <id> --client-id … --client-secret …", mcp: "source_authorize", desc: "Start the OAuth dance for an expiring-token source (spotify, gcal, fitbit, strava, whoop-api, withings, trakt): saves your provider app's credentials and returns the authorize URL. The provider redirects to GET /api/oauth/callback, which stores the tokens; syncs refresh them automatically." },
  { method: "GET", path: "/api/automations", cli: "agentqs source automation", mcp: "automation_list / automation_run / automation_add / automation_remove", desc: "Browser-import recipes. POST saves one; POST /api/automations/run replays it; DELETE removes it." },
  { method: "GET", path: "/api/skills", cli: "agentqs skill", mcp: "skill_list / skill_upsert / skill_remove / skill_restore", desc: "Mentor skills. POST adds or edits one (POST {\"restoreDefaults\":true} un-hides deleted built-ins); DELETE removes it (a built-in is hidden, restorable)." },
  { method: "GET", path: "/api/sessions", desc: "Chat/therapy/mentor sessions with their synthesized insights + commitments (the memory an agent reads for continuity — never the transcript). POST saves one KEY-FREE: send the synthesis you reasoned — {insights:[…],commitments:[…],summary?,title?,skill?} — and agentqs records it (no model call), same idea as /api/structure's csv. Or POST {messages:[…]} for agentqs to distill with its own AI key. DELETE ?id=… removes one (revertible). This closes the build-loop: an agent captures, structures, queries, then writes back what it learned." },
  { method: "GET", path: "/api/voice/session", cli: "agentqs whisper", desc: "Mint a signed voice-session token (ElevenLabs/Gemini). POST /api/voice/memo lands a spoken memo; POST /api/voice/whisper manages local transcription models." },
  { method: "GET", path: "/api/keys", desc: "The HTTP API bearer key (masked). POST rotates it; DELETE clears it. Cookie-only — a leaked bearer can't rotate itself." },
  { method: "GET", path: "/api/graphs", desc: "Saved graph definitions. POST replaces the saved set." },
  { method: "GET", path: "/api/graphs/series", desc: "Every plottable line in the record, aggregated: one shared ascending `dates` axis, then each numeric daily metric (sparse — `d` indexes into `dates`) and each per-day count (dense — `v` lines up with `dates`, no `d`). Numbers over time and nothing else, so it is a fraction of the size of the journal payload it replaced. `?catalog=1` returns keys + labels with NO numbers (what a picker needs); `?keys=a,b` returns only those lines, reindexed onto their own date axis — so a chart costs what a chart costs, not what the record weighs." },
  { method: "GET", path: "/api/embeddings", cli: "agentqs recall", mcp: "recall", desc: "Semantic index status. POST reindexes from the record." },
  { method: "GET", path: "/api/photos", cli: "agentqs photos", mcp: "photos_status / photos_import / photos_search", desc: "Photo record status. POST imports a folder; POST /api/photos/search finds photos by description." },
  { method: "POST", path: "/api/settings", body: `{"timezone":"Asia/Jerusalem"}`, cli: "agentqs config set <key> <value>", mcp: "config_set", desc: "Instance config: provider/model/key, theme, and timezone. SET timezone on a hosted instance — the record buckets each day by it, and the server clock is not where the user lives. GET returns the public (masked) config." },
  { method: "GET", path: "/api/channels/{channel}", desc: "Is the telegram / slack bot wired up? The platform webhook POSTs here." },
  { method: "GET", path: "/api/rules", cli: "agentqs rules list", mcp: "rules_list / rule_upsert / rule_remove / rule_test", desc: "Agent rules — \"when X → message me\" on a channel. X is a clock time OR a numeric threshold on a daily metric (evaluated by a plain compare in the 15-min scheduler sweep, NO AI — e.g. whoop.resting_hr > 55; a threshold is only as live as the importer behind its metric). The action is a fixed line OR an AI brief (a prompt handed to the grounded agent, its reply sent). POST upserts {channel,target,when:{kind:'time'|'threshold',…},then:{kind:'text'|'brief',…}} or {action:'test',id} to fire now; DELETE {id} removes one. Threshold rules fire on the false→true edge and re-arm when the value drops back." },
];

/** Capabilities that are deliberately NOT on the HTTP API, with the reason — so an
 *  agent that can't find them over HTTP knows to use the CLI/MCP, not that they are
 *  missing. */
export const API_OMISSIONS: { capability: string; where: string; why: string }[] = [
  { capability: "import <path> / import_tree", where: "CLI `agentqs import`, MCP `import_tree`", why: "a synchronous multi-GB filesystem walk would block the web server; the web face for files is the dropzone." },
  { capability: "local file importers (chrome, safari, health_daily, spotify, iphone)", where: "CLI `agentqs source file <id>`, MCP `sync_file`", why: "they read files on the user's own disk, which the web server can't reach." },
  { capability: "rebuild", where: "CLI `agentqs rebuild`, MCP `rebuild`", why: "a full cache rebuild re-reads the whole record and blocks for minutes; landing data patches the cache instead. Over HTTP, a source sync (background job) refreshes the cache without a rebuild." },
];

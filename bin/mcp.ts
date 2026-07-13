/**
 * agentqs MCP server — the Claude Code face of agentqs.
 *
 * Launched by `agentqs serve --mcp` (see the Connect / API bar in the app). It
 * speaks MCP over stdio and exposes the SAME core the CLI, the JSON API, and the
 * GUI call (src/lib/cli-core) as tools, so from Claude Code you can import a file,
 * connect a source, schedule and run syncs, add or edit a mentor, rebuild, query
 * your data, and chat with your grounded record — without leaving the terminal.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadEnvConfig } from "@next/env";
// Same env files as the Next server — every face must resolve the same store.
loadEnvConfig(process.cwd(), undefined, { info: () => undefined, error: () => undefined });
import * as core from "../src/lib/cli-core";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(e: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
}

async function guard(fn: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "agentqs", version: "0.1.0" });

  server.registerTool(
    "chat",
    {
      title: "Chat with your record",
      description: "Ask the grounded mentor a question. It reasons over your real daily data and cites numbers.",
      inputSchema: { message: z.string(), skill: z.string().optional() },
    },
    async ({ message, skill }) => guard(() => core.chat({ message, skill })),
  );

  server.registerTool(
    "query",
    {
      title: "SQL query (read-only)",
      description: "Run a read-only SELECT over the cache. Tables: daily(date,source,metric,value_num,value_text), raw_inbox, sessions.",
      inputSchema: { sql: z.string(), limit: z.number().int().positive().optional() },
    },
    async ({ sql, limit }) => guard(() => core.query(sql, limit)),
  );

  server.registerTool(
    "journal",
    {
      title: "Read the daily record",
      description: "Your life on one timeline: pivoted daily metrics + memos + sessions, newest first.",
      inputSchema: { limit: z.number().int().positive().optional(), source: z.string().optional() },
    },
    async ({ limit, source }) => guard(() => core.journal({ limit, source })),
  );

  server.registerTool(
    "sources",
    { title: "List data sources", description: "Every source: kind, connected, interval, last sync, stale/due.", inputSchema: {} },
    async () => guard(() => core.sources()),
  );

  server.registerTool(
    "pipeline",
    {
      title: "Data-pipeline truth table",
      description:
        "Per source: how data arrives, credential provenance (user-saved vs auto-detected local app), schedule, scheduler presence, last run outcome (failures included), and landed data coverage.",
      inputSchema: {},
    },
    async () => guard(() => core.pipeline()),
  );

  server.registerTool(
    "doctor",
    {
      title: "Store health check",
      description:
        "Is the store safe where it lives? Flags sync-engine domains (iCloud/Dropbox/OneDrive), cloud-evicted files, 'X 2' conflict twins and split stores.",
      inputSchema: {},
    },
    async () => guard(() => core.doctor()),
  );

  server.registerTool(
    "migrate_store",
    {
      title: "Move the store to a sync-safe location",
      description:
        "Copy the whole store (record + config + caches) to the platform app-data dir (or an explicit target), hash-verify, retire the source, re-point schedulers. Stop the app first; restart after.",
      inputSchema: { to: z.string().optional(), dryRun: z.boolean().optional() },
    },
    async ({ to, dryRun }) => guard(() => core.storeMigrate({ to, dryRun })),
  );

  server.registerTool(
    "sync",
    {
      title: "Sync a source now",
      description: "Run an API source (github, whoop, rescuetime, gcal, spotify). Omit source to sync all connected ones.",
      inputSchema: {
        source: z.string().optional(),
        credential: z.string().optional(),
        days: z.number().int().positive().optional(),
      },
    },
    async ({ source, credential, days }) =>
      guard(() => (source ? core.syncSource({ id: source, credential, days }) : core.syncAll(days))),
  );

  server.registerTool(
    "source_test",
    {
      title: "Test a source credential",
      description:
        "Prove a credential works against the source's real API — one authenticated probe, nothing saved. Run before source connect / sync.",
      inputSchema: { source: z.string(), credential: z.string().optional() },
    },
    async ({ source, credential }) => guard(() => core.testSourceCredential(source, credential)),
  );

  server.registerTool(
    "source_guide",
    {
      title: "How to connect a source",
      description:
        "Step-by-step guide for a source's credential: where it comes from, the start URL, and — for expiring-token providers (Spotify, Google Calendar, Fitbit, Strava) — the OAuth redirect URI the user's provider app must register. Relay these steps when the user asks how to connect something.",
      inputSchema: { source: z.string() },
    },
    async ({ source }) => guard(() => core.sourceGuide(source)),
  );

  server.registerTool(
    "sync_file",
    {
      title: "Import a local file source",
      description:
        "Tier-2 local importers that read your disk: chrome (history), safari (History.db), iphone (backup), health_daily (Apple Health export.zip/xml — lifetime by default).",
      inputSchema: { source: z.string(), path: z.string().optional(), days: z.number().int().positive().optional() },
    },
    async ({ source, path, days }) => guard(() => core.syncFileSource({ id: source, path, days })),
  );

  server.registerTool(
    "import_file",
    {
      title: "Import an arbitrary file",
      description: "The escape hatch: land any file in the record. Clean CSV structures instantly; prose waits for `structure`.",
      inputSchema: { file: z.string().optional(), text: z.string().optional(), name: z.string().optional() },
    },
    async ({ file, text, name }) => guard(() => core.importRaw({ file, text, name })),
  );

  server.registerTool(
    "import_tree",
    {
      title: "Import a whole folder, fully accounted",
      description:
        "Walk a folder and land everything: clean CSVs structure instantly, text lands raw for the structuring agent, " +
        "known formats (Takeout zips, Chrome History, iPhone backups, photos) are routed to their importer commands. " +
        "EVERY file ends in exactly one bucket; residue (files nothing claims) is returned AND persisted as a pending " +
        "inbox notification — nothing is ever silently skipped. Idempotent: re-importing the same folder adds nothing twice.",
      inputSchema: { dir: z.string() },
    },
    async ({ dir }) => guard(() => core.importTree(dir)),
  );

  server.registerTool(
    "structure",
    {
      title: "Structure pending captures",
      description:
        "Turn pending inbox items into daily rows. Omit id to drain all (clean CSV items are free; prose needs the in-app AI key). " +
        "KEY-FREE AGENT ROUTE: read one pending item via inbox_pending, extract its dated metrics YOURSELF into CSV " +
        "(first column `date` as YYYY-MM-DD, other columns snake_case metrics, one row per date — keep each fact on ITS OWN date, " +
        "never collapse a multi-date document onto the capture day), then call this with {id, csv}.",
      inputSchema: { id: z.string().optional(), csv: z.string().optional() },
    },
    async ({ id, csv }) => guard(() => core.structure({ id, csv })),
  );

  server.registerTool(
    "inbox_pending",
    {
      title: "Read pending inbox items",
      description:
        "Every capture waiting to be structured, FULL TEXT included — the input for the key-free `structure {id, csv}` agent route.",
      inputSchema: {},
    },
    async () => guard(() => core.inboxPending()),
  );

  server.registerTool(
    "inbox_resolve",
    {
      title: "Resolve a pending capture without structuring",
      description:
        "The other half of the structuring workflow, for items with no dated metrics to extract: " +
        "action \"keep\" files the capture as a reference memo (searchable + recall-able, out of the pending queue — living documents, plans, notes); " +
        "action \"discard\" drops it from the record and every index (empty or junk captures).",
      inputSchema: { id: z.string(), action: z.enum(["keep", "discard"]) },
    },
    async ({ id, action }) => guard(() => core.inboxResolve(id, action)),
  );

  server.registerTool(
    "scan",
    {
      title: "Scan data quality",
      description:
        "Scan the daily record for quality issues: duplicate columns (the same metric imported manually AND automatically), dead all-zero columns, " +
        "and messy numeric values (units, thousands separators, junk placeholders). " +
        "Each finding is queued as an inbox notification; `structure {id}` on it applies the fix (merges keep the auto-synced column and save a rule). " +
        "Pass fix=true to apply every open fix immediately.",
      inputSchema: { fix: z.boolean().optional() },
    },
    async ({ fix }) => guard(() => core.scan({ fix })),
  );

  server.registerTool(
    "audit",
    {
      title: "Audit the index (deterministic evidence for AI review)",
      description:
        "Evidence packet for an index review: impossible dates, single-day sources, coverage holes, gone-quiet sources, " +
        "outlier values — computed deterministically, no AI. YOU judge each finding (real quiet vs dead import, unit bug vs " +
        "true spike), then fix through the product: journal-edit for junk cells, re-run the named import, `scan` for duplicate " +
        "columns, or file a notification. Read-only — it never changes the record itself.",
      inputSchema: {},
    },
    async () => guard(() => core.auditIndex()),
  );

  server.registerTool(
    "backup_status",
    {
      title: "Off-site backup status",
      description:
        "Both backup targets at a glance: the GitHub snapshot branch (configured remote, schedule, last push, last error) and " +
        "the encrypted Google Drive archive (grant connected, passphrase set, schedule, last upload, last error). " +
        "Answer \"when did my data last leave this machine?\" from here.",
      inputSchema: {},
    },
    async () => guard(() => core.backupStatus()),
  );

  server.registerTool(
    "backup_run",
    {
      title: "Run a backup now",
      description:
        "target \"github\" snapshots the plain-text record and pushes it to the configured private repo (files over GitHub's " +
        "100MB limit are excluded loudly — the Drive archive covers them); target \"drive\" tars the WHOLE store, encrypts it " +
        "(AES-256-GCM with the configured passphrase) and uploads one archive via the gdrive_backup grant, rotating old ones. " +
        "Both also run on schedule (`sync --due` / the source interval) — this is the run-it-now face.",
      inputSchema: { target: z.enum(["github", "drive"]) },
    },
    async ({ target }) =>
      guard(() => (target === "github" ? core.backupGithub({}) : core.syncSource({ id: "gdrive_backup" }))),
  );

  server.registerTool(
    "backup_restore",
    {
      title: "Restore a backup archive into the live store",
      description:
        "The migration path onto a fresh instance: downloads the newest encrypted Drive archive (or takes a local file), " +
        "decrypts it, REPLACES the live record with the archive's (the previous record is retired beside the store, never " +
        "deleted), keeps this instance's own config (auth/keys/grants), and rebuilds the cache. Needs the connected " +
        "gdrive_backup grant (for latest) and the archive passphrase. confirm must be the literal \"replace-record\".",
      inputSchema: {
        confirm: z.literal("replace-record"),
        latest: z.boolean().optional(),
        file: z.string().optional(),
      },
    },
    async ({ latest, file }) =>
      guard(() => core.backupRestore({ latest: latest !== false && !file, file, intoStore: true })),
  );

  server.registerTool(
    "recall",
    {
      title: "Semantic recall (local, no key)",
      description:
        "Search memos, sessions and journal text by MEANING using the local embedding index — 'days that felt like X'. " +
        "Runs fully on-device; combine with `query` (exact numbers) to answer questions without any AI key.",
      inputSchema: { query: z.string(), limit: z.number().int().positive().optional() },
    },
    async ({ query, limit }) => guard(() => core.recall(query, limit)),
  );

  server.registerTool(
    "connect_source",
    {
      title: "Connect an API source",
      description: "Save a credential (API key / token) for an API source so it can sync.",
      inputSchema: { source: z.string(), credential: z.string() },
    },
    async ({ source, credential }) =>
      guard(async () => {
        // The connect invariant: prove the credential BEFORE storing it —
        // the same probe the CLI and API routes run.
        const probe = await core.testSourceCredential(source, credential);
        return { ...core.connectSource(source, credential), tested: probe.detail };
      }),
  );

  server.registerTool(
    "whoop_connect",
    {
      title: "Connect WHOOP (unofficial app login)",
      description:
        "Prove the WHOOP login, then store email + password to pull per-minute HR + HRV + recovery + sleep + strain. Then `sync whoop`.",
      inputSchema: { email: z.string(), password: z.string() },
    },
    async ({ email, password }) => guard(() => core.whoopConnect(email, password)),
  );

  server.registerTool(
    "set_interval",
    {
      title: "Schedule a source (automated import)",
      description: "Set a source's cadence: off | hourly | daily | weekly. API sources auto-sync when due.",
      inputSchema: { source: z.string(), interval: z.string() },
    },
    async ({ source, interval }) => guard(() => core.setInterval(source, interval)),
  );

  server.registerTool(
    "disconnect_source",
    {
      title: "Remove an automated import",
      description: "Drop a source's data, credential, and schedule so it returns to the catalog.",
      inputSchema: { source: z.string() },
    },
    async ({ source }) => guard(() => core.disconnectSource(source)),
  );

  server.registerTool(
    "automation_list",
    {
      title: "List browser automations",
      description: "Your Playwright-driven imports for sources with no API — recipe + last-run status.",
      inputSchema: {},
    },
    async () => guard(() => core.automations()),
  );

  server.registerTool(
    "automation_add",
    {
      title: "Create a browser automation",
      description:
        "Set up an import for a site with no API: a start URL, optional login, and recorded steps (goto/fill/click/waitForSelector/press/extractTable). `steps` is a JSON array; extractTable scrapes a <table> into the daily timeline.",
      inputSchema: {
        name: z.string(),
        url: z.string(),
        id: z.string().optional(),
        credType: z.enum(["userpass", "token", "none"]).optional(),
        steps: z.array(z.object({ type: z.string(), selector: z.string().optional(), value: z.string().optional() })).optional(),
        username: z.string().optional(),
        password: z.string().optional(),
        token: z.string().optional(),
      },
    },
    async (a) => guard(() => core.automationSave(a as never)),
  );

  server.registerTool(
    "automation_run",
    {
      title: "Run a browser automation now",
      description: "Replay a recipe headless: drive the browser, scrape, and land the data in the record (the cron path).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => guard(() => core.automationRun({ id })),
  );

  server.registerTool(
    "automation_remove",
    {
      title: "Remove a browser automation",
      description: "Delete an automation recipe, its secrets, its data, and its schedule.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => guard(() => core.automationRemove(id)),
  );

  server.registerTool(
    "rebuild",
    {
      title: "Rebuild the cache",
      description: "Rebuild the SQLite cache from the record. Pass verify to assert determinism.",
      inputSchema: { verify: z.boolean().optional() },
    },
    async ({ verify }) => guard(() => core.rebuildCache({ verify })),
  );

  server.registerTool(
    "config_list",
    { title: "Show settings", description: "Provider, model, masked key, theme, data dir.", inputSchema: {} },
    async () => guard(() => core.configList()),
  );

  server.registerTool(
    "config_set",
    {
      title: "Change a setting",
      description: "Set one of: provider, model, key, theme, username.",
      inputSchema: { key: z.string(), value: z.string() },
    },
    async ({ key, value }) => guard(() => core.configSet(key, value)),
  );

  server.registerTool(
    "skill_list",
    { title: "List mentors", description: "Built-in personas + your own custom mentors.", inputSchema: {} },
    async () => guard(() => core.skillsList()),
  );

  server.registerTool(
    "skill_upsert",
    {
      title: "Add or edit a mentor",
      description: "Create or update a custom persona. It answers in chat everywhere (GUI, CLI, channels).",
      inputSchema: {
        id: z.string().optional(),
        name: z.string(),
        blurb: z.string().optional(),
        system: z.string(),
      },
    },
    async ({ id, name, blurb, system }) => guard(() => core.skillUpsert({ id, name, blurb, system })),
  );

  server.registerTool(
    "skill_remove",
    {
      title: "Remove a mentor",
      description: "Delete a custom mentor by id (built-ins are protected).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => guard(() => core.skillRemove(id)),
  );

  server.registerTool(
    "photos_import",
    {
      title: "Import photos (local)",
      description:
        "Bring a folder (or the Mac Photos library) into the record: EXIF (date/GPS/camera), thumbnails, and a local CLIP embedding for text→image recall. Originals never leave the machine — only metadata is recorded.",
      inputSchema: {
        folder: z.string().optional(),
        library: z.boolean().optional(),
        since: z.string().optional(),
        caption: z.boolean().optional(),
        push: z.boolean().optional(),
      },
    },
    async ({ folder, library, since, caption, push }) =>
      guard(() => core.photosImport({ folder, library, since, caption, push })),
  );

  server.registerTool(
    "photos_status",
    {
      title: "Photos status",
      description: "How many photos are in the record, indexed for recall, geotagged, captioned, and which cameras.",
      inputSchema: {},
    },
    async () => guard(() => core.photosStatus()),
  );

  server.registerTool(
    "photos_search",
    {
      title: "Text → image recall",
      description:
        "Find photos matching a natural-language description ('beach at sunset', 'my dog') using the local CLIP index. No key, all local.",
      inputSchema: { query: z.string(), limit: z.number().int().positive().optional() },
    },
    async ({ query, limit }) => guard(() => core.photosSearch(query, limit)),
  );

  server.registerTool(
    "photo_context",
    {
      title: "Photo context for a date",
      description:
        "What the user's photos say about a stretch of time around a date — count, geotagged (out vs home), scene tags, captions.",
      inputSchema: { date: z.string(), windowDays: z.number().int().min(0).max(30).optional() },
    },
    async ({ date, windowDays }) => guard(() => core.photoContext(date, windowDays)),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe (stdout is the JSON-RPC channel).
  process.stderr.write("agentqs MCP server ready on stdio.\n");
}

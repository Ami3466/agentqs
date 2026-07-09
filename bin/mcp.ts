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
    "sync_file",
    {
      title: "Import a local file source",
      description: "Tier-2 local importers that read your disk: chrome (history), iphone (backup).",
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
    "scan",
    {
      title: "Scan for duplicate columns",
      description:
        "Find duplicated / near-duplicate daily columns — the same metric imported manually AND automatically living in two columns. " +
        "Each finding is queued as an inbox notification; `structure {id}` on it applies the merge (the auto-synced column wins and a rule keeps it merged). " +
        "Pass fix=true to apply every suggested merge immediately.",
      inputSchema: { fix: z.boolean().optional() },
    },
    async ({ fix }) => guard(() => core.scan({ fix })),
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
    async ({ source, credential }) => guard(() => core.connectSource(source, credential)),
  );

  server.registerTool(
    "whoop_connect",
    {
      title: "Connect WHOOP (unofficial app login)",
      description:
        "Store your WHOOP email + password to pull per-minute HR + HRV + recovery + sleep + strain. Then `sync whoop`.",
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

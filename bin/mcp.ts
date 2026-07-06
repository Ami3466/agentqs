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
      description: "Run an API source (github, rescuetime, gcal, spotify, whoop). Omit source to sync all connected ones.",
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
      description: "Turn pending inbox items into daily rows (CSV is free; prose uses your AI key). Omit id to drain all.",
      inputSchema: { id: z.string().optional() },
    },
    async ({ id }) => guard(() => core.structure({ id })),
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
    "set_interval",
    {
      title: "Schedule a source (automated import)",
      description: "Set a source's cadence: off | hourly | daily | weekly. API sources auto-sync when due.",
      inputSchema: { source: z.string(), interval: z.string() },
    },
    async ({ source, interval }) => guard(() => core.setInterval(source, interval)),
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe (stdout is the JSON-RPC channel).
  process.stderr.write("agentqs MCP server ready on stdio.\n");
}

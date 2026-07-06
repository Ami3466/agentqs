import readline from "node:readline";
import { mentorTools, type Used } from "./agent";

/**
 * A dependency-free MCP stdio server (JSON-RPC 2.0, newline-delimited — the MCP
 * stdio transport). It exposes the *same* three read-only tools the in-app mentor
 * agent uses (query_daily / search_notes / find_similar from src/lib/agent.ts), so
 * `claude mcp add agentqs -- agentqs serve --mcp` gives Claude Code direct,
 * read-only access to the user's real record — one brain, now with a fourth face.
 *
 * Why hand-rolled and not the MCP SDK: the transport is trivially small (line in,
 * line out) and staying dependency-free keeps the CLI installable with zero extra
 * install surface. stdout is reserved strictly for protocol frames.
 */

const PROTOCOL_VERSION = "2024-11-05";
const SERVER = { name: "agentqs", version: "0.1.0" };

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** JSON Schemas that mirror the zod inputSchemas in agent.ts — MCP clients read
 *  these to know how to call each tool. Kept in lockstep with mentorTools(). */
const TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  query_daily: {
    type: "object",
    properties: {
      sql: { type: "string", description: "A single read-only SELECT (or WITH) over the daily table." },
    },
    required: ["sql"],
    additionalProperties: false,
  },
  search_notes: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords, e.g. 'sleep tired' or 'deploy shipped'." },
      limit: { type: "integer", minimum: 1, maximum: 25 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  find_similar: {
    type: "object",
    properties: {
      query: { type: "string", description: "The feeling or situation to match, in natural language." },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

type ToolLike = { description?: string; execute?: (args: unknown, opts: unknown) => Promise<unknown> };

/**
 * Serve the MCP protocol over stdin/stdout until the client closes the pipe.
 * Blocks (resolves on EOF). Never writes anything but JSON-RPC frames to stdout.
 */
export async function serveMcp(dbFile: string): Promise<void> {
  // Guard the protocol channel: any stray console.log from a dependency (e.g. the
  // embedding model loader) must not corrupt stdout. Route it to stderr.
  console.log = (...a: unknown[]) => console.error(...a);

  const used: Used = { sources: new Set(), metrics: new Set(), hits: 0 };
  const tools = mentorTools(dbFile, used) as unknown as Record<string, ToolLike>;
  const names = Object.keys(TOOL_SCHEMAS);

  const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const reply = (id: Rpc["id"], result: unknown) => write({ jsonrpc: "2.0", id, result });
  const fail = (id: Rpc["id"], code: number, message: string) =>
    write({ jsonrpc: "2.0", id, error: { code, message } });

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;

    let msg: Rpc;
    try {
      msg = JSON.parse(text) as Rpc;
    } catch {
      continue; // ignore garbage; a malformed frame has no id to answer
    }

    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null; // notifications carry no id

    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion:
            typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER,
          instructions:
            "Read-only access to the user's own life record: query_daily runs SQL over the daily metrics table, search_notes does keyword search over memos/sessions, find_similar does semantic recall. Never invent numbers — fetch them.",
        });
        break;

      case "notifications/initialized":
      case "notifications/cancelled":
        break; // notifications: no response

      case "ping":
        if (isRequest) reply(id, {});
        break;

      case "tools/list":
        reply(id, {
          tools: names.map((name) => ({
            name,
            description: tools[name]?.description ?? "",
            inputSchema: TOOL_SCHEMAS[name],
          })),
        });
        break;

      case "tools/call": {
        const name = typeof params?.name === "string" ? params.name : "";
        const args = (params?.arguments as Record<string, unknown>) ?? {};
        const t = tools[name];
        if (!t?.execute) {
          fail(id, -32602, `Unknown tool "${name}".`);
          break;
        }
        try {
          const out = await t.execute(args, { toolCallId: `mcp-${Date.now()}`, messages: [] });
          reply(id, { content: [{ type: "text", text: JSON.stringify(out) }] });
        } catch (e) {
          reply(id, {
            content: [{ type: "text", text: `Tool error: ${(e as Error).message}` }],
            isError: true,
          });
        }
        break;
      }

      default:
        if (isRequest) fail(id, -32601, `Method not found: ${method}`);
    }
  }
}

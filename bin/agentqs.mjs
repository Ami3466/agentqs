#!/usr/bin/env node
/**
 * `agentqs` entry point. The CLI itself is TypeScript (bin/agentqs-cli.ts); this
 * thin Node shim runs it through the project's own tsx so `npm link` gives you a
 * real `agentqs` command (and a working `serve --mcp` for MCP clients) without a
 * build step. stdio is inherited, so the MCP JSON-RPC stream passes straight
 * through.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const cli = path.join(here, "agentqs-cli.ts");

const child = spawn(tsx, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  process.stderr.write(`agentqs: could not launch (${err.message}). Is tsx installed? Run npm install.\n`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * The `agentqs` binary (package.json "bin"). It runs scripts/cli.ts through tsx,
 * resolving tsx from agentqs's own dependency tree so a global install
 * (`npm link` / `npm i -g .`) works from any directory. stdio is inherited so the
 * `serve --mcp` verb speaks JSON-RPC over the real stdin/stdout.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "scripts", "cli.ts");
const passthru = process.argv.slice(2);

let child;
try {
  // Resolve tsx's own bin from our dependencies — robust regardless of cwd.
  const tsxPkgPath = require.resolve("tsx/package.json");
  const tsxDir = path.dirname(tsxPkgPath);
  const binField = require(tsxPkgPath).bin;
  const rel = typeof binField === "string" ? binField : binField.tsx;
  const tsxBin = path.join(tsxDir, rel);
  child = spawn(process.execPath, [tsxBin, cli, ...passthru], { stdio: "inherit" });
} catch {
  // Fallback: register tsx via --import (resolves from the package root).
  child = spawn(process.execPath, ["--import", "tsx", cli, ...passthru], {
    stdio: "inherit",
    cwd: root,
  });
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

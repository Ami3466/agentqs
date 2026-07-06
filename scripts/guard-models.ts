#!/usr/bin/env tsx
/**
 * Regression fence for live model fetching. Run: npm run guard:models
 *
 * agentqs NEVER hardcodes model ids. The picker (setup + Settings) is populated
 * only by a live call to each provider's /models endpoint (src/app/api/models),
 * and src/lib/models.ts holds provider metadata only. A hardcoded id is exactly
 * the original bug ("claude-sonnet-4-5" — an id that never existed, so every call
 * 400'd). This guard fails CI the moment a model-id literal reappears in code, so
 * an agent (or a human) can't quietly reintroduce a static list or a "default".
 *
 * It is a fast static check — no server, no keys. Two parts:
 *   1. No model-id literal anywhere in src/ or scripts/ (comments stripped, so a
 *      doc-comment that mentions a banned id to explain the ban is fine).
 *   2. Structural: models.ts exports no id, and the /api/models route still hits
 *      the three exact live endpoints with no fallback array — the ONLY sanctioned
 *      source of ids.
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["src", "scripts"];
const SELF = path.resolve(__dirname, "guard-models.ts");

// Real model ids look like `<family>-<version...>`: claude-*, gpt-*, gemini-*,
// o1-/o3-/o4-* (OpenAI reasoning), text-embedding-*/davinci for older OpenAI.
// Anchored so provider LABELS ("Anthropic — Claude", "Gemini") and unrelated
// tokens ("photo1-x") don't trip it: a family word/boundary + `-` + alnum.
const MODEL_ID = new RegExp(
  [
    "claude-[a-z0-9]", // claude-3-5-sonnet, claude-sonnet-4-5, claude-opus-4-…
    "gpt-[a-z0-9]", // gpt-4o, gpt-4-turbo, gpt-3.5-turbo
    "gemini-[a-z0-9]", // gemini-1.5-pro, gemini-2.0-flash
    "\\bo[134]-(?:mini|preview|pro|[a-z])", // o1-mini, o3-mini, o1-preview
    "text-embedding-[a-z0-9]", // text-embedding-3-large
  ].join("|"),
  "i",
);

/** Remove // line and /* block *\/ comments so a comment that names a banned id
 *  to document the ban is not itself a violation. Good enough for TS source. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")) // keep line count
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1); // // comment, but not http://
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full) && full !== SELF) out.push(full);
  }
  return out;
}

let failures = 0;
const hits: string[] = [];

// ---- 1. No model-id literal in any scanned source (comments stripped). -------
for (const dir of SCAN_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      const m = line.match(MODEL_ID);
      if (m) hits.push(`  ✗ ${path.relative(ROOT, file)}:${i + 1}  →  ${m[0]}   ${line.trim().slice(0, 80)}`);
    });
  }
}
if (hits.length) {
  failures += hits.length;
  console.log(`\nHardcoded model-id literal(s) found — ids must be fetched live, never written in code:`);
  console.log(hits.join("\n"));
} else {
  console.log("  ✓ no hardcoded model-id literal in src/ or scripts/");
}

// ---- 2. Structural: models.ts holds no ids. ----------------------------------
const modelsTs = fs.readFileSync(path.join(ROOT, "src/lib/models.ts"), "utf8");
const modelsClean = stripComments(modelsTs);
{
  const bad = modelsClean.match(MODEL_ID);
  const ok = !bad;
  console.log(`  ${ok ? "✓" : "✗"} src/lib/models.ts exports provider metadata only${ok ? "" : ` — found ${bad![0]}`}`);
  if (!ok) failures++;
}

// ---- 3. Structural: the route still fetches live, with no fallback list. ------
const routeTs = fs.readFileSync(path.join(ROOT, "src/app/api/models/route.ts"), "utf8");
const endpoints = [
  "https://api.anthropic.com/v1/models",
  "https://api.openai.com/v1/models",
  "https://generativelanguage.googleapis.com/v1beta/models",
];
for (const ep of endpoints) {
  const ok = routeTs.includes(ep);
  console.log(`  ${ok ? "✓" : "✗"} /api/models fetches ${ep}`);
  if (!ok) failures++;
}
{
  const ok = routeTs.includes("anthropic-version");
  console.log(`  ${ok ? "✓" : "✗"} Anthropic call sends the required anthropic-version header`);
  if (!ok) failures++;
}

if (failures) {
  console.log(`\n✗ ${failures} check(s) failed. Model ids are fetched live — see src/app/api/models/route.ts.\n`);
  process.exit(1);
}
console.log("\n✓ Model ids are live-fetched only. No hardcoded literals; the picker can only show ids the provider API returned.\n");

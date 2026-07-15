#!/usr/bin/env tsx
/**
 * Ships-when proof for Skills (personas) — the one core every face calls
 * (CLI `agentqs skill …`, MCP `skill_*`, /api/skills, the chat brain).
 *
 * Drives the production core against a temp AGENTQS_DATA_DIR — no network, no app
 * state touched. Run: npm run skills:test
 */
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-skills-"));
process.env.AGENTQS_DATA_DIR = root;

import { writeConfig, type AppConfig } from "../src/lib/config";
import { skillsList, skillUpsert, skillRemove, skillsRestoreDefaults } from "../src/lib/cli-core";
import { resolveSkill } from "../src/lib/skills-store";
import { formatTranscript } from "../src/lib/synthesis";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

writeConfig({
  username: "t",
  passwordHash: "x",
  sessionSecret: "s",
  theme: "system",
  createdAt: new Date().toISOString(),
} as AppConfig);

console.log("\nbuilt-ins + custom CRUD:");
const builtins = skillsList();
check("the three built-in personas are listed", ["mentor", "therapist", "coach"].every((id) => builtins.some((s) => s.id === id)));
check("built-ins are flagged builtin", builtins.filter((s) => s.builtin).length >= 3);

skillUpsert({ name: "Stoic", system: "Answer as a Stoic philosopher.", blurb: "calm, first-principles" });
const withCustom = skillsList();
check("a custom persona appears in the list", withCustom.some((s) => s.id === "stoic" && !s.builtin));
check("the custom persona resolves by id (chat would wear it)", resolveSkill("stoic").name === "Stoic");
check("synthesis labels the custom persona correctly (not 'Mentor')",
  formatTranscript([{ role: "assistant", content: "Endure." }] as any, "stoic").startsWith("Stoic:"));

console.log("\nbuilt-in ids are reserved:");
let shadowRejected = false;
try {
  skillUpsert({ name: "mentor", system: "shadow attempt" });
} catch {
  shadowRejected = true;
}
check("a custom persona cannot shadow a built-in id", shadowRejected);

console.log("\nremove is reversible for built-ins, permanent for custom:");
skillRemove("coach");
check("a removed built-in disappears from the list", !skillsList().some((s) => s.id === "coach"));
check("…but is only HIDDEN — restore brings it back", (() => {
  const restored = skillsRestoreDefaults().restored;
  return restored >= 1 && skillsList().some((s) => s.id === "coach");
})());
skillRemove("stoic");
check("a removed custom persona is gone", !skillsList().some((s) => s.id === "stoic"));

fs.rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} check(s) failed.\n` : "\n✓ Skills: built-ins + custom CRUD, reserved ids, hide/restore, correct persona labelling.\n");
process.exit(failures ? 1 : 0);

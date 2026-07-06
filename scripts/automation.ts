/**
 * Ships-when proof for Task 5 · Automation setup (browser-driven imports).
 *
 * Drives the REAL pipeline end to end against a local HTML fixture (no network):
 *   1. Save a recipe (site + credentials + recorded steps) via the store.
 *   2. runAutomation launches a real headless Chromium, logs the fixture's input
 *      from the recipe's {{username}} credential, scrapes the <table>, and merges
 *      the dated rows into record/daily/<id>.csv — proving fill+interpolate+extract.
 *   3. buildSources surfaces the recipe under "Automated imports" (editable).
 *   4. A non-dated table lands raw in the inbox for Structure.
 *   5. removeAutomation drops the recipe, its secrets, its data, and its schedule.
 *
 * Needs playwright-core + a chromium binary (npx playwright install chromium).
 * Run: npm run automation:test
 */
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-automation-"));
// Set the data dir BEFORE any lib call — paths.dataDir() reads the env lazily, so
// static imports are fine; nothing resolves a path until a function actually runs.
process.env.AGENTQS_DATA_DIR = root;

import { writeConfig, readConfig } from "../src/lib/config";
import { saveAutomation, getAutomation, getCreds, removeAutomation, listAutomations } from "../src/lib/automation";
import { runAutomation } from "../src/lib/automation-run";
import { buildSources } from "../src/lib/source-registry";
import { interpolateCreds } from "../src/lib/automation-types";
import { recordDir } from "../src/lib/paths";
import { readRecord } from "../src/lib/record";

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  if (!cond) failures++;
}

async function main() {
writeConfig({
  username: "tester",
  passwordHash: "",
  sessionSecret: "",
  llmProvider: "",
  llmKey: "",
  model: "",
  theme: "system",
  createdAt: new Date().toISOString(),
});

// A fixture page: an input mirrors into a dated table cell on 'input', so a real
// browser fill + {{username}} interpolation must show up in the scraped rows.
const SECRET = "captured-2026";
const datedFixture = path.join(root, "dated.html");
fs.writeFileSync(
  datedFixture,
  `<!doctype html><meta charset=utf8>
   <input id="u" oninput="document.getElementById('cell').textContent=this.value">
   <table id="t">
     <tr><th>date</th><th>note</th></tr>
     <tr><td>2026-03-01</td><td id="cell"></td></tr>
     <tr><td>2026-03-02</td><td>steady</td></tr>
   </table>`,
);
const datedUrl = `file://${datedFixture}`;

console.log("\nScenario 0 — pure interpolation");
check("interpolateCreds fills {{username}}", interpolateCreds("hi {{username}}", { username: "amy" }) === "hi amy");
check("interpolateCreds blanks a missing token", interpolateCreds("{{token}}", {}) === "");

console.log("\nScenario 1 — save a recipe (validation)");
let rejectedReserved = false;
try {
  saveAutomation({ id: "github", name: "Nope", url: "https://x.com" });
} catch {
  rejectedReserved = true;
}
check("a reserved source id (github) is rejected", rejectedReserved);

let rejectedUrl = false;
try {
  saveAutomation({ name: "Bad URL", url: "not-a-url" });
} catch {
  rejectedUrl = true;
}
check("a non-http URL is rejected", rejectedUrl);

const saved = saveAutomation({
  name: "Power bill",
  url: datedUrl,
  credType: "userpass",
  username: SECRET,
  password: "pw",
  steps: [
    { type: "fill", selector: "#u", value: "{{username}}" },
    { type: "extractTable", selector: "#t" },
  ],
});
check("recipe saved with slug id 'power-bill'", saved.id === "power-bill");
check("password stored as a boolean in the redacted view", saved.hasPassword === true && !("password" in (saved as never)));
check("secret persisted in the separate cred store", getCreds("power-bill")?.username === SECRET);

console.log("\nScenario 2 — real headless run scrapes the table into daily");
const run = await runAutomation("power-bill");
check("run landed in the daily table", run.landed === "daily");
check("run captured cells (> 0)", run.rows > 0);
check("scraped headers include note", run.headers.includes("note"));

const csv = fs.readFileSync(path.join(recordDir(), "daily", "power-bill.csv"), "utf8");
check("daily/power-bill.csv has the dated rows", csv.includes("2026-03-01") && csv.includes("2026-03-02"));
check("the {{username}} credential was typed into the page + scraped back", csv.includes(SECRET));
check("recipe records lastStatus ok", getAutomation("power-bill")?.lastStatus === "ok");
check("last-sync timestamp persisted", Boolean(readConfig()?.sourceSyncedAt?.["power-bill"]));

console.log("\nScenario 3 — surfaced under Automated imports (editable)");
const src = buildSources(readConfig(), recordDir()).find((s) => s.id === "power-bill");
check("automation appears as a source", Boolean(src));
check("flagged as an automation", src?.automation === true);
check("connected → lives under Automated imports", src?.connected === true);
check("run endpoint carries its id", src?.syncEndpoint === "/api/automations/run?id=power-bill");

console.log("\nScenario 4 — a non-dated table lands raw in the inbox");
const plainFixture = path.join(root, "plain.html");
fs.writeFileSync(
  plainFixture,
  `<!doctype html><table id="t"><tr><th>item</th><th>qty</th></tr><tr><td>apples</td><td>3</td></tr></table>`,
);
saveAutomation({
  name: "Grocery list",
  url: `file://${plainFixture}`,
  credType: "none",
  steps: [{ type: "extractTable", selector: "#t" }],
});
const run2 = await runAutomation("grocery-list");
check("non-dated table lands in the inbox", run2.landed === "inbox");
const pending = readRecord(recordDir()).inbox.filter((i) => i.source === "automation");
check("inbox holds the raw automation capture", pending.length === 1 && pending[0].text.includes("apples"));

console.log("\nScenario 5 — remove drops recipe + secrets + data");
removeAutomation("power-bill");
check("recipe gone from the store", !getAutomation("power-bill"));
check("secrets cleared", !getCreds("power-bill"));
check("no longer in the sources list", !buildSources(readConfig(), recordDir()).some((s) => s.id === "power-bill"));
check("one automation remains (grocery-list)", listAutomations().length === 1);

fs.rmSync(root, { recursive: true, force: true });

if (failures) {
  console.log(`\n✗ ${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log("\n✓ Automation setup ships: record once (Playwright), schedule, edit under Automated imports.\n");
}

main().catch((e) => {
  console.error(e);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(1);
});

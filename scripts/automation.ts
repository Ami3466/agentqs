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
 *   5. Removal, both halves: dropping the RECIPE (removeAutomation) leaves the days it
 *      scraped in the record as an honest `imported` row — a recipe you delete must not
 *      take your history with it — while the product's Remove (disconnectSource, behind
 *      the UI, MCP and CLI alike) drops recipe, secrets, schedule AND data.
 *
 * Needs playwright-core + a chromium binary. Without it Scenario 2 dies at launch with
 * playwright's own "run npx playwright install" banner: that is a MISSING BROWSER, not a
 * broken automation — install it and the suite runs.
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
import { disconnectSource } from "../src/lib/cli-core";
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

console.log("\nScenario 5a — dropping the RECIPE never destroys the days it scraped");
// removeAutomation only clears config. No product surface removes a source with it —
// the UI's Remove, MCP `source_remove` and `agentqs source remove` all go through
// disconnectSource (5b). Asserting disconnectSource's outcome here is what made this
// scenario read as broken: the recipe leaves, and the scraped days rightly stay.
removeAutomation("power-bill");
check("recipe gone from the store", !getAutomation("power-bill"));
check("secrets cleared", !getCreds("power-bill"));
const afterRecipe = readConfig()!;
check(
  "schedule cleared",
  !afterRecipe.sourceIntervals?.["power-bill"] && !afterRecipe.sourceSyncedAt?.["power-bill"],
);
// The days survive, and the row tells the truth about them: no credential, no schedule,
// nothing syncing it — `imported`, carrying its own Remove (sources-panel gates it on
// hasData). Hiding the row instead would strand real days in the record with no way to
// see or delete them, and re-badging it "connected" is the lie the provenance rule exists
// to prevent.
const orphan = buildSources(afterRecipe, recordDir()).filter((s) => s.id === "power-bill");
check(
  "the scraped days survive as an honest 'imported' row, never a phantom connection",
  orphan.length === 1 &&
    orphan[0].provenance === "imported" &&
    !orphan[0].connected &&
    !orphan[0].automation &&
    !orphan[0].due &&
    orphan[0].hasData === true,
);

console.log("\nScenario 5b — the product's Remove drops recipe + secrets + data");
// The real path, the one every face calls. It takes the record with it.
disconnectSource("power-bill");
check("daily file dropped", !fs.existsSync(path.join(recordDir(), "daily", "power-bill.csv")));
check("no longer in the sources list", !buildSources(readConfig(), recordDir()).some((s) => s.id === "power-bill"));
check("one automation remains (grocery-list)", listAutomations().length === 1);

// Removing a LIVE recipe in one shot (disconnectSource's automation branch) — what the
// Remove button actually hits when the recipe still exists.
disconnectSource("grocery-list");
check("removing a live recipe drops it whole", !getAutomation("grocery-list") && listAutomations().length === 0);

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

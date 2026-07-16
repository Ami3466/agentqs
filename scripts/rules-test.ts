#!/usr/bin/env tsx
/**
 * Ships-when proof for agent rules ("when X → message me").
 *
 *   MAIN: a threshold rule (whoop.resting_hr > 55) evaluated by the scheduler sweep
 *   over the REAL rebuilt cache fires exactly once when the value crosses, sends the
 *   message through the REAL Slack adapter (to a local stub, no network), and does
 *   NOT re-fire while the value stays above — then re-arms and fires again after it
 *   drops below and re-crosses (hysteresis).
 *   PLUS: a threshold that isn't met never fires. A time rule fires once per day and
 *   its once-per-day guard holds on the next sweep. Validation rejects a bad
 *   operator / missing target; removeRule deletes.
 *
 * Drives the production core (upsertRule → sweepRules → evalThreshold → slack adapter)
 * against a temp AGENTQS_DATA_DIR. No LLM (text action only; briefs need a key). Runs
 * a loopback HTTP server as the Slack API. Run: npm run rules:test
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-rules-"));
process.env.AGENTQS_DATA_DIR = root;
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.AGENTQS_NO_SCHEDULER = "1"; // never let the real timer fire during the test

import { writeConfig, type AppConfig } from "../src/lib/config";
import { localDay } from "../src/lib/importers/plugin";
import { rebuild } from "../src/lib/record";
import { evalThreshold, listRules, removeRule, sweepRules, testRule, upsertRule } from "../src/lib/rules";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const today = localDay(new Date(), "UTC");

/** Loopback Slack API: 200 {ok:true}, capturing every posted message text. */
const posted: string[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      posted.push(JSON.parse(body).text as string);
    } catch {
      /* ignore */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});

function baseConfig(): AppConfig {
  return {
    username: "t",
    passwordHash: "x",
    sessionSecret: "s",
    theme: "system",
    createdAt: new Date().toISOString(),
    timezone: "UTC", // deterministic day bucketing regardless of the test host
    channels: { slackBotToken: "xoxb-test" },
  };
}

/** Seed today's daily rows for two metrics and rebuild the cache the rules read. */
function seed(restingHr: number, socialMinutes: number): void {
  const daily = path.join(root, "record", "daily");
  fs.mkdirSync(daily, { recursive: true });
  fs.writeFileSync(path.join(daily, "whoop.csv"), `date,resting_hr\n${today},${restingHr}\n`);
  fs.writeFileSync(path.join(daily, "browser.csv"), `date,social_minutes\n${today},${socialMinutes}\n`);
  rebuild({ dataDir: root });
}

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  process.env.SLACK_API_BASE = `http://127.0.0.1:${port}`;

  console.log("agent rules — threshold + time triggers fire through the real channel");

  // ---- MAIN: threshold crosses → fires once, holds, re-arms, re-fires --------
  writeConfig(baseConfig());
  seed(60, 90); // resting_hr 60 > 55 (met); social 90 < 120 (not met)

  const evalMet = evalThreshold({ kind: "threshold", source: "whoop", metric: "resting_hr", op: ">", value: 55 });
  check("evalThreshold reads today's value and compares", evalMet.value === 60 && evalMet.met === true, JSON.stringify(evalMet));

  upsertRule({
    channel: "slack",
    target: "C1",
    when: { kind: "threshold", source: "whoop", metric: "resting_hr", op: ">", value: 55 },
    then: { kind: "text", text: "HR is high." },
  });
  upsertRule({
    channel: "slack",
    target: "C1",
    when: { kind: "threshold", source: "browser", metric: "social_minutes", op: ">", value: 120 },
    then: { kind: "text", text: "Too much social." },
  });

  posted.length = 0;
  const r1 = await sweepRules();
  check("only the met threshold fires", r1.fired.length === 1 && r1.failed.length === 0, JSON.stringify(r1));
  check("the message reached the (stub) Slack API", posted.length === 1 && posted[0] === "HR is high.", JSON.stringify(posted));
  check("the not-met rule stayed silent", !posted.includes("Too much social."));

  posted.length = 0;
  const r2 = await sweepRules();
  check("still above → does NOT re-fire (armed=false)", r2.fired.length === 0 && posted.length === 0, JSON.stringify(r2));

  // value drops below → re-arm, no fire
  seed(50, 90);
  posted.length = 0;
  const r3 = await sweepRules();
  check("drops below → re-arms, no fire", r3.fired.length === 0 && posted.length === 0, JSON.stringify(r3));

  // re-crosses → fires again
  seed(60, 90);
  posted.length = 0;
  const r4 = await sweepRules();
  check("re-crosses → fires again (hysteresis)", r4.fired.length === 1 && posted[0] === "HR is high.", JSON.stringify(posted));

  // ---- PLUS: time rule fires once per day ------------------------------------
  writeConfig(baseConfig());
  seed(50, 50); // nothing crosses
  upsertRule({
    channel: "slack",
    target: "C2",
    when: { kind: "time", atLocal: "00:00" }, // always past-due within the day
    then: { kind: "text", text: "Evening brief." },
  });
  posted.length = 0;
  const t1 = await sweepRules();
  check("time rule fires when past its local time", t1.fired.length === 1 && posted[0] === "Evening brief.", JSON.stringify(posted));
  posted.length = 0;
  const t2 = await sweepRules();
  check("time rule's once-per-day guard holds", t2.fired.length === 0 && posted.length === 0, JSON.stringify(t2));

  // ---- PLUS: test-fire ignores trigger + doesn't consume the slot ------------
  writeConfig(baseConfig());
  seed(50, 50);
  const tr = upsertRule({
    channel: "slack",
    target: "C3",
    when: { kind: "threshold", source: "whoop", metric: "resting_hr", op: ">", value: 55 }, // NOT met (50)
    then: { kind: "text", text: "Manual ping." },
  });
  posted.length = 0;
  await testRule(tr.id);
  check("testRule sends even when the trigger isn't met", posted.length === 1 && posted[0] === "Manual ping.");
  const after = listRules().find((r) => r.id === tr.id)!;
  check("testRule leaves arm state untouched (no slot consumed)", after.armed !== false && !after.lastFiredDay, JSON.stringify(after));

  // ---- PLUS: validation + removal --------------------------------------------
  writeConfig(baseConfig());
  let threw = "";
  try {
    upsertRule({ channel: "slack", target: "C1", when: { kind: "threshold", source: "whoop", metric: "resting_hr", op: "!" as ">", value: 1 }, then: { kind: "text", text: "x" } });
  } catch (e) {
    threw = (e as Error).message;
  }
  check("bad operator is rejected", /operator/i.test(threw), threw);

  threw = "";
  try {
    upsertRule({ channel: "slack", target: "  ", when: { kind: "time", atLocal: "08:00" }, then: { kind: "text", text: "x" } });
  } catch (e) {
    threw = (e as Error).message;
  }
  check("missing target is rejected", /target/i.test(threw), threw);

  const saved = upsertRule({ channel: "slack", target: "C9", when: { kind: "time", atLocal: "08:00" }, then: { kind: "text", text: "keep" } });
  check("removeRule deletes a saved rule", removeRule(saved.id).removed === true && !listRules().some((r) => r.id === saved.id));
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nall checks passed");
  });

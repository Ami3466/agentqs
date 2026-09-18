#!/usr/bin/env tsx
/**
 * Ships-when proof for daily notifications (a fixed line, or a generated recap).
 *
 *   MAIN: a `text` notification reaches the REAL Slack adapter (a local stub, no
 *   network) verbatim; a `recap` one is rendered at send time by `renderAction` —
 *   the same renderer a rule's brief uses — and the RENDERED body is what is sent,
 *   never the prompt.
 *   PLUS: a row written before `kind` existed still sends as text. The once-per-day
 *   `lastSentDay` guard holds on the next sweep. "Send now" renders a recap too and
 *   does NOT consume the day. A recap that cannot render lands on its own row's
 *   `lastError` while the rows around it still send — and a `//` prompt never
 *   writes a memo into the inbox. The cli-core faces return the refreshed list and
 *   the registry-derived channel picker (email included).
 *
 * Drives the production core (cli-core → upsertNotification → sweepNotifications →
 * renderAction → composeReply → slack adapter) against a temp AGENTQS_DATA_DIR. No
 * LLM: with no key, composeReply answers a data question from the real rebuilt cache,
 * which is deterministic. Run: npm run notify:test
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-notify-"));
process.env.AGENTQS_DATA_DIR = root;
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.AGENTQS_NO_SCHEDULER = "1"; // never let the real timer fire during the test

import * as core from "../src/lib/cli-core";
import { readConfig, writeConfig, type AppConfig } from "../src/lib/config";
import { localDay } from "../src/lib/importers/plugin";
import { DEFAULT_RECAP_PROMPT, listNotifications, sweepNotifications, testNotification } from "../src/lib/notifications";
import { rebuild } from "../src/lib/record";
import { renderAction } from "../src/lib/rules";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const today = localDay(new Date(), "UTC");

/** Loopback Slack API: 200 {ok:true}, capturing every posted {channel, text}. */
const posted: { channel: string; text: string }[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const j = JSON.parse(body);
      posted.push({ channel: j.channel as string, text: j.text as string });
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

function row(id: string) {
  return listNotifications().find((n) => n.id === id);
}

/** Two sources over the same days: what a keyless recap is grounded in. */
function seed(): void {
  const daily = path.join(root, "record", "daily");
  fs.mkdirSync(daily, { recursive: true });
  const days = [0, 1, 2, 3].map((back) => localDay(new Date(Date.now() - back * 86_400_000), "UTC")).reverse();
  fs.writeFileSync(path.join(daily, "whoop.csv"), `date,sleep_hours\n${days.map((d, i) => `${d},${6 + i}`).join("\n")}\n`);
  fs.writeFileSync(path.join(daily, "github.csv"), `date,commits\n${days.map((d, i) => `${d},${2 + i * 3}`).join("\n")}\n`);
  rebuild({ dataDir: root });
}

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  process.env.SLACK_API_BASE = `http://127.0.0.1:${port}`;

  console.log("notifications — a fixed line or a rendered recap, through the real channel");

  // ---- MAIN: text is verbatim; recap is rendered by renderAction -------------
  writeConfig(baseConfig());
  seed();

  const TEXT = "How was your day?  (2 spaces, *stars* & <tags> stay as typed)";
  const savedText = core.notificationsUpsert({ id: "evening", channel: "slack", target: "C1", text: TEXT, atLocal: "00:00" });
  check("upsert returns the row AND the refreshed list", savedText.notification.id === "evening" && savedText.notifications.length === 1);
  check("a text row stores no `kind` (same shape as every older row)", !("kind" in (row("evening") as object)), JSON.stringify(row("evening")));

  const savedRecap = core.notificationsUpsert({ id: "recap", channel: "slack", target: "C2", kind: "recap", atLocal: "00:00" });
  check("a recap with no prompt gets the default one", savedRecap.notification.text === DEFAULT_RECAP_PROMPT && savedRecap.notification.kind === "recap");

  const expected = await renderAction({ kind: "brief", prompt: DEFAULT_RECAP_PROMPT });
  check("renderAction grounds the recap in the seeded record", /sleep_hours/.test(expected) && /commits/.test(expected), expected);

  posted.length = 0;
  const s1 = await sweepNotifications();
  check("both due rows send", s1.sent.length === 2 && s1.failed.length === 0, JSON.stringify(s1));
  const gotText = posted.find((p) => p.channel === "C1");
  const gotRecap = posted.find((p) => p.channel === "C2");
  check("text: the string reaches the (stub) Slack API verbatim", gotText?.text === TEXT, JSON.stringify(gotText));
  check("recap: the body sent is exactly what renderAction rendered", gotRecap?.text === expected, JSON.stringify(gotRecap));
  check("recap: the prompt itself is never sent", gotRecap?.text !== DEFAULT_RECAP_PROMPT && !posted.some((p) => p.text === DEFAULT_RECAP_PROMPT));
  check("a sent row is stamped with today", row("evening")?.lastSentDay === today && row("recap")?.lastSentDay === today);

  // ---- PLUS: once-per-day guard ----------------------------------------------
  posted.length = 0;
  const s2 = await sweepNotifications();
  check("a second sweep the same day sends nothing", s2.sent.length === 0 && s2.failed.length === 0 && posted.length === 0, JSON.stringify({ s2, posted }));

  // ---- PLUS: back-compat — a row that predates `kind` ------------------------
  writeConfig({
    ...baseConfig(),
    // Written raw, exactly as the config held it before this feature: no `kind`.
    notifications: [{ id: "legacy", channel: "slack", target: "C3", text: "Legacy line.", atLocal: "00:00", enabled: true }],
  });
  posted.length = 0;
  const s3 = await sweepNotifications();
  check("a row with no `kind` sends its text verbatim", s3.sent.join() === "legacy" && posted.length === 1 && posted[0].text === "Legacy line.", JSON.stringify(posted));
  check("…and is still stored without a `kind`", !("kind" in (row("legacy") as object)) && row("legacy")?.lastSentDay === today);

  // ---- PLUS: "Send now" renders a recap and does NOT consume the day ---------
  writeConfig(baseConfig());
  core.notificationsUpsert({ id: "now", channel: "slack", target: "C4", kind: "recap", atLocal: "00:00" });
  posted.length = 0;
  const tested = await core.notificationsTest("now");
  check("Send now renders the recap", posted.length === 1 && posted[0].text === expected, JSON.stringify(posted));
  check("Send now leaves lastSentDay unset", !tested.notification.lastSentDay && !row("now")?.lastSentDay, JSON.stringify(row("now")));
  posted.length = 0;
  const s4 = await sweepNotifications();
  check("…so the day's scheduled send still goes out", s4.sent.join() === "now" && posted.length === 1 && row("now")?.lastSentDay === today, JSON.stringify(s4));

  // ---- PLUS: a failing render is recorded on its row; the rest still send ----
  writeConfig(baseConfig());
  core.notificationsUpsert({ id: "a-first", channel: "slack", target: "C5", text: "First.", atLocal: "00:00" });
  // No key + not a data question → nothing to write from → the render throws.
  core.notificationsUpsert({ id: "b-broken", channel: "slack", target: "C6", kind: "recap", text: "Say something nice", atLocal: "00:00" });
  // A `//` prompt is a memo to composeReply; it must fail, not write the inbox.
  core.notificationsUpsert({ id: "c-memo", channel: "slack", target: "C7", kind: "recap", text: "// not a prompt", atLocal: "00:00" });
  core.notificationsUpsert({ id: "d-last", channel: "slack", target: "C8", text: "Last.", atLocal: "00:00" });
  posted.length = 0;
  const s5 = await sweepNotifications();
  check("the sweep does not throw and reports both failures", s5.failed.sort().join() === "b-broken,c-memo", JSON.stringify(s5));
  check("rows before AND after the broken ones still send", s5.sent.join() === "a-first,d-last" && posted.map((p) => p.text).join("|") === "First.|Last.", JSON.stringify(posted));
  check("the failure is on its own row's lastError", !!row("b-broken")?.lastError && !!row("c-memo")?.lastError && !row("a-first")?.lastError && !row("d-last")?.lastError, JSON.stringify(listNotifications().map((n) => [n.id, n.lastError])));
  check("a failed row keeps its day open to retry", !row("b-broken")?.lastSentDay && !row("c-memo")?.lastSentDay);
  check("nothing was sent for a failed render", !posted.some((p) => p.channel === "C6" || p.channel === "C7"));
  const inbox = path.join(root, "record", "inbox.jsonl");
  check("a `//` prompt never lands a memo in the inbox", !fs.existsSync(inbox) || !fs.readFileSync(inbox, "utf8").includes("not a prompt"));

  let threw = "";
  try {
    await testNotification("b-broken");
  } catch (e) {
    threw = (e as Error).message;
  }
  check("Send now surfaces the render error", /AI key/i.test(threw), threw);

  // ---- PLUS: faces — picker from the registry, validation, removal -----------
  const listed = core.notificationsList();
  const email = listed.channels.find((c) => c.id === "email");
  check("the channel picker comes from the registry, email included", listed.channels.length >= 3 && !!email?.hint && !!email.example, JSON.stringify(listed.channels));
  check("every channel carries its own target hint", new Set(listed.channels.map((c) => c.hint)).size === listed.channels.length);
  check("an email target is accepted", core.notificationsUpsert({ channel: "email", target: "me@example.com", kind: "recap", atLocal: "7:05" }).notification.atLocal === "07:05");

  threw = "";
  try {
    core.notificationsUpsert({ channel: "slack", target: "C1", kind: "poem" as "text", text: "x", atLocal: "08:00" });
  } catch (e) {
    threw = (e as Error).message;
  }
  check("an unknown kind is rejected", /kind/i.test(threw), threw);

  threw = "";
  try {
    core.notificationsUpsert({ channel: "slack", target: "C1", atLocal: "08:00" });
  } catch (e) {
    threw = (e as Error).message;
  }
  check("a text notification with no text is rejected", /text/i.test(threw), threw);

  const removed = core.notificationsRemove("a-first");
  check("remove deletes the row and returns the refreshed list", removed.removed === true && !removed.notifications.some((n) => n.id === "a-first"));
  check("config on disk agrees", !(readConfig()?.notifications ?? []).some((n) => n.id === "a-first"));
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

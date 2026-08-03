#!/usr/bin/env tsx
/**
 * Ships-when proof for channel PULL: Slack capture runs on this host, on this app's
 * own scheduler, and cannot silently capture nothing.
 *
 * The history: Slack messages for this record were never ingested by this app. A
 * GitHub Actions cron in a SEPARATE repo polled `#daily-log` every three hours and
 * committed the result to a JSON file. It died when that account's Actions minutes
 * ran out — and for the eighteen days afterwards it kept reporting SUCCESS, because
 * the script exits 0 on "no new messages" and the commit step is
 * `git diff --quiet || git commit`. A dead job and a healthy one produced identical
 * green checks. It had also been logging the agentqs bot's own "Saved to your
 * inbox…" acks as if they were journal entries, and advancing its cursor past the
 * real messages to do it.
 *
 * So this locks down exactly those failures, against production code, no network:
 *
 *   1. IT PULLS. New messages land in the inbox as ordinary captures.
 *   2. IT NEVER EATS ITS OWN TAIL. Bot posts (`bot_id`/`app_id`) and non-plain
 *      subtypes are skipped — the bug that poisoned the old job's data.
 *   3. IT IS INCREMENTAL. The cursor advances, and a second pull captures nothing
 *      new; a message that also arrived via the webhook is not double-captured.
 *   4. A FAILED PULL DOES NOT SKIP MESSAGES. When Slack errors, the cursor stays
 *      put, so the next sweep re-reads the window instead of losing it.
 *   5. IT RUNS ON THIS HOST. Once a conversation is configured, the channel is a
 *      due-source that `syncDue()` — the in-process 15-minute sweep — picks up.
 *      No external minutes, no second repo.
 *
 * Run: npm run pull:test
 */
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { readRecord, rebuild } from "../src/lib/record";
import { readConfig, writeConfig } from "../src/lib/config";
import { buildSources } from "../src/lib/source-registry";
import { dueSources } from "../src/lib/sync-due";

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

/** A stand-in for slack.com/api holding one channel's history. */
function slackApi(state: { messages: any[]; fail?: string }): Promise<{ port: number; close: () => void; calls: string[] }> {
  const calls: string[] = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url || "", "http://x");
      calls.push(url.pathname.split("/").pop() || "");
      res.setHeader("content-type", "application/json");
      if (state.fail) return res.end(JSON.stringify({ ok: false, error: state.fail }));
      if (url.pathname.endsWith("/conversations.list")) {
        return res.end(JSON.stringify({ ok: true, channels: [{ id: "C0DAILY", name: "daily-log" }] }));
      }
      if (url.pathname.endsWith("/conversations.history")) {
        const oldest = Number(url.searchParams.get("oldest") || 0);
        // Slack's `oldest` is INCLUSIVE — the cursor message comes back every time.
        const msgs = state.messages.filter((m) => Number(m.ts) >= oldest);
        return res.end(JSON.stringify({ ok: true, messages: msgs }));
      }
      res.end(JSON.stringify({ ok: false, error: "unknown_method" }));
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      resolve({ port, close: () => srv.close(), calls });
    });
  });
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-pull-"));
  process.env.AGENTQS_DATA_DIR = root;
  const rDir = path.join(root, "record");
  fs.mkdirSync(path.join(rDir, "daily"), { recursive: true });
  fs.writeFileSync(path.join(rDir, "daily", "whoop.csv"), "date,sleep_hours\n2026-08-01,7.4\n");
  rebuild({ recordDir: rDir });

  // A real, saved config — the pull reads its conversation from here, like prod.
  writeConfig({
    username: "tester",
    passwordHash: "x",
    createdAt: new Date().toISOString(),
    channels: { slackBotToken: "xoxb-test", slackPullChannel: "daily-log" },
  } as any);

  const state = {
    messages: [
      { type: "message", ts: "1000.000100", user: "U1", text: "fire 8 happiness 8" },
      // The bot's own ack. The old GitHub job captured these AS journal entries and
      // moved its cursor past the real messages doing it.
      { type: "message", ts: "1000.000200", bot_id: "B1", text: "Saved to your inbox. No reply — press Structure…" },
      { type: "message", ts: "1000.000300", app_id: "A1", text: "another app posting" },
      { type: "message", ts: "1000.000400", subtype: "channel_join", user: "U1", text: "has joined the channel" },
      { type: "message", ts: "1000.000500", user: "U1", text: "walked 90 min on the treadmill" },
    ],
    fail: undefined as string | undefined,
  };
  const api = await slackApi(state);
  process.env.SLACK_API_BASE = `http://127.0.0.1:${api.port}`;

  // Imported AFTER the env is set, so the adapter reads this stand-in.
  const { pullChannel, pullCursor } = await import("../src/lib/channels/pull");

  try {
    console.log("\nIt pulls, and it never captures its own voice…\n");
    const first = await pullChannel("slack", { recordDir: rDir });
    check("pulled the human messages", first.captured === 2, `captured ${first.captured}`);
    // A backlog is HISTORY. Dating it "now" would file a week-old entry under today
    // and, once structured, write the daily row on the wrong day.
    const dated = readRecord(rDir).inbox.find((i) => i.text.startsWith("fire 8"));
    check(
      "a pulled message keeps the time SLACK says it was sent",
      dated?.ts === new Date(1000.0001 * 1000).toISOString(),
      `${dated?.ts} (slack ts 1000.000100)`,
    );
    const inbox = readRecord(rDir).inbox;
    check("they landed in the inbox as slack captures", inbox.filter((i) => i.source === "slack").length === 2);
    check(
      "the bot's own ack was NOT captured",
      !inbox.some((i) => /Saved to your inbox/.test(i.text)),
      inbox.map((i) => i.text.slice(0, 24)).join(" | "),
    );
    check("another app's post was not captured", !inbox.some((i) => /another app/.test(i.text)));
    check("a channel_join was not captured", !inbox.some((i) => /joined the channel/.test(i.text)));

    console.log("\nIt is incremental…\n");
    check("the cursor advanced to the newest message", pullCursor("slack") === "1000.000500", pullCursor("slack"));
    const second = await pullChannel("slack", { recordDir: rDir });
    check("a second pull captures nothing new", second.captured === 0, `captured ${second.captured}`);
    check("…and the inbox did not grow", readRecord(rDir).inbox.length === 2);

    // A message that ALSO arrived by webhook must not double-capture: both paths key
    // the inbox item on Slack's own ts.
    state.messages.push({ type: "message", ts: "1000.000600", user: "U1", text: "cold plunge" });
    const third = await pullChannel("slack", { recordDir: rDir });
    check("a newly posted message is picked up on the next sweep", third.captured === 1);
    const fourth = await pullChannel("slack", { recordDir: rDir });
    check("re-pulling an overlapping window never duplicates", fourth.captured === 0 && readRecord(rDir).inbox.length === 3);

    console.log("\nA failed pull loses nothing…\n");
    const before = pullCursor("slack");
    state.fail = "not_in_channel";
    let threw = "";
    try {
      await pullChannel("slack", { recordDir: rDir });
    } catch (e) {
      threw = (e as Error).message;
    }
    check("a Slack error surfaces with the fix, not a bare code", /not_in_channel/.test(threw) && /invite/i.test(threw), threw);
    check("the cursor did NOT move past unread messages", pullCursor("slack") === before);
    state.fail = undefined;

    console.log("\nIt runs on THIS host's scheduler…\n");
    const rows = buildSources(readConfig(), rDir);
    const slack = rows.find((r) => r.id === "slack")!;
    check("the channel is schedulable once a conversation is set", slack.interval !== "off", `interval=${slack.interval}`);
    check("…and points at this app's own endpoint", slack.syncEndpoint === "/api/import/slack", String(slack.syncEndpoint));
    check("…and says what it polls", /polling #daily-log/.test(slack.detail), slack.detail);
    check(
      "the in-process sweep picks it up (no GitHub, no crontab)",
      dueSources(rDir).some((s) => s.id === "slack"),
      dueSources(rDir).map((s) => s.id).join(",") || "none",
    );

    // Turning it off must actually turn it off.
    const cfg = readConfig()!;
    writeConfig({ ...cfg, channels: { ...cfg.channels, slackPullChannel: "" } });
    const off = buildSources(readConfig(), rDir).find((r) => r.id === "slack")!;
    check("clearing the conversation stops the polling", off.interval === "off" && off.syncEndpoint === null);
  } finally {
    api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nAll channel-pull checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

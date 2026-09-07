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
import crypto from "crypto";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { readRecord, rebuild } from "../src/lib/record";
import { readConfig, writeConfig } from "../src/lib/config";
import { buildSources } from "../src/lib/source-registry";
import { dueSources } from "../src/lib/sync-due";
import { deliveryVerdict, readChannelDeliveries, recordDelivery } from "../src/lib/channel-deliveries";
import { channelCredentialOrigin, channelEnv } from "../src/lib/channels/registry";
import { slackAdapter } from "../src/lib/channels/slack";
import { composeReply } from "../src/lib/reply";
import { latestBackfillAt } from "../src/lib/sync-runs";

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

/** A stand-in for slack.com/api holding one channel's history. */
function slackApi(state: { messages: any[]; dm?: any[]; fail?: string }): Promise<{ port: number; close: () => void; calls: string[] }> {
  const calls: string[] = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url || "", "http://x");
      calls.push(url.pathname.split("/").pop() || "");
      res.setHeader("content-type", "application/json");
      if (state.fail) return res.end(JSON.stringify({ ok: false, error: state.fail }));
      if (url.pathname.endsWith("/conversations.list")) {
        return res.end(JSON.stringify({ ok: true, channels: [
          { id: "C0DAILY", name: "daily-log", is_member: true },
          { id: "D0DM", is_im: true, user: "U1" },
          { id: "C0OTHER", name: "not-invited", is_member: false },
        ] }));
      }
      if (url.pathname.endsWith("/conversations.history")) {
        const oldest = Number(url.searchParams.get("oldest") || 0);
        const ch = url.searchParams.get("channel") || "";
        // Slack's `oldest` is INCLUSIVE — the cursor message comes back every time.
        const pool: any[] = ch === "D0DM" ? (state.dm ?? []) : state.messages;
        const msgs = pool.filter((m: any) => Number(m.ts) >= oldest);
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
    channels: { slackBotToken: "xoxb-test", slackSigningSecret: "sign-me", slackPullChannel: "daily-log" },
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
    // The week that "disappeared": written in a DM, not the polled channel.
    dm: [{ type: "message", ts: "2000.000100", user: "U1", text: "fire 9 happiness 7 july week" }] as any[],
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
    check(
      "the cursor advanced to the newest message",
      pullCursor("slack", "daily-log") === "1000.000500",
      pullCursor("slack", "daily-log"),
    );
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
    const before = pullCursor("slack", "daily-log");
    state.fail = "not_in_channel";
    let threw = "";
    try {
      await pullChannel("slack", { recordDir: rDir });
    } catch (e) {
      threw = (e as Error).message;
    }
    check("a Slack error surfaces with the fix, not a bare code", /not_in_channel/.test(threw) && /invite/i.test(threw), threw);
    check("the cursor did NOT move past unread messages", pullCursor("slack", "daily-log") === before);
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

    // "*" — capture every conversation the bot is in. This is the answer to a week
    // of logs written somewhere other than the one channel the poll was aimed at.
    console.log("\n\"*\" captures every conversation the bot is in…\n");
    {
      const c0 = readConfig()!;
      writeConfig({ ...c0, channels: { ...c0.channels, slackPullChannel: "*" } });
      const star = await pullChannel("slack", { recordDir: rDir });
      check("it read more than the one channel", star.conversations >= 2, `conversations=${star.conversations}`);
      check(
        "the DM-only message is now in the record",
        readRecord(rDir).inbox.some((i) => /july week/.test(i.text)),
        `captured ${star.captured}`,
      );
      check("a conversation the bot is NOT in is skipped", !star.failed.some((f) => f.includes("C0OTHER")), star.failed.join(" | ") || "none");
      const again = await pullChannel("slack", { recordDir: rDir });
      check("and re-running captures nothing new", again.captured === 0, `captured ${again.captured}`);
    }

    // ---- A pull is not a delivery -----------------------------------------
    // The ledger is named for INBOUND webhooks, and the poll wrote into it as if it
    // were one. On the live record that produced "Slack delivered a message and this
    // app REFUSED it — C0BEXMYAVU3: fetch failed" when Slack had delivered nothing
    // at all and our own poll simply could not reach slack.com.
    console.log("\nA failed POLL is never reported as a refused DELIVERY…\n");
    {
      state.fail = "fetch failed";
      try {
        await pullChannel("slack", { recordDir: rDir });
      } catch {
        /* the point is what it wrote down */
      }
      state.fail = undefined;
      const d = readChannelDeliveries("slack");
      check("the failed poll is recorded as a PULL", d.last?.via === "pull", String(d.last?.via));
      const v = deliveryVerdict(d, { configured: true, label: "Slack" });
      check("the verdict does NOT accuse Slack of a refused delivery", !/REFUSED/.test(v.text), v.text);
      check("…it says we could not reach Slack", /could not reach Slack/i.test(v.text), v.text);
      check("…and a pull failure never lands in lastRejected", !d.lastRejected, JSON.stringify(d.lastRejected ?? null));
    }
    {
      // The inverse lie: a healthy poll made a webhook that has NEVER fired read as
      // a working connection.
      state.messages.push({ type: "message", ts: "2500.000100", user: "U1", text: "polled, never pushed" });
      const ok = await pullChannel("slack", { recordDir: rDir });
      check("the recovered poll captured the new message", ok.captured === 1, `captured ${ok.captured}`);
      const d = readChannelDeliveries("slack");
      const v = deliveryVerdict(d, { configured: true, label: "Slack" });
      check(
        "a capturing poll does not certify a webhook that never delivered",
        v.tone === "warn" && /only arriving because this app POLLS|only arriving/i.test(v.text),
        v.text,
      );
      check("…and it points at Event Subscriptions", /Event Subscriptions/.test(v.text), v.text);
      // …and a real inbound POST flips it.
      recordDelivery("slack", "captured", "memo", { via: "push" });
      const v2 = deliveryVerdict(readChannelDeliveries("slack"), { configured: true, label: "Slack" });
      check("once the webhook delivers once, the warning clears", v2.tone === "ok", v2.text);
      // A refused PUSH still outranks a happily-capturing poll — that combination is
      // exactly the silent killer this ledger exists for.
      recordDelivery("slack", "rejected", "bad request signature", { via: "push" });
      recordDelivery("slack", "captured", "pulled 1 from daily-log", { via: "pull" });
      const v3 = deliveryVerdict(readChannelDeliveries("slack"), { configured: true, label: "Slack" });
      check("a refused webhook is still reported while the poll is working", /REFUSED/.test(v3.text), v3.text);
    }

    // ---- The row's last-poll time ------------------------------------------
    // Cursors are PER CONVERSATION (`channel-pull:slack:C0DAILY`), so the bare
    // `channel-pull:slack` key is never written. Reading it made "last polled"
    // permanently null, which made the row permanently DUE — the channel was
    // re-polled on every 15-minute sweep whatever its interval said.
    console.log("\nThe row knows when it last polled…\n");
    {
      check(
        "a per-conversation cursor answers 'when did this channel last poll?'",
        Boolean(latestBackfillAt("channel-pull:slack")),
        String(latestBackfillAt("channel-pull:slack")),
      );
      const c = readConfig()!;
      writeConfig({ ...c, sourceIntervals: { ...(c.sourceIntervals ?? {}), slack: "daily" } });
      const row = buildSources(readConfig(), rDir).find((r) => r.id === "slack")!;
      check("…so a just-polled daily channel is NOT due again", row.due === false, `lastSync=${row.lastSync} due=${row.due}`);
      writeConfig({ ...readConfig()!, sourceIntervals: {} });
    }

    // ---- Where the credential came from ------------------------------------
    console.log("\nThe row says where the token actually came from…\n");
    {
      check("a token saved in Settings reads as SAVED", channelCredentialOrigin(slackAdapter) === "saved", String(channelCredentialOrigin(slackAdapter)));
      const c = readConfig()!;
      writeConfig({ ...c, channels: { ...c.channels, slackBotToken: "" } });
      process.env.SLACK_BOT_TOKEN = "xoxb-from-env";
      check("…and an environment variable reads as ENV", channelCredentialOrigin(slackAdapter) === "env", String(channelCredentialOrigin(slackAdapter)));
      delete process.env.SLACK_BOT_TOKEN;
      check("…and no token at all is null", channelCredentialOrigin(slackAdapter) === null, String(channelCredentialOrigin(slackAdapter)));
      writeConfig(c);
      check("config still wins over the environment", channelEnv().slackBotToken === "xoxb-test", channelEnv().slackBotToken);
    }

    // ---- Push and pull are the SAME message --------------------------------
    // Confirmed on the live record: every Slack message existed TWICE — once under
    // `slack:<channel>:<ts>` from the poll and once under a random UUID from the
    // webhook, because composeReply threw the platform's id away and the two paths
    // minted different keys anyway.
    console.log("\nA message that arrives BOTH ways lands exactly once…\n");
    {
      const c0 = readConfig()!;
      writeConfig({ ...c0, channels: { ...c0.channels, slackPullChannel: "*" } });
      const TEXT = "pushed and polled";
      const TS = "3000.000100";
      state.messages.push({ type: "message", ts: TS, user: "U1", text: TEXT });

      // 1) It arrives by WEBHOOK, through the real signature check and the real brain.
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "Ev0PUSH",
        event: { type: "message", user: "U1", text: TEXT, channel: "C0DAILY", ts: TS },
      });
      const stamp = String(Math.floor(Date.now() / 1000));
      const sig = "v0=" + crypto.createHmac("sha256", "sign-me").update(`v0:${stamp}:${body}`).digest("hex");
      const verdict = slackAdapter.ingest({
        env: channelEnv(),
        headers: new Headers({ "x-slack-signature": sig, "x-slack-request-timestamp": stamp }),
        rawBody: body,
      });
      check(
        "the webhook mints the message's OWN id, not the delivery's",
        verdict.message?.messageId === `slack:C0DAILY:${TS}`,
        String(verdict.message?.messageId),
      );
      await composeReply({ message: TEXT, channel: "slack", messageId: verdict.message?.messageId, ai: false });
      const afterPush = readRecord(rDir).inbox.filter((i) => i.text === TEXT);
      check("…and the capture is stored under it", afterPush.length === 1 && afterPush[0].id === `slack:C0DAILY:${TS}`, afterPush.map((i) => i.id).join(","));

      // 2) The poll then reads the same message back out of Slack's history.
      const swept = await pullChannel("slack", { recordDir: rDir });
      const both = readRecord(rDir).inbox.filter((i) => i.text === TEXT);
      check("the poll recognises it as already held", swept.captured === 0, `captured ${swept.captured}`);
      check("THE INBOX HOLDS EXACTLY ONE COPY", both.length === 1, `${both.length} copies: ${both.map((i) => i.id).join(", ")}`);
      writeConfig(readConfig()!);
    }

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

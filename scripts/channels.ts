#!/usr/bin/env tsx
/**
 * Ships-when proof for Loop 14 · Channels (Slack + Telegram).
 *
 * "A Telegram DM 'why tired?' returns the grounded reply; same adapter shape for
 * Slack." One channel-agnostic adapter turns an inbound platform webhook into a
 * memo or a grounded chat reply and posts it back out. This proves the whole pipe:
 *
 *   1. The pure adapter contract (src/lib/channels/*) — the SAME modules the route
 *      imports — verifies + parses a raw webhook into a normalized message
 *      (Telegram shared-secret check, Slack signing-secret check + url_verification
 *      handshake), independent of any transport.
 *   2. End to end over the BUILT app: a Telegram update carrying "why am I tired
 *      lately?" POSTed to /api/channels/telegram is grounded against a real 2-source
 *      record and the grounded reply is posted back out via the Telegram Bot API
 *      (captured by a local stand-in for api.telegram.org). The identical message on
 *      /api/channels/slack produces the identical grounded reply via chat.postMessage
 *      — one brain, two transports.
 *   3. A `//` memo over Telegram lands raw in the inbox (source `telegram`, no LLM,
 *      no daily row) and the bot replies with the "saved" ack.
 *
 * Only the platform's OUTBOUND API is substituted (a local capture server, the same
 * trick the importer tests use for fetch); everything else — verification, parsing,
 * the shared brain, the record write, the grounding — is the real production path,
 * so this fails if any of it breaks. Run: npm run channels:test (needs `next build`).
 */
import { spawn } from "child_process";
import crypto from "crypto";
import http from "http";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import { rebuild, readRecord } from "../src/lib/record";
import { telegramAdapter } from "../src/lib/channels/telegram";
import { slackAdapter } from "../src/lib/channels/slack";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, ms = 30000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status > 0) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > ms) throw new Error(`server did not come up at ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** A stand-in for the Telegram + Slack outbound APIs: records the last message the
 *  bot tried to send on each platform and returns each API's success shape. So a
 *  captured message proves the full route → brain → adapter.send pipe delivered it. */
function captureServer(): Promise<{ port: number; last: Record<string, string>; close: () => void }> {
  const last: Record<string, string> = {};
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let json: any = {};
        try {
          json = body ? JSON.parse(body) : {};
        } catch {
          /* ignore */
        }
        const url = req.url || "";
        if (url.endsWith("/sendMessage")) {
          last.telegram = String(json.text ?? "");
          res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
        } else if (url.endsWith("/chat.postMessage")) {
          last.slack = String(json.text ?? "");
          res.end(JSON.stringify({ ok: true, ts: "1.2" }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false }));
        }
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      resolve({ port, last, close: () => srv.close() });
    });
  });
}

function seedRecord(recordDir: string) {
  // Two sources that share days so the keyless cross-source grounding fires.
  const dailyDir = path.join(recordDir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.writeFileSync(
    path.join(dailyDir, "github.csv"),
    ["date,commits", "2026-06-01,4", "2026-06-02,9", "2026-06-03,2", "2026-06-04,15", "2026-06-05,11", "2026-06-06,3", "2026-06-07,18"].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(dailyDir, "whoop.csv"),
    ["date,sleep_hours", "2026-06-01,7.4", "2026-06-02,6.1", "2026-06-03,7.9", "2026-06-04,5.8", "2026-06-05,6.4", "2026-06-06,8.0", "2026-06-07,5.5"].join("\n") + "\n",
  );
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-channels-"));
  const QUESTION = "Why am I so tired lately?";
  const MEMO = "// slept badly, woke at 3am wired";
  const TG_SECRET = "e2e-telegram-secret";
  const SL_SECRET = "e2e-slack-signing-secret";
  const tgHeaders = () => ({ "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET });
  const slHeaders = (body: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = "v0=" + crypto.createHmac("sha256", SL_SECRET).update(`v0:${ts}:${body}`).digest("hex");
    return { "content-type": "application/json", "x-slack-signature": sig, "x-slack-request-timestamp": ts };
  };

  // ---- 1. The pure adapter contract (verification + parsing) ----------------
  console.log("\nThe channel-agnostic adapter contract (verify + parse, shared with the route)…\n");

  // Telegram: shared-secret verification + update parsing.
  const tgEnv = { telegramBotToken: "tok", telegramWebhookSecret: "s3cret" };
  const tgUpdate = JSON.stringify({ message: { from: { id: 5, is_bot: false }, chat: { id: 42 }, text: "why tired?" } });
  check(
    "telegram rejects a bad webhook secret",
    telegramAdapter.ingest({ env: tgEnv, headers: new Headers({ "x-telegram-bot-api-secret-token": "wrong" }), rawBody: tgUpdate }).error !== undefined,
  );
  const tgOk = telegramAdapter.ingest({ env: tgEnv, headers: new Headers({ "x-telegram-bot-api-secret-token": "s3cret" }), rawBody: tgUpdate });
  check("telegram parses a valid update → message", tgOk.message?.text === "why tired?" && tgOk.message?.target === "42");
  // Regression guard: with a bot token but NO secret, an unverifiable webhook must be
  // REFUSED (never answered) — else a forged POST leaks the record to a chosen chat.
  {
    const v = telegramAdapter.ingest({ env: { telegramBotToken: "tok" }, headers: new Headers(), rawBody: tgUpdate });
    check("telegram refuses an unverifiable webhook (no secret configured)", v.error !== undefined && v.message === undefined);
  }
  check("telegram ignores a bot's own message", Boolean(telegramAdapter.ingest({ env: tgEnv, headers: new Headers({ "x-telegram-bot-api-secret-token": "s3cret" }), rawBody: JSON.stringify({ message: { from: { is_bot: true }, chat: { id: 1 }, text: "hi" } }) }).ignore));

  // Slack: url_verification handshake, signing-secret check, event parsing.
  const slackSecret = "slacksign";
  const slEnv = { slackBotToken: "xoxb-1", slackSigningSecret: slackSecret };
  check(
    "slack echoes the url_verification challenge",
    slackAdapter.ingest({ env: slEnv, headers: new Headers(), rawBody: JSON.stringify({ type: "url_verification", challenge: "abc123" }) }).challenge === "abc123",
  );
  const eventBody = JSON.stringify({ type: "event_callback", event: { type: "message", user: "U9", text: "why tired?", channel: "D1" } });
  const ts = String(Math.floor(Date.now() / 1000));
  const goodSig = "v0=" + crypto.createHmac("sha256", slackSecret).update(`v0:${ts}:${eventBody}`).digest("hex");
  check(
    "slack rejects a bad request signature",
    slackAdapter.ingest({ env: slEnv, headers: new Headers({ "x-slack-signature": "v0=deadbeef", "x-slack-request-timestamp": ts }), rawBody: eventBody }).error !== undefined,
  );
  const slOk = slackAdapter.ingest({ env: slEnv, headers: new Headers({ "x-slack-signature": goodSig, "x-slack-request-timestamp": ts }), rawBody: eventBody });
  check("slack parses a signed message event → message", slOk.message?.text === "why tired?" && slOk.message?.target === "D1");
  // Regression guard: no signing secret → even a "signed" event is refused (we can't
  // verify it), but the url_verification handshake (no record access) still answers.
  {
    const noSecret = { slackBotToken: "xoxb-1" };
    const evt = slackAdapter.ingest({ env: noSecret, headers: new Headers({ "x-slack-signature": goodSig, "x-slack-request-timestamp": ts }), rawBody: eventBody });
    check("slack refuses an event when no signing secret is configured", evt.error !== undefined && evt.message === undefined);
    const hs = slackAdapter.ingest({ env: noSecret, headers: new Headers(), rawBody: JSON.stringify({ type: "url_verification", challenge: "xyz" }) });
    check("slack still answers url_verification without a secret (no record access)", hs.challenge === "xyz");
  }

  // ---- 2. + 3. End to end over the built app --------------------------------
  seedRecord(path.join(root, "record"));
  rebuild({ recordDir: path.join(root, "record"), dbPath: path.join(root, "agentqs.db") });

  const cap = await captureServer();
  const capBase = `http://127.0.0.1:${cap.port}`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nStarting the built app on ${base} (data dir = ${root}); outbound bot APIs → ${capBase}…`);
  const server = spawn(process.execPath, [path.join(process.cwd(), ".next", "standalone", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      AGENTQS_DATA_DIR: root,
      SESSION_SECRET: "loop14-ships-when-secret",
      // Both bots configured (no AI key → deterministic keyless grounding).
      TELEGRAM_BOT_TOKEN: "test-telegram-token",
      TELEGRAM_API_BASE: capBase,
      SLACK_BOT_TOKEN: "xoxb-test-slack-token",
      SLACK_API_BASE: capBase,
      // Secrets ARE set: inbound webhooks are refused unless verified, so the e2e
      // must sign/authenticate every POST — driving the real secure path.
      TELEGRAM_WEBHOOK_SECRET: TG_SECRET,
      SLACK_SIGNING_SECRET: SL_SECRET,
    },
    stdio: "ignore",
  });

  try {
    await waitFor(`${base}/login`);
    const setup = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "tester", password: "loop14pass", confirm: "loop14pass" }),
    });
    check("setup created the account (no AI key)", setup.ok);
    const cookie = ((setup.headers.get("set-cookie") || "").match(/agentqs_session=[^;]+/) || [""])[0];

    // Capability probe: both channels report enabled.
    const tgProbe = await (await fetch(`${base}/api/channels/telegram`, { headers: { cookie } })).json();
    const slProbe = await (await fetch(`${base}/api/channels/slack`, { headers: { cookie } })).json();
    check("/api/channels/telegram probe reports enabled", tgProbe.enabled === true);
    check("/api/channels/slack probe reports enabled", slProbe.enabled === true);

    // --- Telegram DM: "why tired?" → grounded reply posted back out. ---
    console.log(`\n  Telegram DM:  “${QUESTION}”\n`);
    const tgInbound = JSON.stringify({ update_id: 1, message: { message_id: 7, from: { id: 100, is_bot: false }, chat: { id: 100, type: "private" }, text: QUESTION } });
    const tgRes = await (await fetch(`${base}/api/channels/telegram`, { method: "POST", headers: tgHeaders(), body: tgInbound })).json();
    check("telegram webhook handled → grounded chat reply", tgRes.ok === true && tgRes.mode === "chat" && tgRes.grounded === true, tgRes.via);
    const tgReply = cap.last.telegram || "";
    console.log(`  → bot replied: ${tgReply}\n`);
    check("the reply was posted back out via the Telegram Bot API", tgReply.length > 0);
    check("the reply is grounded in the real record (cites a number + both sources)", /\d/.test(tgReply) && /github/.test(tgReply) && /whoop/.test(tgReply), tgReply.slice(0, 80));
    check("telegram webhook attributed ≥2 sources", new Set(tgRes.sources).size >= 2, (tgRes.sources || []).join(" + "));

    // --- Same adapter shape for Slack: identical message, identical reply. ---
    console.log(`  Slack message:  “${QUESTION}”\n`);
    const slInbound = JSON.stringify({ type: "event_callback", event: { type: "message", user: "U100", text: QUESTION, channel: "C100" } });
    const slRes = await (await fetch(`${base}/api/channels/slack`, { method: "POST", headers: slHeaders(slInbound), body: slInbound })).json();
    check("slack webhook handled → grounded chat reply", slRes.ok === true && slRes.mode === "chat" && slRes.grounded === true, slRes.via);
    const slReply = cap.last.slack || "";
    console.log(`  → bot replied: ${slReply}\n`);
    check("the reply was posted back out via Slack chat.postMessage", slReply.length > 0);
    check("one brain, two transports: Slack and Telegram gave the identical grounded reply", slReply === tgReply);

    // --- A `//` memo over Telegram lands raw in the inbox, no LLM. ---
    console.log(`  Telegram memo:  “${MEMO}”\n`);
    const memoInbound = JSON.stringify({ update_id: 2, message: { message_id: 8, from: { id: 100, is_bot: false }, chat: { id: 100 }, text: MEMO } });
    const memoRes = await (await fetch(`${base}/api/channels/telegram`, { method: "POST", headers: tgHeaders(), body: memoInbound })).json();
    check("telegram memo handled as a memo (no chat)", memoRes.ok === true && memoRes.mode === "memo" && memoRes.grounded === false);
    check("the bot acked the memo (saved, no reply)", /saved/i.test(cap.last.telegram || ""), cap.last.telegram);

    // The memo is in the inbox (source `telegram`, raw) and produced no daily row.
    const rec = readRecord(path.join(root, "record"));
    const landed = rec.inbox.find((i) => i.source === "telegram" && i.text === "slept badly, woke at 3am wired");
    check("the memo landed in the inbox as a raw `telegram` memo", Boolean(landed), landed?.kind);
    const daily = await (await fetch(`${base}/api/daily`, { headers: { cookie } })).json();
    check("no LLM ran — the memo produced no `telegram` daily row", !(daily.sources || []).some((s: any) => s.source === "telegram"));

    // Slack url_verification handshake over the live route.
    const verify = await (await fetch(`${base}/api/channels/slack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "url_verification", challenge: "handshake-xyz" }) })).json();
    check("slack url_verification handshake echoes the challenge", verify.challenge === "handshake-xyz");

    // Unknown channel → 404.
    const unknown = await fetch(`${base}/api/channels/discord`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check("an unknown channel is a 404", unknown.status === 404);

    // ---- 4. A channel is a PIPELINE SOURCE ----------------------------------
    // Messages arriving from Slack are data coming IN, so the tab that lists the
    // data coming in has to show them. It didn't: a live bot filling the inbox
    // was invisible on the Pipeline, which is how "I don't see my Slack messages
    // in the pipeline" happened. Both bots here are credentialed by ENV VAR —
    // the case the Settings badge used to call "Not linked" while the bot worked.
    console.log("\n  The Pipeline sees the channels:\n");
    const list = await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json();
    const sources: any[] = list.sources ?? [];
    const slackRow = sources.find((s) => s.id === "slack");
    const tgRow = sources.find((s) => s.id === "telegram");

    check("Slack has a row in the Pipeline at all", Boolean(slackRow), sources.map((s) => s.id).join(","));
    check("Telegram has one too", Boolean(tgRow));
    check(
      "an ENV-credentialed bot reads as CONNECTED (it works, so it must not say 'not connected')",
      slackRow?.connected === true && tgRow?.connected === true,
    );
    check("both are flagged as channels", slackRow?.channel === true && tgRow?.channel === true);

    // Pushed, not polled: nothing to schedule, nothing to sync, never "due".
    check(
      "a channel is never scheduled or synced (it is PUSHED to our webhook)",
      slackRow?.interval === "off" && slackRow?.syncEndpoint === null && slackRow?.due === false,
      `interval=${slackRow?.interval} endpoint=${slackRow?.syncEndpoint} due=${slackRow?.due}`,
    );

    // The captures themselves: the telegram memo landed, so its row carries it.
    check(
      "the captured memo shows on the Telegram row",
      tgRow?.hasData === true && /1 message captured/.test(String(tgRow?.detail)),
      String(tgRow?.detail),
    );
    check("…with the time of the last message", Boolean(tgRow?.lastSync));
    // Slack was only CHATTED with here (no memo), so: connected, zero captures —
    // the connection rule holds in both directions (data ≠ connected).
    check(
      "a connected channel with nothing captured says so (connected ≠ has data)",
      slackRow?.hasData === false && /nothing captured yet/.test(String(slackRow?.detail)),
      String(slackRow?.detail),
    );
    // A channel row describes what it HAS captured. It must never advertise itself
    // like a puller that could go and fetch your Slack history — it cannot, and the
    // row reading "not connected · messages you send the bot land in your inbox" is
    // exactly what made the Pipeline unreadable.
    check(
      "a channel row never claims to import from the platform",
      !/history|import|sync/i.test(String(slackRow?.detail)) && slackRow?.syncEndpoint === null,
      String(slackRow?.detail),
    );
  } finally {
    server.kill("SIGKILL");
    cap.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log(
    "\n✓ Channels ship: a Telegram DM 'why tired?' returns the grounded reply and Slack gives the identical reply through the same adapter — plus `//` memos land raw in the inbox.\n",
  );
}

void main();

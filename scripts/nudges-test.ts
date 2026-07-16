#!/usr/bin/env tsx
/**
 * Ships-when proof for daily nudges — scheduled OUTBOUND messages ("how was your
 * day?" at 8pm). No network, no server: a tiny local capture stands in for Slack's
 * chat.postMessage (SLACK_API_BASE override, the same trick the channels test uses),
 * everything else is the real production path — config store, the scheduler's
 * sweepNudges, the Slack adapter's send, the once-per-day guard.
 *
 * Proves:
 *   1. Time logic: parseAtLocal / localMinutes / nudgeDue gate on the LOCAL clock,
 *      fire only once the time has passed, and never twice in a day (lastSentDay).
 *   2. sweepNudges actually posts to the channel, stamps the send, and is a no-op
 *      on the second sweep the same day.
 *   3. `nudge test` (testNudge) sends immediately WITHOUT consuming today's slot.
 *   4. An unconfigured channel records the error instead of throwing the sweep.
 *
 * Run: npm run nudge:test  (exits 1 on any failure).
 */
import http from "http";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import type { AppConfig } from "../src/lib/config";

// The store dir must be set before any lib resolves paths.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-nudge-"));
process.env.AGENTQS_DATA_DIR = DATA_DIR;

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

async function main() {
  const { writeConfig, readConfig } = await import("../src/lib/config");
  const { parseAtLocal, localMinutes, nudgeDue, sweepNudges, upsertNudge, testNudge, listNudges, removeNudge } =
    await import("../src/lib/nudges");

  // ---- 1. A Slack capture server standing in for chat.postMessage ----------
  const sent: { channel: string; text: string }[] = [];
  const port = await freePort();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const j = JSON.parse(body || "{}");
        sent.push({ channel: j.channel, text: j.text });
      } catch {
        /* ignore */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  process.env.SLACK_API_BASE = `http://127.0.0.1:${port}`;

  // ---- 2. A configured instance: Slack linked, timezone pinned to UTC -------
  const cfg: AppConfig = {
    username: "tester",
    passwordHash: "x",
    sessionSecret: "s",
    theme: "system",
    createdAt: new Date("2020-01-01T00:00:00Z").toISOString(),
    timezone: "UTC",
    channels: { slackBotToken: "xoxb-test", slackSigningSecret: "sign" },
  };
  writeConfig(cfg);

  // ---- 3. Pure time logic (deterministic, fixed clock in UTC) --------------
  console.log("Time logic:");
  check("parseAtLocal 20:00 → 1200", parseAtLocal("20:00") === 20 * 60);
  check("parseAtLocal rejects 24:00", parseAtLocal("24:00") === null);
  check("parseAtLocal rejects garbage", parseAtLocal("8pm") === null);
  const at19 = new Date("2024-06-01T19:00:00Z");
  const at2030 = new Date("2024-06-01T20:30:00Z");
  check("localMinutes 20:30 UTC → 1230", localMinutes(at2030, "UTC") === 20 * 60 + 30);
  const gated = { id: "g", channel: "slack", target: "C1", text: "hi", atLocal: "20:00" };
  check("not due before its time", nudgeDue(gated, at19, "UTC") === false);
  check("due after its time", nudgeDue(gated, at2030, "UTC") === true);
  check(
    "not due once already sent today",
    nudgeDue({ ...gated, lastSentDay: "2024-06-01" }, at2030, "UTC") === false,
  );
  check("disabled is never due", nudgeDue({ ...gated, enabled: false }, at2030, "UTC") === false);

  // ---- 4. Upsert + a real sweep that posts to the channel ------------------
  console.log("Sweep + send:");
  const saved = upsertNudge({ channel: "slack", target: "C0DAILY", text: "How was your day?", atLocal: "00:00" });
  check("upsert derived a slug id", saved.id === "slack-0000", saved.id);
  check("upsert defaults enabled", saved.enabled === true);

  // now is any real instant; atLocal 00:00 is always past today → due exactly once.
  const now = new Date();
  const first = await sweepNudges(now);
  check("first sweep sent it", first.sent.length === 1 && first.failed.length === 0, JSON.stringify(first));
  check("channel actually received the message", sent.length === 1 && sent[0].text === "How was your day?");
  check("posted to the configured target", sent[0]?.channel === "C0DAILY");
  const afterSend = listNudges().find((n) => n.id === saved.id)!;
  check("lastSentDay stamped", Boolean(afterSend.lastSentDay), afterSend.lastSentDay);
  check("lastError cleared", afterSend.lastError === null);

  const second = await sweepNudges(now);
  check("second sweep is a no-op (once-per-day)", second.sent.length === 0 && sent.length === 1);

  // ---- 5. Manual test sends now WITHOUT consuming today's slot -------------
  console.log("Manual test send:");
  await testNudge(saved.id);
  check("test send hit the channel", sent.length === 2);
  const afterTest = listNudges().find((n) => n.id === saved.id)!;
  check("test did NOT change lastSentDay", afterTest.lastSentDay === afterSend.lastSentDay);
  const third = await sweepNudges(now);
  check("still no re-send after a test", third.sent.length === 0 && sent.length === 2);

  // ---- 6. Unconfigured channel records the error, never throws the sweep ----
  console.log("Unconfigured channel:");
  writeConfig({ ...(readConfig() as AppConfig), channels: {} }); // pull the Slack token
  upsertNudge({ channel: "slack", target: "C0OTHER", text: "hi", atLocal: "00:00", id: "unconfigured" });
  const swept = await sweepNudges(now);
  check("failed row surfaced, sweep survived", swept.failed.some((f) => f.id === "unconfigured"));
  const errRow = listNudges().find((n) => n.id === "unconfigured")!;
  check("error recorded on the nudge", Boolean(errRow.lastError));

  // ---- 7. Remove ------------------------------------------------------------
  console.log("Remove:");
  check("remove reports removed", removeNudge(saved.id).removed === true);
  check("remove of missing reports false", removeNudge("nope").removed === false);
  check("gone from the list", !listNudges().some((n) => n.id === saved.id));

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll nudge checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

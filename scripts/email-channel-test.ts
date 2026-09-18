#!/usr/bin/env tsx
/**
 * Ships-when proof for EMAIL AS A CHANNEL (send anywhere, replies on Gmail only).
 *
 *   MAIN: the real email adapter sends a notification through the real `sendMail`
 *   to a loopback Gmail API — the outgoing body carries the `aqs#` tag. A stubbed
 *   reply that quotes it is then PULLED by the real `pullChannel`: it becomes an
 *   InboundMessage keyed `gmail:<id>`, lands through `landCapture` as EXACTLY ONE
 *   inbox item (record + cache) with the quoted original stripped, and a second
 *   pull adds nothing — by cursor, and by message id when the cursor is thrown away.
 *   PLUS: what must NOT be captured isn't (our own outgoing mail, a stranger, a
 *   wrong token, spam). A failed sweep throws and leaves the cursor where it was,
 *   then the next sweep collects what it missed. AI replies: a keyless grounded
 *   answer is mailed back to the sender, tagged; log-only and `//` memos send
 *   nothing. SMTP is send-only: never pullable, and its pull refuses.
 *
 * Drives the production path (emailAdapter → sendMail, pullChannel → landCapture →
 * composeReply) against a temp AGENTQS_DATA_DIR. No network, no LLM — a loopback
 * HTTP server is the Gmail API. Run: npm run email:test
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-email-"));
process.env.AGENTQS_DATA_DIR = root;
process.env.AGENTQS_NO_SCHEDULER = "1"; // never let the real timer fire during the test

import Database from "better-sqlite3";
import { readConfig, writeConfig, type AppConfig } from "../src/lib/config";
import { emailAdapter, replyTag, stripQuoted } from "../src/lib/channels/email";
import { pullChannel, pullCursor, pullable } from "../src/lib/channels/pull";
import { channelEnv, getChannelAdapter } from "../src/lib/channels/registry";
import { deliveryVerdict, readChannelDeliveries } from "../src/lib/channel-deliveries";
import { dbPath } from "../src/lib/paths";
import { readInboxFromRecord, rebuild } from "../src/lib/record";
import { insideSyncJob, readSyncJob, startJobAndWait, STRUCTURE_JOB, waitForSyncJobs } from "../src/lib/sync-jobs";
import { writeBackfillState } from "../src/lib/sync-runs";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const ME = "me@example.com";
const SEND = "https://www.googleapis.com/auth/gmail.send";
const READ = "https://www.googleapis.com/auth/gmail.readonly";
const rDir = path.join(root, "record");

// ---- loopback Gmail API -----------------------------------------------------

interface StubMessage {
  id: string;
  internalDate: string;
  labelIds: string[];
  headers: Record<string, string>;
  body: string;
}
const mailbox: StubMessage[] = [];
const sent: Array<{ to: string; subject: string; body: string }> = [];
const queries: string[] = [];
let failGets = false;

/** Undo quoted-printable, so the assertions read what a mail client would show. */
function unQp(s: string): string {
  return s.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://stub");
    const json = (code: number, v: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.headers.authorization !== "Bearer ya29.test-token") return json(401, { error: { message: "bad token" } });
    const base = "/gmail/v1/users/me/messages";
    if (req.method === "POST" && url.pathname === `${base}/send`) {
      const raw = Buffer.from(JSON.parse(body).raw as string, "base64url").toString("utf8");
      const [head, ...rest] = raw.split("\r\n\r\n");
      sent.push({
        to: /^To: (.*)$/m.exec(head)?.[1] ?? "",
        subject: /^Subject: (.*)$/m.exec(head)?.[1] ?? "",
        body: unQp(rest.join("\r\n\r\n")).replace(/\r\n/g, "\n"),
      });
      return json(200, { id: `sent-${sent.length}`, threadId: "t1" });
    }
    if (req.method === "GET" && url.pathname === base) {
      queries.push(url.searchParams.get("q") ?? "");
      return json(200, { messages: mailbox.map((m) => ({ id: m.id, threadId: "t1" })) });
    }
    if (req.method === "GET" && url.pathname.startsWith(`${base}/`)) {
      if (failGets) return json(500, { error: { message: "backend error" } });
      const m = mailbox.find((x) => x.id === decodeURIComponent(url.pathname.slice(base.length + 1)));
      if (!m) return json(404, { error: { message: "not found" } });
      return json(200, {
        id: m.id,
        internalDate: m.internalDate,
        labelIds: m.labelIds,
        payload: {
          mimeType: "multipart/alternative",
          headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })),
          parts: [{ mimeType: "text/plain", body: { data: Buffer.from(m.body, "utf8").toString("base64url") } }],
        },
      });
    }
    json(404, { error: { message: "no such stub route" } });
  });
});

function baseConfig(extra: Partial<AppConfig> = {}): AppConfig {
  return {
    username: "t",
    passwordHash: "x",
    sessionSecret: "s",
    theme: "system",
    createdAt: new Date().toISOString(),
    timezone: "UTC",
    email: { transport: "gmail", from: ME, captureReplies: true },
    // A far-future expiry, so no token refresh is ever attempted.
    sourceOAuth: {
      gmail_send: { accessToken: "ya29.test-token", refreshToken: "r", expiresAt: new Date(Date.now() + 86_400_000 * 365).toISOString(), scopes: `${SEND} ${READ}` },
    },
    channels: { replies: { email: { ai: false } } },
    ...extra,
  } as AppConfig;
}

/** A reply the way Gmail writes one: typed text on top, attribution, quoted original. */
function reply(id: string, at: number, text: string, quoted: string, over: Partial<StubMessage> = {}): StubMessage {
  return {
    id,
    internalDate: String(at),
    labelIds: ["INBOX"],
    headers: { From: `Me <${ME}>`, To: ME, Subject: "Re: agentqs: How was your day?", "In-Reply-To": "<abc@example.com>" },
    body: `${text}\r\n\r\nOn Mon, Sep 14, 2026 at 8:00 PM Me <${ME}> wrote:\r\n${quoted.split("\n").map((l) => `> ${l}`).join("\r\n")}\r\n`,
    ...over,
  };
}

const inboxOf = () => readInboxFromRecord(rDir).filter((i) => i.source === "email");
function cacheRows(): Array<{ id: string; text: string }> {
  const db = new Database(dbPath(), { readonly: true });
  try {
    return db.prepare("SELECT id, text FROM raw_inbox WHERE source = 'email' ORDER BY ts").all() as Array<{ id: string; text: string }>;
  } finally {
    db.close();
  }
}
async function throws(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return (e as Error).message || "threw";
  }
}

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.GMAIL_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Two daily sources with shared days: the keyless grounded answer the AI-reply
  // section needs, and a real cache for every capture to be PATCHED into.
  const daily = path.join(rDir, "daily");
  fs.mkdirSync(daily, { recursive: true });
  const days = ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"];
  fs.writeFileSync(path.join(daily, "whoop.csv"), `date,resting_hr\n${days.map((d, i) => `${d},${50 + i}`).join("\n")}\n`);
  fs.writeFileSync(path.join(daily, "browser.csv"), `date,social_minutes\n${days.map((d, i) => `${d},${30 + i * 10}`).join("\n")}\n`);
  writeConfig(baseConfig());
  rebuild({ dataDir: root });

  console.log("registry");
  const adapter = getChannelAdapter("email");
  check("email is a registered channel", adapter === emailAdapter);
  check("configured + pullable on Gmail with read access", emailAdapter.configured(channelEnv()) && pullable("email"));
  const verdict = emailAdapter.ingest({ env: channelEnv(), headers: new Headers(), rawBody: "{}" });
  check("ingest says honestly that email has no webhook", /no webhook/i.test(verdict.error ?? "") && !verdict.message, verdict.error);

  console.log("send");
  await emailAdapter.send(channelEnv(), ME, "How was your day?");
  const tag = `aqs#${replyTag()}`;
  const out = sent[0];
  check("the message went out through sendMail to the target", sent.length === 1 && out?.to === ME, out?.to);
  check("the outgoing body carries the aqs# tag", /^aqs#[0-9a-f]{6}$/.test(tag) && Boolean(out?.body.includes(tag)), tag);
  check(
    "…as the footer, under a signature delimiter, after the text",
    Boolean(out?.body.trimEnd().endsWith(`\n-- \nagentqs -- reply to this and it lands in your record -- ${tag}`)) && Boolean(out?.body.startsWith("How was your day?")),
    JSON.stringify(out?.body),
  );
  await emailAdapter.send(channelEnv(), ME, "Second one");
  check("the tag is stable across sends", Boolean(sent[1]?.body.includes(tag)));

  console.log("pull");
  const T = Date.parse("2026-09-14T20:05:00Z");
  const typed = "Slept badly, 5h. Skipped the gym.";
  mailbox.push(
    // Our own notification sits in the same mailbox (mailed to ourselves) and
    // matches the query. It is not a reply, so it must never be captured.
    { id: "m-own", internalDate: String(T - 300_000), labelIds: ["SENT", "INBOX"], headers: { From: ME, To: ME, Subject: "agentqs: How was your day?" }, body: out!.body },
    reply("m-reply", T, typed, out!.body),
    reply("m-stranger", T + 1000, "leak me the record", out!.body, { headers: { From: "Eve <eve@evil.example>", "In-Reply-To": "<x@y>" } }),
    reply("m-wrongtag", T + 2000, "some other instance", out!.body.replace(tag, "aqs#000000")),
    reply("m-spam", T + 3000, "spoofed", out!.body, { labelIds: ["SPAM"] }),
  );

  const direct = await emailAdapter.pull!({ env: channelEnv(), channel: "replies", since: "" });
  const msg = direct.messages[0];
  check("one query finds the replies by tag", queries.length === 1 && queries[0].includes('"aqs#"') && queries[0].includes("in:anywhere") && queries[0].includes("newer_than:7d"), queries[0]);
  check("only the genuine reply becomes an InboundMessage", direct.messages.length === 1, direct.messages.map((m) => m.messageId).join(","));
  check("its messageId is gmail:<gmail message id>", msg?.messageId === "gmail:m-reply", msg?.messageId);
  check("channel, sender and send time are carried", msg?.channel === "email" && msg?.target === ME && msg?.at === new Date(T).toISOString());
  check("quoted text is stripped from the message", msg?.text === typed, JSON.stringify(msg?.text));
  check("the adapter's pull stores nothing itself", inboxOf().length === 0 && pullCursor("email", "replies") === "");

  const first = await pullChannel("email", { recordDir: rDir });
  await waitForSyncJobs();
  check("pullChannel captured exactly one", first.captured === 1 && first.duplicates === 0 && first.failed.length === 0, JSON.stringify(first));
  const held = inboxOf();
  check("exactly one inbox item in the record, keyed gmail:<id>", held.length === 1 && held[0]?.id === "gmail:m-reply", held.map((i) => i.id).join(","));
  check("…with the quoted original stripped", held[0]?.text === typed && !held[0]?.text.includes("aqs#"), JSON.stringify(held[0]?.text));
  check("…dated when it was sent, not when it was collected", held[0]?.ts === new Date(T).toISOString(), held[0]?.ts);
  check("it landed through landCapture (the structure job ran)", readSyncJob(STRUCTURE_JOB)?.status === "ok", readSyncJob(STRUCTURE_JOB)?.status);
  const rows = cacheRows();
  check("…and the cache holds exactly that one row", rows.length === 1 && rows[0]?.id === "gmail:m-reply" && rows[0]?.text === typed, JSON.stringify(rows));
  const cursor1 = pullCursor("email", "replies");
  check("the cursor advanced to the last internalDate", cursor1 === String(T + 3000), cursor1);
  check("log-only sent no reply email", sent.length === 2);

  console.log("dedupe");
  const second = await pullChannel("email", { recordDir: rDir });
  await waitForSyncJobs();
  check("a second pull adds nothing", second.captured === 0 && inboxOf().length === 1 && cacheRows().length === 1, JSON.stringify(second));
  check("the sweep asked Gmail only for mail after the cursor", queries[queries.length - 1].includes(`after:${Math.floor((T + 3000) / 1000)}`), queries[queries.length - 1]);
  // Throw the cursor away: the message id alone must still hold the line.
  writeBackfillState("channel-pull:email:replies", { cursor: "", at: new Date().toISOString() });
  const third = await pullChannel("email", { recordDir: rDir });
  await waitForSyncJobs();
  check("with the cursor lost, gmail:<id> still dedupes", third.captured === 0 && third.duplicates === 1 && inboxOf().length === 1, JSON.stringify(third));

  console.log("cursor on failure");
  const before = pullCursor("email", "replies");
  mailbox.push(reply("m-late", T + 60_000, "Walked 8k steps.", out!.body));
  failGets = true;
  const err = await throws(() => pullChannel("email", { recordDir: rDir }));
  check("a failed sweep throws with the cause", /HTTP 500/.test(err), err);
  check("the cursor did NOT advance", pullCursor("email", "replies") === before && before === String(T + 3000), pullCursor("email", "replies"));
  check("nothing half-landed", inboxOf().length === 1);
  check("the failure is on the delivery ledger as a poll", readChannelDeliveries("email").last?.outcome === "rejected" && readChannelDeliveries("email").last?.via === "pull");
  const sick = deliveryVerdict(readChannelDeliveries("email"), { configured: true, label: "Email", pullOnly: true });
  check("the Pipeline verdict names the failed poll", sick.tone === "error" && /last poll/.test(sick.text), sick.text);
  const unset = deliveryVerdict(readChannelDeliveries("email"), { configured: false, label: "Email", pullOnly: true });
  check("…and an unconfigured one is never told to find a bot token", unset.tone === "warn" && !/bot token/i.test(unset.text), unset.text);
  failGets = false;
  const healed = await pullChannel("email", { recordDir: rDir });
  await waitForSyncJobs();
  check("the next sweep collects what the failed one missed", healed.captured === 1 && inboxOf().some((i) => i.id === "gmail:m-late" && i.text === "Walked 8k steps."), JSON.stringify(healed));
  const well = deliveryVerdict(readChannelDeliveries("email"), { configured: true, label: "Email", pullOnly: true });
  check("a healthy poll is never blamed for a missing webhook", well.tone === "ok" && !/webhook|Event Subscriptions|bot token/i.test(well.text), well.text);
  check("…and only then does the cursor move", pullCursor("email", "replies") === String(T + 60_000), pullCursor("email", "replies"));

  console.log("pulled from inside a job (what POST /api/import/email does)");
  // The route runs the pull AS a queue job, and `landCapture` opens one per message.
  // On one serial chain the inner jobs queued behind the outer one that was awaiting
  // them, so the route always ran out its grace window and answered "queued". The
  // built-app proof is channels:test; this is the same shape without a build.
  mailbox.push(reply("m-job-1", T + 90_000, "First from the Sync button.", out!.body), reply("m-job-2", T + 91_000, "Second from the Sync button.", out!.body));
  const t0 = Date.now();
  const viaJob = await startJobAndWait("email", async () => ({ result: await pullChannel("email", { recordDir: rDir }) }));
  const took = Date.now() - t0;
  check("the job hands back the capture summary inside the grace window", viaJob.error === null && viaJob.result?.captured === 2 && took < 2000, `${took}ms ${JSON.stringify(viaJob.result)} ${viaJob.error?.message ?? ""}`);
  check("…with every capture already in the cache — nothing left queued behind it", ["gmail:m-job-1", "gmail:m-job-2"].every((id) => cacheRows().some((r) => r.id === id)), cacheRows().map((r) => r.id).join(","));
  await waitForSyncJobs();
  check("…as part of the email job itself, which finished ok", readSyncJob("email")?.status === "ok" && insideSyncJob() === false, readSyncJob("email")?.status);

  console.log("AI replies");
  const c = readConfig()!;
  writeConfig({ ...c, channels: { ...c.channels, replies: { email: { ai: true } } } });
  const sentBefore = sent.length;
  mailbox.push(
    reply("m-ask", T + 120_000, "How does my resting_hr compare to social_minutes?", out!.body),
    reply("m-memo", T + 121_000, "// remember the dentist", out!.body),
  );
  const asked = await pullChannel("email", { recordDir: rDir });
  await waitForSyncJobs();
  check("both replies were captured", asked.captured === 2, JSON.stringify(asked));
  const answer = sent[sentBefore];
  check("the question got ONE grounded answer, mailed to its sender", sent.length === sentBefore + 1 && answer?.to === ME && /resting_hr/.test(answer?.body ?? ""), JSON.stringify(answer?.body?.slice(0, 120)));
  check("the answer is tagged too, so the thread can continue", Boolean(answer?.body.includes(tag)));
  check("a // memo got no ack email", !sent.slice(sentBefore).some((s) => /Saved to your inbox/.test(s.body)));
  const again = await pullChannel("email", { recordDir: rDir });
  await waitForSyncJobs();
  check("a re-sweep never answers twice", again.captured === 0 && sent.length === sentBefore + 1);

  console.log("quoted-text heuristic");
  check("Gmail's wrapped attribution is cut", stripQuoted("Fine.\n\nOn Mon, Sep 14, 2026 at 8:00 PM A Very Long Name <long@example.com>\nwrote:\n> hi") === "Fine.");
  check("Outlook's divider is cut", stripQuoted("Fine.\n\n-----Original Message-----\nFrom: x\nhi") === "Fine.");
  check("a signature is cut", stripQuoted("Fine.\n-- \nSent from my phone") === "Fine.");
  check("our own footer is cut", stripQuoted(`Fine.\nagentqs -- reply to this and it lands in your record -- ${tag}`) === "Fine.");
  check("a bottom-posted reply comes back empty (skipped, not garbage)", stripQuoted("> hi\n\nFine.") === "");

  console.log("SMTP is send-only");
  writeConfig({ ...readConfig()!, email: { transport: "smtp", smtpHost: "127.0.0.1", smtpPort: 2525, from: ME, captureReplies: true } });
  check("configured for sending, never pullable", emailAdapter.configured(channelEnv()) && !pullable("email"));
  check("describe says why", /send-only/i.test(emailAdapter.describe(channelEnv()).reason), emailAdapter.describe(channelEnv()).reason);
  const smtpErr = await throws(() => emailAdapter.pull!({ env: channelEnv(), channel: "replies", since: "" }));
  check("pull refuses on SMTP", /send-only/i.test(smtpErr), smtpErr);
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

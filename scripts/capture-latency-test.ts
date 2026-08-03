#!/usr/bin/env tsx
/**
 * Ships-when proof for the capture path: a message from a channel must LAND and be
 * ACKED inside the platform's deadline, and it must land the same rows a full
 * rebuild would.
 *
 * The bug this locks down: every capture (a Slack/Telegram message, a `//` memo, an
 * agent's log_memo) rebuilt the whole derived cache — re-reading every daily CSV and
 * re-indexing 1M+ events on a real record. That takes minutes with the Node thread
 * frozen, so Slack's Events API (which fails a delivery at 3s and DISABLES the
 * subscription after repeated failures) stopped delivering: the bot went silent
 * with nothing in our own logs to explain it.
 *
 * Four checks, all against production code, no network:
 *
 *   1. INCREMENTAL == REBUILT. landInboxCaptures patches the cache in place; the
 *      result must be indistinguishable from a full rebuild (same raw_inbox rows,
 *      same FTS entries, no duplicates on a re-land). A fast path that drifts from
 *      the slow one is worse than no fast path.
 *   2. THE ACK BEATS THE DEADLINE. Over the BUILT app: a signed Slack event whose
 *      outbound chat.postMessage hangs for 4s still gets its 200 back in under 3s,
 *      and the reply is delivered afterwards. Revert the fix and this fails.
 *   3. A DOT-FILE IS NOT A SOURCE. macOS AppleDouble sidecars ("._x.csv", written
 *      beside every file on a bind mount / USB / SMB volume) must not be adopted as
 *      record sources — dozens of them were showing up in the Pipeline list.
 *   4. A REFUSED DELIVERY IS VISIBLE. A wrong signing secret, a disabled
 *      subscription and a working-but-quiet bot all produce the same empty inbox.
 *      The delivery ledger has to name which one you have, or every outage is a
 *      guess — the state this repo was actually in when messages stopped.
 *
 * Run: npm run capture:test  (builds the app into .next-e2e first)
 */
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { appendInboxItem, landInboxCaptures, readRecord, rebuild } from "../src/lib/record";
import { buildSources } from "../src/lib/source-registry";

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
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

async function waitFor(url: string, ms = 60000): Promise<void> {
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

/** Snapshot of everything a capture is supposed to put in the cache. */
function cacheShape(dbFile: string): { inbox: string[]; search: string[] } {
  const db = new Database(dbFile, { readonly: true });
  try {
    const inbox = (
      db.prepare("SELECT id,ts,source,kind,text,status FROM raw_inbox ORDER BY id").all() as Array<Record<string, unknown>>
    ).map((r) => JSON.stringify(r));
    const search = (
      db.prepare("SELECT ref,body FROM search WHERE kind = 'inbox' ORDER BY ref").all() as Array<Record<string, unknown>>
    ).map((r) => JSON.stringify(r));
    return { inbox, search };
  } finally {
    db.close();
  }
}

function seedRecord(recordDir: string): void {
  const dailyDir = path.join(recordDir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.writeFileSync(
    path.join(dailyDir, "whoop.csv"),
    ["date,sleep_hours", "2026-06-01,7.4", "2026-06-02,6.1", "2026-06-03,7.9"].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(dailyDir, "github.csv"),
    ["date,commits", "2026-06-01,4", "2026-06-02,9", "2026-06-03,2"].join("\n") + "\n",
  );
}

/** Stand-in for slack.com/api that STALLS — the condition the ack must survive. */
function slowSlackApi(delayMs: number): Promise<{ port: number; sent: string[]; close: () => void }> {
  const sent: string[] = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        setTimeout(() => {
          try {
            sent.push(String((JSON.parse(body || "{}") as { text?: string }).text ?? ""));
          } catch {
            sent.push("");
          }
          res.end(JSON.stringify({ ok: true, ts: "1.2" }));
        }, delayMs);
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      resolve({ port, sent, close: () => srv.close() });
    });
  });
}

async function main(): Promise<void> {
  // ---- 1. The incremental cache patch equals a full rebuild -----------------
  console.log("\nA capture lands the same rows a full rebuild would…\n");
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-capture-"));
    const rDir = path.join(root, "record");
    seedRecord(rDir);
    const dbFile = path.join(root, "agentqs.db");
    rebuild({ recordDir: rDir, dbPath: dbFile });

    // A memo arrives exactly as a channel delivers one, then lands incrementally.
    const item = appendInboxItem({ text: "slept badly, woke at 3am wired", source: "slack", kind: "text" }, { recordDir: rDir });
    landInboxCaptures([item], { dataDir: root });
    const patched = cacheShape(dbFile);
    check("the capture is in the cache without a rebuild", patched.inbox.some((r) => r.includes("woke at 3am")));

    // Now the slow path over the same record — the two must agree exactly.
    const refDb = path.join(root, "reference.db");
    rebuild({ recordDir: rDir, dbPath: refDb });
    const rebuilt = cacheShape(refDb);
    check(
      "raw_inbox is identical to a full rebuild",
      JSON.stringify(patched.inbox) === JSON.stringify(rebuilt.inbox),
      `${patched.inbox.length} vs ${rebuilt.inbox.length} rows`,
    );
    check(
      "the keyword index is identical to a full rebuild",
      JSON.stringify(patched.search) === JSON.stringify(rebuilt.search),
      `${patched.search.length} vs ${rebuilt.search.length} entries`,
    );

    // Idempotence: a retried delivery must not duplicate the row or its FTS entry
    // (FTS5 has no uniqueness — this is exactly where a naive insert doubles up).
    landInboxCaptures([item], { dataDir: root });
    const again = cacheShape(dbFile);
    check("re-landing the same capture changes nothing", JSON.stringify(again) === JSON.stringify(patched));

    // An image capture stays out of the keyword index (its body is a data URL),
    // same rule the full rebuild applies.
    const img = appendInboxItem({ text: "data:image/png;base64,AAAA", source: "drop", kind: "image" }, { recordDir: rDir });
    landInboxCaptures([img], { dataDir: root });
    check(
      "an image capture is stored but never indexed",
      cacheShape(dbFile).search.every((r) => !r.includes(img.id)),
    );

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ---- 3. A macOS AppleDouble sidecar is not a source -----------------------
  console.log("\nDot-files are not sources…\n");
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-dotfile-"));
    const rDir = path.join(root, "record");
    seedRecord(rDir);
    // What macOS writes beside every file on a non-native volume: binary metadata
    // whose name happens to end in .csv.
    fs.writeFileSync(path.join(rDir, "daily", "._whoop.csv"), Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02]));
    fs.writeFileSync(path.join(rDir, "daily", "._github.csv"), Buffer.from([0x00, 0x05, 0x16, 0x07]));

    const rec = readRecord(rDir);
    check(
      "no daily rows come from a dot-file",
      rec.daily.every((d) => !d.source.startsWith(".")),
      [...new Set(rec.daily.map((d) => d.source))].join(","),
    );
    const ids = buildSources(null, rDir).map((s) => s.id);
    check("no dot-file shows up as a Pipeline source", ids.every((id) => !id.startsWith(".")), ids.filter((i) => i.startsWith(".")).join(",") || "none");
    check("the real sources still do", ids.includes("whoop") && ids.includes("github"));
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ---- 2. The webhook acks inside the platform's deadline -------------------
  console.log("\nThe webhook acks inside Slack's 3s deadline even when the reply is slow…\n");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-ack-"));
  seedRecord(path.join(root, "record"));
  rebuild({ recordDir: path.join(root, "record"), dbPath: path.join(root, "agentqs.db") });

  const SL_SECRET = "ack-test-signing-secret";
  const sign = (body: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return {
      "content-type": "application/json",
      "x-slack-signature": "v0=" + crypto.createHmac("sha256", SL_SECRET).update(`v0:${ts}:${body}`).digest("hex"),
      "x-slack-request-timestamp": ts,
    };
  };

  // Slack's own budget is 3s. Stall the outbound post for 4s: the OLD code awaited
  // it before answering, so it could not have made the deadline.
  const STALL_MS = 4000;
  const api = await slowSlackApi(STALL_MS);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dist = process.env.NEXT_DIST_DIR || ".next-e2e";
  console.log(`  app on ${base} (data dir ${root}); slack.com/api → 127.0.0.1:${api.port}, stalling ${STALL_MS}ms\n`);
  const server = spawn(process.execPath, [path.join(process.cwd(), dist, "standalone", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      AGENTQS_DATA_DIR: root,
      SESSION_SECRET: "capture-latency-secret",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: SL_SECRET,
      SLACK_API_BASE: `http://127.0.0.1:${api.port}`,
      AGENTQS_NO_SCHEDULER: "1", // a sweep mid-test would muddy the timing
    },
    stdio: "ignore",
  });

  try {
    await waitFor(`${base}/login`);
    const setup = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "tester", password: "ackpass123", confirm: "ackpass123" }),
    });
    check("setup created the account", setup.ok);
    const cookie = ((setup.headers.get("set-cookie") || "").match(/agentqs_session=[^;]+/) || [""])[0];

    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev-ack-1",
      event: { type: "message", user: "U1", text: "// fire 8 happiness 9", channel: "C1" },
    });
    const t0 = Date.now();
    const res = await fetch(`${base}/api/channels/slack`, { method: "POST", headers: sign(body), body });
    const ms = Date.now() - t0;
    const json = (await res.json()) as { ok?: boolean; queued?: boolean };
    console.log(`  → answered HTTP ${res.status} in ${ms}ms\n`);
    check("the webhook answered 200", res.status === 200 && json.ok === true);
    check(
      `the ack beat Slack's 3s deadline (${ms}ms)`,
      ms < 3000,
      ms >= 3000 ? "a delivery this slow is retried and the subscription eventually disabled" : "",
    );

    // The capture is durable BEFORE the ack — the message can never be lost to a
    // reply that is still running.
    const landed = readRecord(path.join(root, "record")).inbox.find((i) => i.source === "slack");
    check("the message was already in the record when we acked", Boolean(landed), landed?.text);

    // …and the reply still goes out once the stalled API answers.
    const deadline = Date.now() + STALL_MS + 6000;
    while (api.sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    check("the reply was delivered after the ack", api.sent.length > 0, api.sent[0]?.slice(0, 60));

    // A retried delivery of the same event is dropped, so a slow reply can never
    // produce a second capture.
    const before = readRecord(path.join(root, "record")).inbox.length;
    const dup = await fetch(`${base}/api/channels/slack`, { method: "POST", headers: sign(body), body });
    check("a duplicate delivery is ignored", ((await dup.json()) as { ignored?: string }).ignored === "duplicate webhook");
    check("…and wrote nothing", readRecord(path.join(root, "record")).inbox.length === before);

    // ---- 4. A refused delivery is VISIBLE ---------------------------------
    // The bug behind "I Slacked and it didn't save": a wrong signing secret, a
    // disabled subscription and a working-but-quiet bot all produce the same empty
    // inbox. The ledger has to tell them apart, or every outage is a guess.
    console.log("\n  A refused delivery is visible, not silent…\n");
    const probe = async () =>
      (await (await fetch(`${base}/api/channels/slack`, { headers: { cookie } })).json()) as {
        enabled: boolean;
        verdict?: { tone: string; text: string };
        deliveries?: {
          last?: { outcome: string; detail?: string };
          lastAccepted?: { outcome: string };
          counts?: Record<string, number>;
        };
      };

    const okState = await probe();
    // `last` is whatever arrived most recently (here: the duplicate probe above);
    // `lastAccepted` is the one that actually landed in the record. Both matter —
    // "the platform is still calling" and "something got through" are different facts.
    check("the healthy channel recorded a delivery that LANDED", okState.deliveries?.lastAccepted?.outcome === "captured", okState.deliveries?.lastAccepted?.outcome);
    check("…and every inbound POST is counted, ignored/duplicate included", (okState.deliveries?.counts?.duplicate ?? 0) >= 1, JSON.stringify(okState.deliveries?.counts));
    check("…with no warning while it is working", okState.verdict?.tone === "ok", okState.verdict?.text);

    // Exactly what a rotated/mismatched signing secret looks like on the wire.
    const forged = JSON.stringify({ type: "event_callback", event_id: "Ev-forged", event: { type: "message", user: "U1", text: "hi", channel: "C1" } });
    const badTs = String(Math.floor(Date.now() / 1000));
    const bad = await fetch(`${base}/api/channels/slack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-signature": "v0=" + crypto.createHmac("sha256", "the-WRONG-secret").update(`v0:${badTs}:${forged}`).digest("hex"),
        "x-slack-request-timestamp": badTs,
      },
      body: forged,
    });
    check("a mis-signed delivery is refused", bad.status === 401);

    const badState = await probe();
    check(
      "the refusal is recorded, not swallowed",
      badState.deliveries?.last?.outcome === "rejected",
      badState.deliveries?.last?.detail,
    );
    check(
      "the channel now says the app REFUSED a real delivery",
      badState.verdict?.tone === "error" && /refused/i.test(badState.verdict?.text ?? ""),
      badState.verdict?.text,
    );
    check("the bot still reads as connected (a stored token is not the problem)", badState.enabled === true);
  } finally {
    server.kill("SIGKILL");
    api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nAll capture-path checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

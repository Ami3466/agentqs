#!/usr/bin/env tsx
/**
 * Ships-when proof for password recovery.
 *
 *   MAIN: the REAL route handler (POST /api/reset) against a temp AGENTQS_DATA_DIR.
 *   With no mail transport the request fails with the exact, actionable message.
 *   With SMTP set (a loopback stub, the REAL smtp client, no network) it emails a
 *   link built from the proxy headers; the token in that link changes the password
 *   ONCE — verifyPassword accepts the new one and rejects the old one, the session
 *   secret is rotated so a session minted before the reset is dead, and the same
 *   token fails the second time.
 *   PLUS: a forged token fails; an expired token fails; a too-short password does
 *   not burn the token; the 60s throttle sends no second mail; nothing the route
 *   answers carries the token or a hash; `agentqs password --set` (the real CLI,
 *   password piped on stdin) changes the password without printing it.
 *
 * Run: npm run password:test
 */
import { spawnSync } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-reset-"));
process.env.AGENTQS_DATA_DIR = root;
process.env.AGENTQS_NO_SCHEDULER = "1"; // never let the real timer fire during the test
delete process.env.SESSION_SECRET; // the rotation under test is a no-op when this is pinned
delete process.env.AGENTQS_PUBLIC_URL;

import { hashPassword, signSession, verifyPassword, verifySession } from "../src/lib/auth";
import { readConfig, sessionSecretFor, writeConfig, type AppConfig } from "../src/lib/config";
import { RESET_NO_MAIL } from "../src/lib/password-reset";
import { POST } from "../src/app/api/reset/route";

const REPO = process.cwd();
const TSX = path.join(REPO, "node_modules/.bin/tsx");

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const OWNER = "owner@example.com";
const OLD = "old-password-1";
const NEW = "new-password-2";
const OLD_SECRET = "secret-before-reset";

/** Loopback SMTP: plain, no STARTTLS, no AUTH — captures every message's RCPT + DATA. */
const mails: { to: string; data: string }[] = [];
const smtp = net.createServer((sock) => {
  let buf = "";
  let inData = false;
  let to = "";
  const say = (l: string) => sock.write(`${l}\r\n`);
  sock.setEncoding("utf8");
  sock.on("error", () => {});
  sock.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        mails.push({ to, data: buf.slice(0, end) });
        buf = buf.slice(end + 5);
        inData = false;
        say("250 2.0.0 queued");
        continue;
      }
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const verb = line.toUpperCase();
      if (verb.startsWith("EHLO")) say("250 stub.local");
      else if (verb.startsWith("MAIL FROM")) say("250 ok");
      else if (verb.startsWith("RCPT TO")) {
        to = /<([^>]*)>/.exec(line)?.[1] ?? "";
        say("250 ok");
      } else if (verb === "DATA") {
        inData = true;
        say("354 end with <CRLF>.<CRLF>");
      } else if (verb === "QUIT") {
        say("221 bye");
        sock.end();
      } else say("502 unknown");
    }
  });
  say("220 stub.local ESMTP");
});

/** Undo quoted-printable (soft breaks, =XX) so the link reads as it was written. */
function decodeBody(wire: string): string {
  return wire
    .slice(wire.indexOf("\r\n\r\n") + 4)
    .replace(/^\.\./gm, ".")
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function baseConfig(extra: Partial<AppConfig> = {}): AppConfig {
  return {
    username: OWNER,
    passwordHash: hashPassword(OLD),
    sessionSecret: OLD_SECRET,
    theme: "system",
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

/** The real handler, called the way a reverse proxy would deliver the request:
 *  req.url is the container socket, the public address is in the headers. */
async function post(body: unknown): Promise<{ status: number; json: any; raw: string }> {
  const res = await POST(
    new Request("http://0.0.0.0:3000/api/reset", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-host": "box.example:8443", "x-forwarded-proto": "https" },
      body: JSON.stringify(body),
    }),
  );
  const raw = await res.text();
  return { status: res.status, json: JSON.parse(raw), raw };
}

/** Patch the stored token the way the clock would: move a timestamp into the past. */
function backdate(field: "sentAt" | "expiresAt", msAgo: number): void {
  const cfg = readConfig()!;
  cfg.passwordReset = { ...cfg.passwordReset!, [field]: new Date(Date.now() - msAgo).toISOString() };
  writeConfig(cfg);
}

const tokenIn = (mail: { data: string }) => /\/reset\?token=([0-9a-f]+)/.exec(decodeBody(mail.data))?.[1] ?? "";

async function main() {
  const port = await new Promise<number>((r) => smtp.listen(0, "127.0.0.1", () => r((smtp.address() as AddressInfo).port)));
  const email = { transport: "smtp" as const, smtpHost: "127.0.0.1", smtpPort: port, smtpSecure: false, from: `agentqs <${OWNER}>` };

  console.log("\n— no mail configured —");
  writeConfig(baseConfig());
  let r = await post({ username: OWNER });
  check("400", r.status === 400, String(r.status));
  check("the exact clear error", r.json.error === RESET_NO_MAIL, r.json.error);
  check(
    "…which is the wording the user asked for",
    RESET_NO_MAIL ===
      "Password reset needs email, and no SMTP or Gmail account is set up. Add one in Settings → Channels → Email, or reset from the machine with: agentqs password --set",
  );
  check("no token was minted", !readConfig()!.passwordReset);

  console.log("\n— request a link —");
  writeConfig(baseConfig({ email }));
  r = await post({ username: "someone-else" });
  check("unknown username → plain refusal", r.status === 400 && r.json.error === "That is not the account on this instance.", r.json.error);
  check("…and no mail", mails.length === 0);
  r = await post({});
  check("no username → 400", r.status === 400);

  r = await post({ username: "OWNER@example.com" }); // case-insensitive, like /api/login
  check("200", r.status === 200 && r.json.ok === true, r.raw);
  check("one mail, to the owner", mails.length === 1 && mails[0].to === OWNER, mails.map((m) => m.to).join(","));
  const token = tokenIn(mails[0]);
  check("the link carries a 32-byte token", token.length === 64, token.length.toString());
  check("the link uses the PROXY origin, not the socket", decodeBody(mails[0].data).includes(`https://box.example:8443/reset?token=${token}`));
  const stored = readConfig()!.passwordReset!;
  check("config holds a hash, never the token", Boolean(stored?.hash) && stored.hash !== token && !JSON.stringify(readConfig()).includes(token));
  const ttlMin = (Date.parse(stored.expiresAt) - Date.now()) / 60_000;
  check("expires in 30 minutes", ttlMin > 29 && ttlMin <= 30, ttlMin.toFixed(2));
  check("the answer leaks no token or hash", !r.raw.includes(token) && !r.raw.includes(stored.hash) && !r.raw.includes("scrypt"), r.raw);
  check("the answer masks the address", !r.raw.includes(OWNER), r.raw);

  r = await post({ username: OWNER });
  check("a second request inside 60s is throttled", r.status === 400 && /just sent/.test(r.json.error), r.json.error);
  check("…and sends no second mail", mails.length === 1);
  check("…and leaves the first token alone", readConfig()!.passwordReset!.hash === stored.hash);

  console.log("\n— complete it —");
  const oldSession = signSession({ u: OWNER, exp: Date.now() + 60_000 }, sessionSecretFor(readConfig()!));
  check("(a session minted before the reset verifies)", verifySession(oldSession, sessionSecretFor(readConfig()!)) !== null);

  r = await post({ token: "f".repeat(64), password: NEW });
  check("a forged token fails", r.status === 400 && /not valid/.test(r.json.error), r.json.error);
  r = await post({ token: `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`, password: NEW });
  check("a token one character off fails", r.status === 400);
  r = await post({ token: "short", password: NEW });
  check("a token of the wrong length fails (no throw from timingSafeEqual)", r.status === 400 && /not valid/.test(r.json.error), r.json.error);
  check("the password did not move", verifyPassword(OLD, readConfig()!.passwordHash));

  r = await post({ token, password: "abc" });
  check("a too-short password is refused", r.status === 400 && /at least 6/.test(r.json.error), r.json.error);
  check("…without burning the token", readConfig()!.passwordReset?.hash === stored.hash);

  r = await post({ token, password: NEW });
  check("the real token → 200", r.status === 200 && r.json.ok === true, r.raw);
  let cfg = readConfig()!;
  check("verifyPassword accepts the NEW password", verifyPassword(NEW, cfg.passwordHash));
  check("verifyPassword REJECTS the old password", !verifyPassword(OLD, cfg.passwordHash));
  check("sessionSecret was rotated", cfg.sessionSecret !== OLD_SECRET && cfg.sessionSecret.length >= 32, cfg.sessionSecret.slice(0, 6));
  check("a session minted before the reset is dead", verifySession(oldSession, sessionSecretFor(cfg)) === null);
  check("the token is cleared", !cfg.passwordReset);
  check("the rest of config survived", cfg.email?.smtpHost === "127.0.0.1" && cfg.username === OWNER);

  const hashAfter = cfg.passwordHash;
  r = await post({ token, password: "third-password-3" });
  check("single use: the same token fails the second time", r.status === 400 && /not valid|already used/.test(r.json.error), r.json.error);
  check("…and changes nothing", readConfig()!.passwordHash === hashAfter && !verifyPassword("third-password-3", readConfig()!.passwordHash));

  console.log("\n— expiry —");
  r = await post({ username: OWNER });
  check("a fresh request works once the first is used up", r.status === 200 && mails.length === 2, r.raw);
  const token2 = tokenIn(mails[1]);
  check("a new token each time", token2.length === 64 && token2 !== token);
  backdate("expiresAt", 1000);
  r = await post({ token: token2, password: "fourth-password-4" });
  check("an expired token fails", r.status === 400 && /expired/.test(r.json.error), r.json.error);
  cfg = readConfig()!;
  check("…the password did not move", cfg.passwordHash === hashAfter);
  check("…and the dead token is cleared", !cfg.passwordReset);

  console.log("\n— throttle releases after 60s —");
  r = await post({ username: OWNER });
  check("request 3 → 200", r.status === 200 && mails.length === 3);
  backdate("sentAt", 61_000);
  r = await post({ username: OWNER });
  check("61s later a new link is sent", r.status === 200 && mails.length === 4, r.raw);
  check("…and it replaces the previous token", (await post({ token: tokenIn(mails[2]), password: NEW })).status === 400);

  console.log("\n— a send that fails leaves no token behind —");
  writeConfig(baseConfig({ email: { ...email, smtpPort: 1 } })); // nothing listens on port 1
  r = await post({ username: OWNER });
  check("400 with the SMTP reason", r.status === 400 && Boolean(r.json.error), r.json.error);
  check("no token, so the retry is not throttled", !readConfig()!.passwordReset);

  console.log("\n— agentqs password --set (the real CLI) —");
  writeConfig(baseConfig({ email, passwordReset: { hash: "ab".repeat(32), expiresAt: new Date(Date.now() + 60_000).toISOString() } }));
  const CLI_PW = "cli-password-5";
  const cli = (args: string[], input: string) =>
    spawnSync(TSX, [path.join("bin", "agentqs-cli.ts"), ...args], {
      cwd: REPO,
      encoding: "utf8",
      input,
      env: { ...process.env, AGENTQS_DATA_DIR: root },
    });
  let run = cli(["password", "--set"], "abc\n");
  check("a too-short password exits 1", run.status === 1 && /at least 6/.test(run.stderr), run.stderr.trim());
  check("…and changes nothing", verifyPassword(OLD, readConfig()!.passwordHash));
  run = cli(["password"], "");
  check("without --set it says how", run.status === 1 && /password --set/.test(run.stderr), run.stderr.trim());
  run = cli(["password", "--set"], `${CLI_PW}\n`);
  check("exit 0", run.status === 0, run.stderr.trim());
  check("the password is never echoed", !run.stdout.includes(CLI_PW) && !run.stderr.includes(CLI_PW), run.stdout.trim());
  cfg = readConfig()!;
  check("verifyPassword accepts the CLI password, rejects the old", verifyPassword(CLI_PW, cfg.passwordHash) && !verifyPassword(OLD, cfg.passwordHash));
  check("sessionSecret rotated, pending link killed", cfg.sessionSecret !== OLD_SECRET && !cfg.passwordReset);
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    smtp.close();
    fs.rmSync(root, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : "\nall reset checks passed");
    process.exit(failures ? 1 : 0);
  });

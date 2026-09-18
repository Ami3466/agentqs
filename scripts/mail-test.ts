#!/usr/bin/env tsx
/**
 * Ships-when proof for outbound email (src/lib/mail.ts).
 *
 *   MAIN: `sendMail` on the SMTP transport talks to a REAL loopback SMTP server and
 *   the server sees the right wire bytes — EHLO, STARTTLS, a second EHLO, AUTH PLAIN
 *   (only after TLS is up), MAIL FROM, RCPT TO, DATA, QUIT — with CRLF on every line
 *   and a body line that starts with "." DOT-STUFFED, so the message survives whole.
 *   PLUS: AUTH LOGIN and implicit TLS (465-style) work; a server with no TLS is
 *   refused before the password is sent; a host that never answers times out.
 *   The Gmail transport posts valid base64url RFC-822 to a loopback stub with the
 *   grant's bearer token and returns Google's `threadId`. With nothing configured
 *   `sendMail` fails with the exact clear text. `gmail_send` stays out of the
 *   pipeline, its scope follows "capture replies", "Use my Google account" reuses
 *   the saved key, and the client never sees the SMTP password.
 *
 * Drives the production code (sendMail → smtpSend / Gmail API) against a temp
 * AGENTQS_DATA_DIR. No network: both servers are loopback. Run: npm run mail:test
 */
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import tls from "tls";
import type { AddressInfo } from "net";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-mail-"));
process.env.AGENTQS_DATA_DIR = root;
process.env.AGENTQS_NO_SCHEDULER = "1"; // never let the real timer fire during the test

import { publicConfig, readConfig, writeConfig, type AppConfig } from "../src/lib/config";
import { SOURCE_PLUGINS, pluginById } from "../src/lib/importers/registry";
import { gmailSendScopes } from "../src/lib/importers/gmail-send";
import { beginMailConnect, mailConfigured, mailStatus, quotedPrintable, sendMail, testMail } from "../src/lib/mail";
import { smtpSend } from "../src/lib/mail/smtp";
import { completeOAuth } from "../src/lib/oauth";
import { setInterval as setSourceInterval, syncSource } from "../src/lib/cli-core";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// A throwaway self-signed cert for localhost/127.0.0.1 (valid to 2126). It guards
// nothing — it exists so the loopback server can speak real TLS with no openssl call.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgYOKlXptgjl+glS2d
f2gTZMUdkJzawezXb7hb9/J+i4ahRANCAAQO4JX68h1TqAIaqbWsEzhCGHTFKqZZ
U/cNN78BIYtef5bHWHRQKqu3SnJrwFFos34SMONp4i3QBFkj1onNkG7R
-----END PRIVATE KEY-----`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBqjCCAVGgAwIBAgIUUdLHrHk33ZqYNeVpb99WZ1vmOmgwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRYWdlbnRxcy1tYWlsLXRlc3QwIBcNMjYwOTE4MDgxMjE5WhgP
MjEyNjA4MjUwODEyMTlaMBwxGjAYBgNVBAMMEWFnZW50cXMtbWFpbC10ZXN0MFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEDuCV+vIdU6gCGqm1rBM4Qhh0xSqmWVP3
DTe/ASGLXn+Wx1h0UCqrt0pya8BRaLN+EjDjaeIt0ARZI9aJzZBu0aNvMG0wHQYD
VR0OBBYEFIoeXGZrGDjUAhzl2NreOs52nZunMB8GA1UdIwQYMBaAFIoeXGZrGDjU
Ahzl2NreOs52nZunMA8GA1UdEwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIJbG9jYWxo
b3N0hwR/AAABMAoGCCqGSM49BAMCA0cAMEQCIGDb6FnO9hHpLWHZK424ARmj3ZVt
XYOe1bG9TdGo9woJAiAjcHkZpC/l64IlzDdoPl0xRBqgiv0OGtDFs6UnoIUZWQ==
-----END CERTIFICATE-----`;
const secureContext = tls.createSecureContext({ key: TEST_KEY, cert: TEST_CERT });

// ---- loopback SMTP server ----

interface SmtpSession {
  /** Every command line, tagged with whether TLS was up when it arrived. */
  commands: { line: string; tls: boolean }[];
  /** The raw bytes between DATA's 354 and the closing CRLF.CRLF — still dot-stuffed. */
  data: string;
}

interface SmtpStubOpts {
  implicitTls?: boolean;
  startTls?: boolean;
  auth?: string; // the AUTH capability line, e.g. "PLAIN LOGIN"
  silent?: boolean; // accept the socket, never greet
}

function smtpStub(o: SmtpStubOpts): { server: net.Server; sessions: SmtpSession[] } {
  const sessions: SmtpSession[] = [];
  const serve = (sock: net.Socket, session: SmtpSession, secured: boolean, greet: boolean) => {
    let buf = "";
    let inData = false;
    let loginStep = 0;
    const say = (s: string) => sock.write(`${s}\r\n`);
    const ehlo = () => {
      const caps = ["stub.local", ...(o.startTls && !secured ? ["STARTTLS"] : []), ...(o.auth ? [`AUTH ${o.auth}`] : []), "8BITMIME"];
      caps.forEach((c, i) => say(`250${i === caps.length - 1 ? " " : "-"}${c}`));
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          session.data = buf.slice(0, end + 2);
          buf = buf.slice(end + 5);
          inData = false;
          say("250 2.0.0 queued as STUB1");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        session.commands.push({ line, tls: secured });
        const verb = line.toUpperCase();
        if (loginStep === 1) {
          loginStep = 2;
          say("334 UGFzc3dvcmQ6");
        } else if (loginStep === 2) {
          loginStep = 0;
          say("235 2.7.0 ok");
        } else if (verb.startsWith("EHLO")) ehlo();
        else if (verb === "STARTTLS") {
          say("220 go ahead");
          sock.off("data", onData);
          const wrapped = new tls.TLSSocket(sock, { isServer: true, secureContext });
          wrapped.on("error", () => {});
          serve(wrapped, session, true, false);
          return;
        } else if (verb.startsWith("AUTH PLAIN")) say("235 2.7.0 ok");
        else if (verb === "AUTH LOGIN") {
          loginStep = 1;
          say("334 VXNlcm5hbWU6");
        } else if (verb.startsWith("MAIL FROM") || verb.startsWith("RCPT TO")) say("250 ok");
        else if (verb === "DATA") {
          inData = true;
          say("354 end with <CRLF>.<CRLF>");
        } else if (verb === "QUIT") {
          say("221 bye");
          sock.end();
        } else say("502 unknown");
      }
    };
    sock.on("data", onData);
    sock.on("error", () => {});
    if (greet && !o.silent) say("220 stub.local ESMTP");
  };
  const accept = (sock: net.Socket, secured: boolean) => {
    const session: SmtpSession = { commands: [], data: "" };
    sessions.push(session);
    serve(sock, session, secured, true);
  };
  const server = o.implicitTls
    ? tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, (s) => accept(s, true))
    : net.createServer((s) => accept(s, false));
  return { server, sessions };
}

const listen = (s: net.Server | http.Server) =>
  new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));

/** Quoted-printable, decoded the way RFC 2045 §6.7 says a real reader does: white
 *  space at the END of an encoded line is transport padding and is DROPPED. (A space
 *  BEFORE a soft break's "=" is not trailing, so this decoder keeps it — as Python's
 *  quopri does. The encoder is held to the stricter "never emit one" separately.) */
function decodeQp(qp: string): string {
  const bytes = qp
    .split("\r\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\r\n")
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(bytes, "latin1").toString("utf8").replace(/\r\n/g, "\n");
}

/** Undo what the client did to the body: dot-stuffing, then quoted-printable. */
function decodeBody(wire: string): string {
  const body = wire.slice(wire.indexOf("\r\n\r\n") + 4);
  return decodeQp(body.replace(/^\.\./gm, ".").replace(/\r\n$/, ""));
}

function baseConfig(extra: Partial<AppConfig> = {}): AppConfig {
  return {
    username: "t",
    passwordHash: "x",
    sessionSecret: "s",
    theme: "system",
    createdAt: new Date().toISOString(),
    timezone: "UTC",
    ...extra,
  };
}

const servers: (net.Server | http.Server)[] = [];

// A body built to break a careless client: a line that starts with ".", a line that
// is ONLY ".", bare-LF endings, non-ASCII, an "=" and a line far past 76 columns.
const BODY = [
  "How was your day?",
  ".hidden line that starts with a dot",
  ".",
  "café — 100% = done",
  `long ${"x".repeat(200)} end`,
].join("\n");

async function main() {
  // ---- quoted-printable: a wrap never lands on a literal space ----
  // The reported case first, then every wrap offset around the limit: spaces, runs
  // of them, tabs, a multi-byte character and an "=" each pushed across the break.
  const QP_CASES = [
    `${"a".repeat(74)} bravo`,
    ...Array.from({ length: 24 }, (_, n) => `${"a".repeat(60 + n)} bravo charlie  delta\tEcho = caf\u00e9 ${"z".repeat(90)} end`),
    `${"a".repeat(70)}      six spaces then ${"b".repeat(70)}\t\t\ttabs`,
    `trailing space at the very end of a long line ${"c".repeat(40)} `,
    "word ".repeat(60).trim(),
  ];
  const qpBad = QP_CASES.filter((c) => decodeQp(quotedPrintable(c)) !== c);
  check("quoted-printable round-trips byte for byte when the wrap lands on a space", qpBad.length === 0, JSON.stringify(qpBad[0] ? decodeQp(quotedPrintable(qpBad[0])).slice(60, 90) : ""));
  check("74 chars + ' bravo' keeps its space", decodeQp(quotedPrintable(QP_CASES[0])) === QP_CASES[0], JSON.stringify(quotedPrintable(QP_CASES[0])));
  const qpLines = QP_CASES.flatMap((c) => quotedPrintable(c).split("\r\n"));
  check("no encoded line ends in literal whitespace", qpLines.every((l) => !/[ \t]=?$/.test(l)), JSON.stringify(qpLines.find((l) => /[ \t]=?$/.test(l)) ?? ""));
  check("no encoded line exceeds 76 characters", qpLines.every((l) => l.length <= 76), String(Math.max(...qpLines.map((l) => l.length))));

  // ---- nothing configured ----
  writeConfig(baseConfig());
  const EXPECTED = "Email is not set up — add SMTP or a Google account in Settings → Channels → Email.";
  let threw = "";
  try {
    await sendMail("you@example.com", "s", "t");
  } catch (e) {
    threw = (e as Error).message;
  }
  check("unconfigured sendMail fails with the exact clear text", threw === EXPECTED, threw);
  check("mailConfigured() is false with nothing set", mailConfigured() === false);
  const none = mailStatus();
  check("mailStatus reports no transport, not ready, cannot receive", none.transport === null && !none.ready && !none.canReceive && none.reason === EXPECTED);

  // ---- SMTP: STARTTLS + AUTH PLAIN ----
  const starttls = smtpStub({ startTls: true, auth: "PLAIN LOGIN" });
  servers.push(starttls.server);
  const port = await listen(starttls.server);
  writeConfig(
    baseConfig({
      email: { transport: "smtp", smtpHost: "127.0.0.1", smtpPort: port, smtpSecure: false, smtpUser: "me@example.com", smtpPass: "s3cret-pass", from: "agentqs <me@example.com>" },
    }),
  );
  check("mailConfigured() is true once SMTP is set", mailConfigured() === true);
  check("SMTP can never receive", mailStatus().canReceive === false && mailStatus().transport === "smtp");
  const sent = await sendMail("you@example.com", "Dagens résumé", BODY, { smtpTls: { ca: TEST_CERT } });
  check("sendMail returns a message id", /^<[0-9a-f]+@example\.com>$/.test(sent.id), sent.id);

  const s = starttls.sessions[0];
  const lines = s.commands.map((c) => c.line);
  const plainAuth = Buffer.from("\u0000me@example.com\u0000s3cret-pass").toString("base64");
  const expected = ["EHLO", "STARTTLS", "EHLO", `AUTH PLAIN ${plainAuth}`, "MAIL FROM:<me@example.com>", "RCPT TO:<you@example.com>", "DATA", "QUIT"];
  check(
    "wire sequence is EHLO → STARTTLS → EHLO → AUTH → MAIL FROM → RCPT TO → DATA → QUIT",
    lines.length === expected.length && expected.every((e, i) => (e === "EHLO" ? lines[i].startsWith("EHLO ") : lines[i] === e)),
    lines.map((l) => l.split(" ")[0]).join(" "),
  );
  check("the first EHLO and STARTTLS travel in the clear, everything after is inside TLS", !s.commands[0].tls && !s.commands[1].tls && s.commands.slice(2).every((c) => c.tls));
  check("the password is never sent before TLS is up", s.commands.filter((c) => !c.tls).every((c) => !c.line.includes(plainAuth)));
  check("a body line starting with '.' is dot-stuffed on the wire", s.data.includes("\r\n..hidden line that starts with a dot\r\n"));
  check("a body line that is only '.' is stuffed to '..' (it would have ended the message)", s.data.includes("\r\n..\r\n"));
  check("every line ends CRLF — no bare LF or CR", !/[^\r]\n/.test(s.data) && !/\r[^\n]/.test(s.data));
  check("no wire line exceeds 78 bytes", s.data.split("\r\n").every((l) => l.length <= 78));
  check("the body survives the round trip byte for byte", decodeBody(s.data) === BODY, JSON.stringify(decodeBody(s.data).slice(0, 60)));
  check("headers carry From, To and an encoded non-ASCII Subject", s.data.includes("From: agentqs <me@example.com>\r\n") && s.data.includes("To: you@example.com\r\n") && s.data.includes(`Subject: =?UTF-8?B?${Buffer.from("Dagens résumé").toString("base64")}?=\r\n`));

  // A newline smuggled into the subject must not become a header.
  await sendMail("you@example.com", "hi\r\nBcc: evil@example.com", "x", { smtpTls: { ca: TEST_CERT } });
  check("a CR/LF in the subject cannot inject a header", !/^Bcc:/m.test(starttls.sessions[1].data));

  let bad = "";
  try {
    await sendMail("not-an-address", "s", "t", { smtpTls: { ca: TEST_CERT } });
  } catch (e) {
    bad = (e as Error).message;
  }
  check("a bad recipient is rejected before any connection", /not an email address/.test(bad) && starttls.sessions.length === 2, bad);

  // An untrusted certificate must fail, not be waved through.
  let untrusted = "";
  try {
    await sendMail("you@example.com", "s", "t");
  } catch (e) {
    untrusted = (e as Error).message;
  }
  check("an untrusted TLS certificate is refused", /TLS failed/.test(untrusted), untrusted);

  // testMail persists its outcome so the card survives a reload.
  await testMail("you@example.com", { smtpTls: { ca: TEST_CERT } });
  const last = mailStatus().lastTest;
  check("testMail records the outcome on config", last?.ok === true && last.to === "you@example.com");
  await testMail("you@example.com").catch(() => {});
  check("a failed test is recorded too, with the reason", mailStatus().lastTest?.ok === false && /TLS failed/.test(mailStatus().lastTest?.detail ?? ""));

  // ---- SMTP: AUTH LOGIN over implicit TLS ----
  const implicit = smtpStub({ implicitTls: true, auth: "LOGIN" });
  servers.push(implicit.server);
  const port465 = await listen(implicit.server);
  await smtpSend(
    { host: "127.0.0.1", port: port465, secure: true, user: "me@example.com", pass: "pw", tls: { ca: TEST_CERT } },
    { from: "me@example.com", to: "you@example.com", data: "Subject: x\n\nbody" },
  );
  const l2 = implicit.sessions[0].commands.map((c) => c.line);
  check(
    "implicit TLS + AUTH LOGIN sends base64 username then password, no STARTTLS",
    l2[1] === "AUTH LOGIN" && l2[2] === Buffer.from("me@example.com").toString("base64") && l2[3] === Buffer.from("pw").toString("base64") && !l2.includes("STARTTLS"),
    l2.join(" | "),
  );
  check("a bare-LF message is sent as CRLF", implicit.sessions[0].data === "Subject: x\r\n\r\nbody\r\n");

  // ---- SMTP: refuses to send a password in the clear ----
  const plain = smtpStub({ auth: "PLAIN" });
  servers.push(plain.server);
  const portPlain = await listen(plain.server);
  let clear = "";
  try {
    await smtpSend({ host: "127.0.0.1", port: portPlain, secure: false, user: "u@example.com", pass: "pw" }, { from: "u@example.com", to: "you@example.com", data: "x" });
  } catch (e) {
    clear = (e as Error).message;
  }
  check("no TLS on offer → refuses, and AUTH is never written", /in the clear/.test(clear) && !plain.sessions[0].commands.some((c) => c.line.startsWith("AUTH")), clear);

  // ---- SMTP: a dead host cannot hang the caller ----
  const dead = smtpStub({ silent: true });
  servers.push(dead.server);
  const portDead = await listen(dead.server);
  const t0 = Date.now();
  let timedOut = "";
  try {
    await smtpSend({ host: "127.0.0.1", port: portDead, secure: false, timeoutMs: 300 }, { from: "a@b.co", to: "c@d.co", data: "x" });
  } catch (e) {
    timedOut = (e as Error).message;
  }
  check("a server that never answers times out", /no reply within/.test(timedOut) && Date.now() - t0 < 3000, `${timedOut} (${Date.now() - t0}ms)`);

  // ---- Gmail ----
  const gmailHits: { auth: string; url: string; raw: string }[] = [];
  let gmailStatus = 200;
  const gmail = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      gmailHits.push({ auth: String(req.headers.authorization ?? ""), url: req.url ?? "", raw: (JSON.parse(body) as { raw: string }).raw });
      res.writeHead(gmailStatus, { "content-type": "application/json" });
      res.end(gmailStatus === 200 ? JSON.stringify({ id: "msg-1", threadId: "thread-42", labelIds: ["SENT"] }) : JSON.stringify({ error: { message: "Insufficient Permission" } }));
    });
  });
  servers.push(gmail);
  const gmailBase = `http://127.0.0.1:${await listen(gmail)}`;
  const SEND = "https://www.googleapis.com/auth/gmail.send";
  const READ = "https://www.googleapis.com/auth/gmail.readonly";
  const grant = (scopes: string) => ({ accessToken: "ya29.test-token", refreshToken: "r", expiresAt: new Date(Date.now() + 3600_000).toISOString(), scopes });

  writeConfig(baseConfig({ email: { transport: "gmail" } }));
  check("gmail transport without a grant is not ready", !mailStatus().ready && /Authorize/.test(mailStatus().reason));

  writeConfig(baseConfig({ email: { transport: "gmail" }, sourceOAuth: { gmail_send: grant(SEND) } }));
  check("send-only grant: ready, canReceive false", mailStatus().ready && mailStatus().canReceive === false);
  const g = await sendMail("you@example.com", "Evening check-in", BODY, { gmailApiBase: gmailBase });
  check("Gmail send returns Google's id and threadId", g.id === "msg-1" && g.threadId === "thread-42", JSON.stringify(g));
  const hit = gmailHits[0];
  check("it POSTs users.messages.send with the grant's bearer token", hit.url === "/gmail/v1/users/me/messages/send" && hit.auth === "Bearer ya29.test-token", `${hit.url} ${hit.auth}`);
  check("raw is base64url (no +, /, = or whitespace)", /^[A-Za-z0-9_-]+$/.test(hit.raw));
  const rfc822 = Buffer.from(hit.raw, "base64url").toString("utf8");
  check("raw decodes to an RFC-822 message: CRLF headers, blank line, body", rfc822.includes("To: you@example.com\r\n") && rfc822.includes("Subject: Evening check-in\r\n") && rfc822.includes("MIME-Version: 1.0\r\n") && decodeBody(rfc822.replace(/^\./gm, "..")) === BODY);
  check("Gmail is not dot-stuffed (that is SMTP framing, not part of the message)", rfc822.includes("\r\n.hidden line") && !rfc822.includes("\r\n..hidden"));

  process.env.GMAIL_API_BASE = gmailBase;
  gmailStatus = 403;
  let denied = "";
  try {
    await sendMail("you@example.com", "s", "t");
  } catch (e) {
    denied = (e as Error).message;
  }
  delete process.env.GMAIL_API_BASE;
  check("a Gmail refusal surfaces Google's message and the way out", /HTTP 403: Insufficient Permission/.test(denied) && /authorize Google again/.test(denied), denied);

  writeConfig(baseConfig({ email: { transport: "gmail", captureReplies: true }, sourceOAuth: { gmail_send: grant(SEND) } }));
  check("replies ticked but read not granted → ready, cannot receive, says why", mailStatus().ready && !mailStatus().canReceive && /authorize again/.test(mailStatus().reason));
  writeConfig(baseConfig({ email: { transport: "gmail", captureReplies: true }, sourceOAuth: { gmail_send: grant(`${SEND} ${READ}`) } }));
  check("gmail.readonly granted → canReceive true", mailStatus().canReceive === true && mailStatus().reason === "");
  writeConfig(baseConfig({ email: { transport: "smtp", smtpHost: "h", from: "a@b.co" }, sourceOAuth: { gmail_send: grant(`${SEND} ${READ}`) } }));
  check("the same grant on the SMTP transport still cannot receive", mailStatus().canReceive === false);

  // ---- the credential holder ----
  const plugin = pluginById("gmail_send");
  check("gmail_send is registered and flagged a mail transport", plugin?.mailTransport === true && Boolean(plugin.oauth));
  check("gmail_send never appears in the Pipeline's sources", !SOURCE_PLUGINS.some((p) => p.id === "gmail_send"));
  check("scope is send-only by default", gmailSendScopes(baseConfig()) === SEND);
  check("scope adds gmail.readonly only when replies are ticked", gmailSendScopes(baseConfig({ email: { captureReplies: true } })) === `${SEND} ${READ}`);
  let fetchErr = "";
  await plugin!.fetch({ from: "2026-01-01", to: "2026-01-02" } as never).catch((e: Error) => (fetchErr = e.message));
  check("its fetch() throws — it is not a data source", /mail transport, not a data source/.test(fetchErr));
  let syncErr = "";
  await syncSource({ id: "gmail_send" }).catch((e: Error) => (syncErr = e.message));
  check("syncSource refuses it", /mail transport/.test(syncErr), syncErr);
  let ivErr = "";
  try {
    setSourceInterval("gmail_send", "daily");
  } catch (e) {
    ivErr = (e as Error).message;
  }
  check("it cannot be given a sync cadence", /mail transport/.test(ivErr), ivErr);

  // ---- "Use my Google account" ----
  const workingSmtp = { transport: "smtp" as const, smtpHost: "smtp.example.com", from: "me@example.com" };
  writeConfig(baseConfig({ email: workingSmtp }));
  let noKey = "";
  try {
    beginMailConnect("http://localhost:3106", { useGoogle: true });
  } catch (e) {
    noKey = (e as Error).message;
  }
  check("useGoogle with no Google key saved says so", /No Google app key/.test(noKey), noKey);
  check("a refused Authorize changes nothing — working SMTP stays on", JSON.stringify(readConfig()!.email) === JSON.stringify(workingSmtp) && !readConfig()!.oauthPending);
  writeConfig(baseConfig({ email: workingSmtp, oauthApps: { google: { clientId: "cid.apps.googleusercontent.com", clientSecret: "gsecret" } } }));
  check("mailStatus sees the reusable Google key", mailStatus().googleApp === true);
  const dance = beginMailConnect("http://localhost:3106", { useGoogle: true, captureReplies: true });
  const u = new URL(dance.authorizeUrl);
  const after = readConfig()!;
  check("the Google key is copied into the gmail_send slot, nothing pasted", after.oauthApps?.gmail_send?.clientId === "cid.apps.googleusercontent.com" && after.oauthApps?.gmail_send?.clientSecret === "gsecret");
  check("the Google entry itself is untouched", after.oauthApps?.google?.clientSecret === "gsecret");
  check("the authorize URL asks for send + read with the reused client id", u.searchParams.get("client_id") === "cid.apps.googleusercontent.com" && u.searchParams.get("scope") === `${SEND} ${READ}`, u.searchParams.get("scope") ?? "");
  check("the dance is pending for gmail_send with replies recorded", after.oauthPending?.instanceId === "gmail_send" && after.email?.captureReplies === true);
  check("a STARTED dance does not switch SMTP off (an abandoned tab is harmless)", after.email?.transport === "smtp" && mailStatus().ready);
  check("Google's own grant/products are not touched", after.sourceOAuth?.google === undefined && after.googleProducts === undefined);

  // Google answers the code exchange — the only stubbed party is Google's token endpoint.
  const tokenCalls: string[] = [];
  const googleToken = (async (url: RequestInfo | URL, init?: RequestInit) => {
    tokenCalls.push(`${String(url)} ${String(init?.body ?? "")}`);
    return new Response(JSON.stringify({ access_token: "ya29.fresh", refresh_token: "1//r", expires_in: 3600, scope: `${SEND} ${READ}` }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const done = await completeOAuth("auth-code", after.oauthPending!.state, googleToken);
  const landed = readConfig()!;
  check("the code is exchanged with the reused client id", done.instanceId === "gmail_send" && tokenCalls.length === 1 && tokenCalls[0].includes("cid.apps.googleusercontent.com"));
  check("a COMPLETED dance flips the transport to gmail and keeps the SMTP fields", landed.email?.transport === "gmail" && landed.email.smtpHost === "smtp.example.com");
  check("the grant lands under gmail_send — never under the shared google key", landed.sourceOAuth?.gmail_send?.accessToken === "ya29.fresh" && landed.sourceOAuth?.google === undefined);
  check("no sync cadence is given to a mail transport", landed.sourceIntervals?.gmail_send === undefined && landed.backup === undefined);
  check("mail is now ready on Google and can read replies", mailStatus().ready && mailStatus().transport === "gmail" && mailStatus().canReceive === true);

  // ---- re-authorize from the Email card: the key lives ONLY in gmail_send ----
  // Pasting a Client ID/Secret into the card saves it there, with no shared Google
  // key at all. googleApp is then true, the card hides its inputs and sends
  // useGoogle — so this must work, or ticking "Capture replies" is a dead end.
  const ownKey = { clientId: "own.apps.googleusercontent.com", clientSecret: "ownsecret" };
  writeConfig(baseConfig({ email: { transport: "gmail" }, oauthApps: { gmail_send: ownKey }, sourceOAuth: { gmail_send: grant(SEND) } }));
  check("a key only in the gmail_send slot still reads as a reusable Google key", mailStatus().googleApp === true && readConfig()!.oauthApps?.google === undefined);
  let widenErr = "";
  let widen: { authorizeUrl: string } | null = null;
  try {
    widen = beginMailConnect("http://localhost:3106", { useGoogle: true, captureReplies: true });
  } catch (e) {
    widenErr = (e as Error).message;
  }
  const wu = widen ? new URL(widen.authorizeUrl) : null;
  check("useGoogle re-authorizes with the gmail_send slot's own key", wu?.searchParams.get("client_id") === ownKey.clientId, widenErr);
  check("…and widens the grant to gmail.readonly", wu?.searchParams.get("scope") === `${SEND} ${READ}` && readConfig()!.email?.captureReplies === true, wu?.searchParams.get("scope") ?? widenErr);
  check("…without inventing a shared Google key or losing its own", readConfig()!.oauthApps?.google === undefined && readConfig()!.oauthApps?.gmail_send?.clientSecret === "ownsecret");
  // Both slots, DIFFERENT apps: the one pasted into the card is the one that sends.
  writeConfig(baseConfig({ email: { transport: "gmail" }, oauthApps: { gmail_send: ownKey, google: { clientId: "cid.apps.googleusercontent.com", clientSecret: "gsecret" } } }));
  check("a distinct gmail_send key wins over the shared Google one", new URL(beginMailConnect("http://localhost:3106", { useGoogle: true }).authorizeUrl).searchParams.get("client_id") === ownKey.clientId);
  // Both slots, SAME app: the slot is a copy, and a rotated shared secret refreshes it.
  writeConfig(baseConfig({ email: { transport: "gmail" }, oauthApps: { gmail_send: { clientId: "cid.apps.googleusercontent.com", clientSecret: "stale" }, google: { clientId: "cid.apps.googleusercontent.com", clientSecret: "rotated" } } }));
  beginMailConnect("http://localhost:3106", { useGoogle: true });
  check("a copied key still picks up a rotated shared secret", readConfig()!.oauthApps?.gmail_send?.clientSecret === "rotated");

  // ---- the client never sees the password ----
  const pub = publicConfig(baseConfig({ email: { transport: "smtp", smtpHost: "smtp.example.com", smtpUser: "me@example.com", smtpPass: "super-secret-1234" } }));
  check("publicConfig masks the SMTP password", pub.email.hasPass === "••••••••1234" && !JSON.stringify(pub).includes("super-secret"));
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    for (const s of servers) s.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nall checks passed");
    process.exit(0);
  });

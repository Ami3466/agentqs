#!/usr/bin/env tsx
/**
 * LIVE proof for email — the deterministic suites' complement.
 *
 * mail:test / email:test / notify:test / password:test prove the code against
 * loopback stubs. This one proves it against a REAL mail server: it sends through
 * the production path (`sendMail`, `testNotification`, `requestPasswordReset`) and
 * reads what was actually delivered back over IMAP.
 *
 *   • a plain message is accepted by the real server;
 *   • a deliberately awkward body round-trips BYTE FOR BYTE (a wrap landing on a
 *     space, a line that is only ".", accents, an emoji, a long run of short words);
 *   • a non-ASCII Subject decodes;
 *   • a notification sends, its row records no error, and the `aqs#` footer arrives;
 *   • the reset email carries a usable token: it completes the reset once, the new
 *     password verifies, the old one does not, and the token is refused twice;
 *   • a wrong password fails with the SERVER'S reason, not a generic error.
 *
 * NO CREDENTIAL LIVES IN THIS FILE. They come from the environment:
 *
 *   AGENTQS_LIVE_SMTP_HOST   e.g. smtp.gmail.com
 *   AGENTQS_LIVE_SMTP_PORT   587 (STARTTLS) or 465 (implicit TLS)
 *   AGENTQS_LIVE_SMTP_USER   the mailbox — also the ONLY recipient
 *   AGENTQS_LIVE_SMTP_PASS   for Gmail: an app password, not the account password
 *   AGENTQS_LIVE_IMAP_HOST   optional, default imap.gmail.com — `host` or `host:port`
 *                            (993, implicit TLS), signed in to with the same login
 *
 * Any of the first four unset → one line saying so, exit 0: an unconfigured
 * machine must not fail the suite. Self-send only — every message goes to
 * AGENTQS_LIVE_SMTP_USER itself, so running this never mails a third party.
 *
 * Run: npm run mail:live
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import tls from "tls";

const HOST = (process.env.AGENTQS_LIVE_SMTP_HOST || "").trim();
const PORT = Number(process.env.AGENTQS_LIVE_SMTP_PORT || "");
const USER = (process.env.AGENTQS_LIVE_SMTP_USER || "").trim();
const PASS = process.env.AGENTQS_LIVE_SMTP_PASS || "";
const [IMAP_HOST, IMAP_PORT = "993"] = ((process.env.AGENTQS_LIVE_IMAP_HOST || "").trim() || "imap.gmail.com").split(":");

if (!HOST || !PORT || !USER || !PASS) {
  console.log(
    "mail:live skipped — set AGENTQS_LIVE_SMTP_HOST, AGENTQS_LIVE_SMTP_PORT, AGENTQS_LIVE_SMTP_USER and AGENTQS_LIVE_SMTP_PASS (optional AGENTQS_LIVE_IMAP_HOST, default imap.gmail.com) to run it against your own mail server.",
  );
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-mail-live-"));
process.env.AGENTQS_DATA_DIR = root;
process.env.AGENTQS_NO_SCHEDULER = "1"; // never let the real timer fire during the test
delete process.env.SESSION_SECRET;
delete process.env.AGENTQS_PUBLIC_URL; // the reset link must carry THIS run's origin

import { hashPassword, verifyPassword } from "../src/lib/auth";
import { readConfig, writeConfig, type AppConfig } from "../src/lib/config";
import { addressOf, sendMail } from "../src/lib/mail";
import { testNotification, upsertNotification } from "../src/lib/notifications";
import { completePasswordReset, requestPasswordReset } from "../src/lib/password-reset";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

/** Never let a secret reach the terminal, whatever error text carried it. */
function scrub(s: string): string {
  return s.split(PASS).join("<password>");
}

// ---- IMAP, the small part of it this needs ------------------------------------

interface ImapReply {
  lines: string[];
  literals: Buffer[];
}

/**
 * IMAP is a plain line protocol: every command gets a tag, the server answers
 * with untagged `*` lines and ends with `<tag> OK|NO|BAD`. The one wrinkle is a
 * LITERAL — `{123}\r\n` followed by exactly 123 raw bytes — which is how FETCH
 * hands back a message. It is counted in BYTES, so everything here stays a Buffer
 * until a message is decoded.
 */
class Imap {
  private buf = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private dead: Error | null = null;
  private n = 0;

  private constructor(private sock: tls.TLSSocket) {
    sock.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake?.();
    });
    const die = (e: Error) => {
      this.dead = this.dead ?? e;
      this.wake?.();
    };
    sock.on("error", (e) => die(new Error(`IMAP: ${e.message}`)));
    sock.on("close", () => die(new Error("IMAP: the server closed the connection.")));
    sock.setTimeout(30_000, () => die(new Error("IMAP: no reply within 30s.")));
  }

  static async connect(host: string, port: number): Promise<Imap> {
    const sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ host, port, servername: host }, () => resolve(s));
      s.once("error", (e) => reject(new Error(`IMAP ${host}:${port}: ${e.message}`)));
    });
    const imap = new Imap(sock);
    await imap.read("*"); // the greeting
    return imap;
  }

  /** Pull one complete reply off the buffer, or null while bytes are still due. */
  private parse(tag: string): (ImapReply & { status: string; used: number }) | null {
    const lines: string[] = [];
    const literals: Buffer[] = [];
    let pos = 0;
    let line = "";
    for (;;) {
      const nl = this.buf.indexOf("\r\n", pos);
      if (nl < 0) return null;
      line += this.buf.toString("latin1", pos, nl);
      pos = nl + 2;
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit) {
        const size = Number(lit[1]);
        if (this.buf.length < pos + size) return null;
        literals.push(this.buf.subarray(pos, pos + size));
        pos += size;
        continue; // the same logical line carries on after the literal
      }
      if (tag === "*" || line.startsWith(`${tag} `)) return { lines, literals, status: line, used: pos };
      lines.push(line);
      line = "";
    }
  }

  private async read(tag: string): Promise<ImapReply & { status: string }> {
    for (;;) {
      const got = this.parse(tag);
      if (got) {
        // Copy the literals out before the buffer they point into moves on.
        const literals = got.literals.map((b) => Buffer.from(b));
        this.buf = this.buf.subarray(got.used);
        return { ...got, literals };
      }
      if (this.dead) throw this.dead;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }

  /** `shown` is what an error prints INSTEAD of the command — LOGIN carries the password. */
  async cmd(text: string, shown = text): Promise<ImapReply> {
    const tag = `A${++this.n}`;
    this.sock.write(`${tag} ${text}\r\n`);
    const r = await this.read(tag);
    if (!r.status.startsWith(`${tag} OK`)) throw new Error(`IMAP ${shown} → ${r.status.slice(tag.length + 1)}`);
    return r;
  }

  close(): void {
    this.sock.destroy();
  }
}

const quoted = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;

// ---- decoding what came back ---------------------------------------------------

/**
 * Quoted-printable, decoded FULLY: soft breaks AND =XX escapes, to BYTES, and only
 * then UTF-8. Both halves matter, and getting either wrong produces garbage that
 * looks convincingly like a bug in the sender — both cost real time while this
 * feature was being verified, so do not chase them again:
 *   • undo only the soft breaks and a URL reads `token=3D<hex>` ("=" is `=3D` on
 *     the wire) — the token "is wrong" and the reset "fails";
 *   • decode =XX one CHARACTER at a time (String.fromCharCode per escape) and every
 *     multi-byte character falls apart: `—` arrives as `â€"`.
 */
function decodeQuotedPrintable(raw: Buffer): string {
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x3d) {
      if (raw[i + 1] === 0x0d && raw[i + 2] === 0x0a) {
        i += 2; // soft break
        continue;
      }
      if (raw[i + 1] === 0x0a) {
        i += 1; // a soft break on a server that stores bare LF
        continue;
      }
      const hex = raw.toString("latin1", i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(raw[i]);
  }
  return Buffer.from(out).toString("utf8");
}

/** RFC 2047 encoded-words (B and Q) in a header value — same rule: bytes first. */
function decodeHeader(v: string): string {
  return v
    .replace(/(\?=)\s+(=\?)/g, "$1$2") // whitespace BETWEEN encoded-words is not text
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _cs: string, enc: string, data: string) =>
      enc.toUpperCase() === "B"
        ? Buffer.from(data, "base64").toString("utf8")
        : decodeQuotedPrintable(Buffer.from(data.replace(/_/g, " "), "latin1")),
    );
}

interface Delivered {
  uid: number;
  subject: string;
  /** Decoded, LF line ends, the transport's own trailing line break removed. */
  body: string;
}

function parseMessage(uid: number, raw: Buffer): Delivered {
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.toString("latin1", 0, split < 0 ? raw.length : split).replace(/\r\n[ \t]+/g, " "); // unfold
  const header = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(head)?.[1]?.trim() ?? "";
  const bodyRaw = split < 0 ? Buffer.alloc(0) : raw.subarray(split + 4);
  const body = /quoted-printable/i.test(header("Content-Transfer-Encoding"))
    ? decodeQuotedPrintable(bodyRaw)
    : bodyRaw.toString("utf8");
  // `buildMessage` ends the body with one CRLF and a server may add its own; that
  // terminator is the wire's, not the text's. Nothing else is touched.
  return { uid, subject: decodeHeader(header("Subject")), body: body.replace(/\r\n/g, "\n").replace(/\n+$/, "") };
}

/**
 * Wait for a delivered message. A send returning 250 means ACCEPTED, not
 * delivered: the message reaches the mailbox (and Gmail's search index) a few
 * seconds later, so one fetch right after a send finds nothing. Poll.
 *
 * It asks for every UID from `fromUid` up and matches on the DECODED message
 * locally, rather than trusting the server's SEARCH SUBJECT/BODY — Gmail's is a
 * word index that lags further and does not see inside a URL.
 */
async function waitFor(imap: Imap, fromUid: number, want: (m: Delivered) => boolean, label: string): Promise<Delivered | null> {
  const seen = new Set<number>();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await imap.cmd("NOOP"); // lets the server announce new mail in the selected mailbox
    const found = await imap.cmd(`UID SEARCH UID ${fromUid}:*`);
    const uids = found.lines
      .filter((l) => /^\* SEARCH/i.test(l))
      .flatMap((l) => l.split(/\s+/).slice(2).map(Number))
      // `n:*` always matches the newest message, even one older than n.
      .filter((u) => Number.isFinite(u) && u >= fromUid && !seen.has(u));
    for (const uid of uids) {
      seen.add(uid);
      const r = await imap.cmd(`UID FETCH ${uid} (BODY.PEEK[])`);
      if (!r.literals[0]) continue;
      const m = parseMessage(uid, r.literals[0]);
      if (want(m)) return m;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`  … ${label}: not in INBOX after 90s`);
  return null;
}

// ---- the run -------------------------------------------------------------------

const RUN = `aqslive${crypto.randomBytes(4).toString("hex")}`;
const OLD = `old-${crypto.randomBytes(6).toString("hex")}`;
const NEW = `new-${crypto.randomBytes(6).toString("hex")}`;

/** Every QP edge the deterministic suite covers, this time through a real server. */
const AWKWARD = [
  // 74 chars, a space, a word: the soft wrap lands exactly on the space.
  `${"a".repeat(74)} word-after-the-wrap`,
  "", // a blank line survives
  ".", // a line that is only "." — SMTP dot-stuffing must give it back
  "..two leading dots",
  "Accents: café naïve São Paulo — “quoted”, and an equals sign: a=b",
  "Emoji: 🚀 ☕ 👩‍💻",
  // A long run of short words: many candidate wrap points, every space must survive.
  Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? "to" : i % 3 === 1 ? "be" : "or")).join(" "),
  "last line, no trailing newline",
].join("\n");

function baseConfig(pass: string): AppConfig {
  return {
    username: USER,
    passwordHash: hashPassword(OLD),
    sessionSecret: "live-test-secret",
    theme: "system",
    createdAt: new Date().toISOString(),
    email: { transport: "smtp", smtpHost: HOST, smtpPort: PORT, smtpUser: USER, smtpPass: pass },
  } as AppConfig;
}

async function main() {
  if (!addressOf(USER)) throw new Error("AGENTQS_LIVE_SMTP_USER must be an email address — it is the only recipient.");
  console.log(`mail:live — ${HOST}:${PORT}, read back over ${IMAP_HOST}:${IMAP_PORT}, run ${RUN}`);
  writeConfig(baseConfig(PASS));

  const imap = await Imap.connect(IMAP_HOST, Number(IMAP_PORT));
  try {
    await imap.cmd(`LOGIN ${quoted(USER)} ${quoted(PASS)}`, "LOGIN");
    const sel = await imap.cmd("SELECT INBOX");
    const next = Number(/UIDNEXT (\d+)/i.exec(sel.lines.join("\n"))?.[1]);
    if (!Number.isFinite(next)) throw new Error("IMAP SELECT gave no UIDNEXT.");

    console.log("\n[1] a plain message is accepted");
    let sent: { id: string } | null = null;
    try {
      sent = await sendMail(USER, `agentqs live ${RUN} plain`, "A plain message from npm run mail:live.");
    } catch (e) {
      console.log(`  ${scrub((e as Error).message)}`);
    }
    check("the real server accepted it", Boolean(sent?.id));

    console.log("\n[2] an awkward body round-trips byte for byte");
    const subject = `agentqs live ${RUN} — café ☕`;
    await sendMail(USER, subject, AWKWARD);
    const awkward = await waitFor(imap, next, (m) => m.subject.includes(RUN) && m.subject.includes("café"), "awkward body");
    check("it was delivered", Boolean(awkward));
    const same = awkward?.body === AWKWARD;
    check("the body is identical", same);
    if (awkward && !same) {
      const got = awkward.body.split("\n");
      const exp = AWKWARD.split("\n");
      const at = exp.findIndex((l, i) => l !== got[i]);
      console.log(`    first difference, line ${at + 1}:\n      sent ${JSON.stringify(exp[at])}\n      got  ${JSON.stringify(got[at])}`);
    }
    check("the non-ASCII Subject decodes", awkward?.subject === subject, awkward ? JSON.stringify(awkward.subject) : "");

    console.log("\n[3] a notification sends");
    const n = upsertNotification({ id: "live", channel: "email", target: USER, text: `live notification ${RUN}`, atLocal: "20:00" });
    const after = await testNotification(n.id);
    check("its row records no error", !after.lastError, after.lastError ?? "");
    check('"Send now" did not consume the day', !after.lastSentDay);
    const note = await waitFor(imap, next, (m) => m.subject === `agentqs: live notification ${RUN}`, "notification");
    check("it was delivered", Boolean(note));
    check("it carries the aqs# reply footer", /\n-- \nagentqs .*aqs#[0-9a-f]{6}$/.test(note?.body ?? ""));

    console.log("\n[4] the reset loop, with the token the server delivered");
    const origin = `http://${RUN}.invalid`;
    await requestPasswordReset(USER, origin);
    const reset = await waitFor(imap, next, (m) => m.body.includes(`${origin}/reset?token=`), "reset email");
    check("the reset email arrived", Boolean(reset));
    // Anchored to the END of the line: `token=3D…` or a link cut by an undecoded
    // soft break fails here, not three checks later.
    const token = /\/reset\?token=([0-9a-f]{64})$/m.exec(reset?.body ?? "")?.[1] ?? "";
    check("it carries a whole token", Boolean(token));
    let done = false;
    try {
      done = completePasswordReset(token, NEW).ok;
    } catch (e) {
      console.log(`  ${(e as Error).message}`);
    }
    check("the token completes the reset", done);
    const hash = readConfig()?.passwordHash ?? "";
    check("the new password verifies", verifyPassword(NEW, hash));
    check("the old password does not", !verifyPassword(OLD, hash));
    let second = "";
    try {
      completePasswordReset(token, `${NEW}-again`);
    } catch (e) {
      second = (e as Error).message;
    }
    check("the same token is refused the second time", /not valid|already used/.test(second), second);
    check("…and changed nothing", verifyPassword(NEW, readConfig()?.passwordHash ?? ""));

    // Last, so a server that slows down after a failed login slows nothing else.
    console.log("\n[5] a wrong password fails with the server's own reason");
    const wrong = `wrong-${crypto.randomBytes(8).toString("hex")}`;
    writeConfig({ ...readConfig()!, email: baseConfig(wrong).email });
    let why = "";
    try {
      await sendMail(USER, `agentqs live ${RUN} must not send`, "This must never arrive.");
    } catch (e) {
      why = (e as Error).message;
    }
    check("the send failed", Boolean(why));
    // `SMTP host:port refused <step>: 535 5.7.8 Username and Password not accepted …`
    check("with the server's reply code and its words", /refused .*: 5\d\d \S+/.test(why), scrub(why).slice(0, 160));
    check("and without echoing the password", !why.includes(wrong) && !why.includes(PASS));
  } finally {
    imap.close();
  }
}

main()
  .catch((e) => {
    console.error(`\nFAILED: ${scrub((e as Error).stack || String(e))}`);
    failures++;
  })
  .finally(() => {
    // config.json in there holds the real SMTP password — never leave it behind.
    fs.rmSync(root, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) failed.` : "\nmail:live — all checks passed against the real server.");
    process.exit(failures ? 1 : 0);
  });

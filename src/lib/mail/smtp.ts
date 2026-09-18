import net from "net";
import tls from "tls";

/**
 * A MINIMAL SMTP CLIENT — submission only, one message per connection.
 *
 *   connect → 220 → EHLO → [STARTTLS → EHLO] → AUTH → MAIL FROM → RCPT TO → DATA → QUIT
 *
 * Hand-rolled on net/tls for the same reason OAuth and password hashing are
 * (oauth.ts, auth.ts): the repo carries no library for something this small.
 * It covers what real submission servers speak — implicit TLS (465), STARTTLS
 * (587), AUTH PLAIN and AUTH LOGIN — which is Gmail app passwords, Fastmail,
 * SES, Mailgun, Postmark and Resend. It is NOT a full RFC 5321 client: no
 * pipelining, no CRAM-MD5/XOAUTH2, one recipient. A provider that fails here
 * needs a new AUTH mechanism added, not a redesign.
 *
 * Two rules that are easy to get wrong and silently corrupt mail:
 *  - every line ends CRLF, including ones the caller wrote with a bare LF;
 *  - a DATA line that starts with "." is doubled (dot-stuffing), or the server
 *    reads it as end-of-message and drops the rest of the body.
 */

export interface SmtpOptions {
  host: string;
  port: number;
  /** true = TLS from the first byte (465); false = plain, upgraded by STARTTLS. */
  secure: boolean;
  user?: string;
  pass?: string;
  /** Applies to the connect AND to every reply — a dead host cannot hang a request. */
  timeoutMs?: number;
  /** Extra TLS options (a test's self-signed CA). */
  tls?: tls.ConnectionOptions;
  /** The name we EHLO as. */
  clientName?: string;
}

export interface SmtpEnvelope {
  from: string; // bare address
  to: string; // bare address
  /** The full RFC-822 message (headers + body). Line endings are normalized here. */
  data: string;
}

export type SmtpSend = (opts: SmtpOptions, msg: SmtpEnvelope) => Promise<{ response: string }>;

const DEFAULT_TIMEOUT_MS = 20_000;

const secs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`);

interface Reply {
  code: number;
  lines: string[]; // text of each line, code stripped
}

/** Normalize to CRLF, dot-stuff, and terminate — the exact bytes that follow DATA. */
export function encodeSmtpData(data: string): string {
  let body = data.replace(/\r\n|\r|\n/g, "\r\n").replace(/^\./gm, "..");
  if (!body.endsWith("\r\n")) body += "\r\n";
  return `${body}.\r\n`;
}

/** Reads replies off a socket. A reply ends at the first line whose code is
 *  followed by a space ("250 ") — "250-" means more lines follow. */
class Wire {
  private buf = "";
  private lines: string[] = [];
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private dead: Error | null = null;

  constructor(
    private sock: net.Socket,
    private timeoutMs: number,
    private where: string,
  ) {
    this.attach(sock);
  }

  private onData = (chunk: Buffer) => {
    this.buf += chunk.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      this.lines.push(this.buf.slice(0, i).replace(/\r$/, ""));
      this.buf = this.buf.slice(i + 1);
    }
    this.flush();
  };
  private onError = (e: Error) => this.fail(new Error(`SMTP ${this.where}: ${e.message}`));
  private onClose = () => this.fail(new Error(`SMTP ${this.where}: the server closed the connection.`));

  private attach(sock: net.Socket) {
    sock.on("data", this.onData);
    sock.on("error", this.onError);
    sock.on("close", this.onClose);
  }

  /** STARTTLS, step 1: stop listening and hand back the plain socket, so the TLS
   *  handshake records are never parsed as SMTP lines. */
  detach(): net.Socket {
    this.sock.off("data", this.onData);
    this.sock.off("error", this.onError);
    this.sock.off("close", this.onClose);
    return this.sock;
  }

  /** STARTTLS, step 2: listen on the TLS wrapper. Anything buffered before the
   *  upgrade is dropped — bytes that arrived in the clear are not trusted. */
  adopt(next: net.Socket) {
    this.sock = next;
    this.buf = "";
    this.lines = [];
    this.attach(next);
  }

  private fail(e: Error) {
    if (!this.dead) this.dead = e;
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      clearTimeout(w.timer);
      w.reject(this.dead);
    }
  }

  private flush() {
    if (!this.waiting) return;
    const end = this.lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
    if (end < 0) return;
    const taken = this.lines.splice(0, end + 1);
    const w = this.waiting;
    this.waiting = null;
    clearTimeout(w.timer);
    w.resolve({ code: Number(taken[end].slice(0, 3)), lines: taken.map((l) => l.slice(4)) });
  }

  read(): Promise<Reply> {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(this.dead);
      const timer = setTimeout(
        () => this.fail(new Error(`SMTP ${this.where}: no reply within ${secs(this.timeoutMs)}.`)),
        this.timeoutMs,
      );
      this.waiting = { resolve, reject, timer };
      this.flush();
    });
  }

  write(s: string) {
    this.sock.write(s);
  }

  /** Send one command, require one of `ok`. `shown` replaces the command in an
   *  error so a password never lands in a log line. */
  async cmd(line: string, ok: number[], shown = line): Promise<Reply> {
    this.write(`${line}\r\n`);
    return this.expect(ok, shown);
  }

  async expect(ok: number[], shown: string): Promise<Reply> {
    const r = await this.read();
    if (!ok.includes(r.code)) {
      throw new Error(`SMTP ${this.where} refused ${shown}: ${r.code} ${r.lines.join(" ").slice(0, 300)}`);
    }
    return r;
  }

  end() {
    this.sock.off("close", this.onClose);
    this.sock.off("error", this.onError);
    this.sock.on("error", () => {});
    this.sock.destroy();
  }
}

/** SNI carries a hostname only — an IP literal there is an error in TLS (and a
 *  Node deprecation). The certificate is still checked against `host` either way. */
function sni(host: string): { servername?: string } {
  return net.isIP(host) ? {} : { servername: host };
}

function connect(opts: SmtpOptions, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const where = `${opts.host}:${opts.port}`;
    const sock: net.Socket = opts.secure
      ? tls.connect({ host: opts.host, port: opts.port, ...sni(opts.host), ...(opts.tls ?? {}) })
      : net.connect({ host: opts.host, port: opts.port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`SMTP ${where}: could not connect within ${secs(timeoutMs)}.`));
    }, timeoutMs);
    sock.once(opts.secure ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      sock.removeAllListeners("error");
      resolve(sock);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`SMTP ${where}: ${e.message}`));
    });
  });
}

function upgrade(sock: net.Socket, opts: SmtpOptions, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const where = `${opts.host}:${opts.port}`;
    const secured = tls.connect({ socket: sock, host: opts.host, ...sni(opts.host), ...(opts.tls ?? {}) });
    const timer = setTimeout(() => {
      secured.destroy();
      reject(new Error(`SMTP ${where}: the TLS handshake did not finish within ${secs(timeoutMs)}.`));
    }, timeoutMs);
    secured.once("secureConnect", () => {
      clearTimeout(timer);
      secured.removeAllListeners("error");
      resolve(secured);
    });
    secured.once("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`SMTP ${where}: TLS failed — ${e.message}`));
    });
  });
}

/** The capability words of an EHLO reply, upper-cased ("STARTTLS", "AUTH PLAIN LOGIN"). */
function capabilities(r: Reply): string[] {
  return r.lines.slice(1).map((l) => l.trim().toUpperCase());
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

export const smtpSend: SmtpSend = async (opts, msg) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const where = `${opts.host}:${opts.port}`;
  const name = opts.clientName || "agentqs.local";
  const wire = new Wire(await connect(opts, timeoutMs), timeoutMs, where);
  try {
    await wire.expect([220], "the connection");
    let caps = capabilities(await wire.cmd(`EHLO ${name}`, [250]));
    let encrypted = opts.secure;
    if (!encrypted && caps.includes("STARTTLS")) {
      await wire.cmd("STARTTLS", [220]);
      // Everything learned before the upgrade (the capability list included)
      // came in the clear, so it is asked again over TLS.
      wire.adopt(await upgrade(wire.detach(), opts, timeoutMs));
      caps = capabilities(await wire.cmd(`EHLO ${name}`, [250]));
      encrypted = true;
    }
    if (opts.user) {
      if (!encrypted) {
        throw new Error(
          `SMTP ${where} offers no TLS (no STARTTLS), so the password would travel in the clear — refusing. Use port 465 or 587.`,
        );
      }
      const auth = caps.find((c) => c.startsWith("AUTH"))?.split(/[ =]+/).slice(1) ?? [];
      const pass = opts.pass ?? "";
      if (auth.includes("PLAIN")) {
        await wire.cmd(`AUTH PLAIN ${b64(`\u0000${opts.user}\u0000${pass}`)}`, [235], "AUTH PLAIN");
      } else if (auth.includes("LOGIN")) {
        await wire.cmd("AUTH LOGIN", [334]);
        await wire.cmd(b64(opts.user), [334], "the username");
        await wire.cmd(b64(pass), [235], "the password");
      } else {
        throw new Error(
          `SMTP ${where} offers no AUTH mechanism this client speaks (PLAIN, LOGIN) — it offered: ${auth.join(", ") || "none"}.`,
        );
      }
    }
    await wire.cmd(`MAIL FROM:<${msg.from}>`, [250]);
    await wire.cmd(`RCPT TO:<${msg.to}>`, [250, 251]);
    await wire.cmd("DATA", [354]);
    wire.write(encodeSmtpData(msg.data));
    const done = await wire.expect([250], "the message");
    // The message is accepted at this point; a server that drops the line on QUIT
    // instead of answering 221 has not un-sent it.
    try {
      await wire.cmd("QUIT", [221]);
    } catch {
      /* already delivered */
    }
    return { response: done.lines.join(" ") };
  } finally {
    wire.end();
  }
};

import fs from "fs";
import http from "http";
import path from "path";
import { extensionPingFile, ingestGoogleActivityApiItems, isGooglePreset } from "./google-web-scraper";

/**
 * Standalone ingest listener — a bare Node http server OUTSIDE the Next router.
 *
 * Why it exists: the extension streams one POST per scraped Google page for up to
 * hours. Routing those through the Next dev router makes ingestion flap with the
 * dev workflow itself — every source-file save recompiles the router and 404s
 * requests for a second or two, and two dev servers sharing .next corrupt each
 * other's route manifests. This listener is started once per server process (via
 * src/instrumentation.ts) and never passes through the router, so code edits and
 * recompiles cannot interrupt an import. The Next route at
 * src/app/api/automations/google-activity-extension/route.ts stays as the
 * same-port path; the extension falls back to this port when that one fails.
 */

export const INGEST_PATH = "/api/automations/google-activity-extension";
export const INGEST_PING_PATH = `${INGEST_PATH}/ping`;

/** Stamp the extension heartbeat file the Pipeline tab reads ("extension installed"
 *  vs "nothing listening"). Shared by the Next ping route and this listener, so
 *  the extension can rotate ping targets exactly like batch posts. */
export function recordExtensionPing(version: unknown): void {
  const file = extensionPingFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ seenAt: new Date().toISOString(), version: typeof version === "string" ? version : "" }),
  );
}

/** Keep in sync with EXTRA_BASES in extensions/google-activity-exporter/content.js. */
export function ingestPort(): number {
  const n = Number(process.env.AGENTQS_INGEST_PORT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3033;
}

const allowedOrigins = new Set([
  "https://myactivity.google.com",
  "https://timeline.google.com",
]);

/** Writes are extension-only: the content script posts from a Google page origin
 *  (or the extension's own origin). A missing Origin header — curl, arbitrary local
 *  processes — is rejected; this endpoint can't require the session cookie because
 *  the cross-origin content-script fetch never carries it. */
export function isAllowedIngestOrigin(origin: string | null): boolean {
  return origin !== null && (allowedOrigins.has(origin) || origin.startsWith("chrome-extension://"));
}

export function ingestCorsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && isAllowedIngestOrigin(origin) ? origin : "https://myactivity.google.com";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

export interface IngestBody {
  preset?: unknown;
  items?: unknown;
  final?: unknown;
  page?: unknown;
  ct?: unknown;
}

/** The one ingest implementation both surfaces (Next route + this listener) call,
 *  so their contracts can't drift. */
export function runIngest(body: IngestBody): { status: number; payload: unknown } {
  if (!isGooglePreset(body.preset)) {
    return { status: 400, payload: { error: "Unknown preset." } };
  }
  if (!Array.isArray(body.items)) {
    return { status: 400, payload: { error: "items must be an array." } };
  }
  try {
    const result = ingestGoogleActivityApiItems({
      preset: body.preset,
      items: body.items,
      final: body.final === true,
    });
    return {
      status: 200,
      payload: { ok: true, page: Number(body.page) || 0, ct: typeof body.ct === "string" ? body.ct : "", result },
    };
  } catch (e) {
    return { status: 500, payload: { error: (e as Error).message } };
  }
}

// A batch is ~100 activity items; 64MB leaves an order of magnitude of headroom
// while still bounding a runaway request.
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let server: http.Server | null = null;
let listening = false;

/** True when THIS process owns the ingest port — doubles as the machine-wide
 *  "I run the scheduler" lock (port binding is the mutex). */
export function ingestServerActive(): boolean {
  return listening;
}

/** Idempotent. EADDRINUSE is expected (another agentqs process already listens —
 *  one working sink is all the extension needs) and only logged. */
export function startIngestServer(): void {
  if (server) return;
  const srv = http.createServer((req, res) => {
    const origin = req.headers.origin ?? null;
    const cors = ingestCorsHeaders(origin);
    const url = (req.url || "").split("?")[0];
    if (url !== INGEST_PATH && url !== INGEST_PING_PATH) {
      res.writeHead(404, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Not found." }));
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "POST only." }));
      return;
    }
    if (!isAllowedIngestOrigin(origin)) {
      res.writeHead(403, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Origin not allowed." }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { "content-type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "Body too large." }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      let body: IngestBody & { version?: unknown } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as IngestBody & { version?: unknown };
      } catch {
        /* unparseable body fails preset validation below */
      }
      if (url === INGEST_PING_PATH) {
        try {
          recordExtensionPing(body.version);
          res.writeHead(200, { "content-type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json", ...cors });
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
        return;
      }
      const { status, payload } = runIngest(body);
      res.writeHead(status, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify(payload));
    });
    req.on("error", () => {
      if (!res.writableEnded) {
        res.writeHead(400, { "content-type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "Request aborted." }));
      }
    });
  });
  srv.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.warn(`agentqs ingest listener: port ${ingestPort()} already taken (another agentqs instance) — skipping.`);
    } else {
      console.warn(`agentqs ingest listener failed: ${e.message}`);
    }
    server = null;
    listening = false;
  });
  // localhost-only: this port accepts unauthenticated (origin-gated) writes and
  // must never be reachable from the network.
  srv.listen(ingestPort(), "127.0.0.1", () => {
    listening = true;
    console.log(`agentqs ingest listener on http://127.0.0.1:${ingestPort()}${INGEST_PATH} (immune to dev recompiles)`);
  });
  server = srv;
}

#!/usr/bin/env tsx
/**
 * Minimal Google Data Portability smoke test.
 *
 * This intentionally does not drive Chrome. It assumes the user has already
 * obtained a Data Portability OAuth access token and API key, then checks whether
 * Google returns more than one year for a resource like chrome.history.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

interface Args {
  token?: string;
  apiKey?: string;
  resource: string;
  start?: string;
  end?: string;
  out?: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const args: Args = {
  token: arg("--token") ?? process.env.GOOGLE_PORTABILITY_TOKEN,
  apiKey: arg("--api-key") ?? process.env.GOOGLE_PORTABILITY_API_KEY,
  resource: arg("--resource") ?? "chrome.history",
  start: arg("--start"),
  end: arg("--end"),
  out: arg("--out") ?? path.join(os.tmpdir(), "agentqs-portability-test"),
};

function need(v: string | undefined, label: string): string {
  if (!v) throw new Error(`Missing ${label}. Pass ${label} or set env.`);
  return v;
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${need(args.token, "--token")}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function qs(): string {
  return args.apiKey ? `?key=${encodeURIComponent(args.apiKey)}` : "";
}

async function main() {
  fs.mkdirSync(args.out!, { recursive: true });
  const body: Record<string, unknown> = { resources: [args.resource] };
  if (args.start) body.startTime = args.start;
  if (args.end) body.endTime = args.end;

  const initiated = await api<{ archiveJobId: string; accessType: string }>(
    `https://dataportability.googleapis.com/v1/portabilityArchive:initiate${qs()}`,
    { method: "POST", body: JSON.stringify(body) },
  );
  console.log(`job ${initiated.archiveJobId} (${initiated.accessType})`);

  let state: any = null;
  for (let i = 0; i < 120; i++) {
    state = await api<any>(
      `https://dataportability.googleapis.com/v1/archiveJobs/${encodeURIComponent(initiated.archiveJobId)}/portabilityArchiveState${qs()}`,
    );
    console.log(`state ${state.state ?? JSON.stringify(state)}`);
    if (state.state === "SUCCEEDED" || state.urls?.length || state.signedUrls?.length) break;
    if (state.state === "FAILED" || state.state === "CANCELLED") throw new Error(JSON.stringify(state));
    await new Promise((r) => setTimeout(r, 5000));
  }

  const urls: string[] = state.urls ?? state.signedUrls ?? [];
  if (!urls.length) throw new Error(`No download URL in final state: ${JSON.stringify(state)}`);

  const archive = path.join(args.out!, "archive.zip");
  const zip = await fetch(urls[0]);
  if (!zip.ok) throw new Error(`download failed: ${zip.status} ${zip.statusText}`);
  fs.writeFileSync(archive, Buffer.from(await zip.arrayBuffer()));
  execFileSync("unzip", ["-o", archive, "-d", args.out!], { stdio: "inherit" });

  const candidates = execFileSync("find", [args.out!, "-iname", "History.json"], { encoding: "utf8" })
    .trim()
    .split(/\n/)
    .filter(Boolean);
  if (!candidates.length) throw new Error(`No History.json found under ${args.out}`);

  const raw = JSON.parse(fs.readFileSync(candidates[0], "utf8"));
  const entries = raw["Browser History"] ?? [];
  let min = Infinity;
  let max = -Infinity;
  for (const e of entries) {
    const t = Number(e.time_usec);
    if (!Number.isFinite(t)) continue;
    min = Math.min(min, t);
    max = Math.max(max, t);
  }
  const first = new Date(Math.floor(min / 1000)).toISOString().slice(0, 10);
  const last = new Date(Math.floor(max / 1000)).toISOString().slice(0, 10);
  const days = Math.round((max - min) / 1_000_000 / 86400) + 1;
  console.log(JSON.stringify({ resource: args.resource, entries: entries.length, first, last, days, overOneYear: days > 366 }, null, 2));
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

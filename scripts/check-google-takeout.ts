import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const expected = (arg("--expect") ?? "My Activity").toLowerCase();
const downloadDir = arg("--download-dir") ?? path.join(os.homedir(), "Downloads");
const download = hasFlag("--download");
const importAfter = hasFlag("--import");
const watch = hasFlag("--watch");
const refresh = hasFlag("--refresh");
const intervalSeconds = Number(arg("--interval-seconds") ?? 300);
const timeoutMinutes = Number(arg("--timeout-minutes") ?? 0);
const before = new Set(
  fs.existsSync(downloadDir)
    ? fs.readdirSync(downloadDir).filter((f) => /takeout.*\.zip$/i.test(f)).map((f) => path.join(downloadDir, f))
    : [],
);

const js = String.raw`
(() => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const text = clean(document.body.innerText);
  const isReauth = location.href.includes('accounts.google.com') && /passkey|password|really you|sign in/i.test(text);
  const exportsText = text.match(/YOUR EXPORTS[\s\S]{0,2500}/)?.[0] || text.slice(0, 3000);
  const downloads = [...document.querySelectorAll('a')]
    .map((a, i) => ({ i, text: clean(a.innerText || a.textContent), href: a.href || '' }))
    .filter(x => x.href.includes('takeout/download'));
  const buttons = [...document.querySelectorAll('button,[role=button]')]
    .map((b, i) => ({ i, text: clean(b.innerText || b.textContent), disabled: String(b.disabled || b.getAttribute('aria-disabled') || '') }))
    .filter(x => /cancel|download|create|export/i.test(x.text));
  return JSON.stringify({ url: location.href, title: document.title, exportsText, downloads, buttons, isReauth });
})()
`;

const reloadJs = String.raw`
(() => {
  location.reload();
  return JSON.stringify({ reloaded: true, url: location.href });
})()
`;

function runChrome(script: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-takeout-"));
  const file = path.join(tmp, "script.js");
  fs.writeFileSync(file, script, "utf8");
  try {
    return execFileSync("osascript", ["-l", "JavaScript", "-", file], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
      input: String.raw`
ObjC.import('Foundation');
function readFile(path) { return ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null)); }
function run(argv) {
  const app = Application('Google Chrome');
  const js = readFile(argv[0]);
  for (const w of app.windows()) {
    const tabs = w.tabs();
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      if (String(t.url()).includes('takeout.google.com') || String(t.url()).includes('accounts.google.com')) return t.execute({ javascript: js });
    }
  }
  return 'NO_TAKEOUT_TAB';
}
`,
    }).trim();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface TakeoutState {
  url: string;
  exportsText: string;
  downloads: Array<{ href: string; text: string }>;
  isReauth?: boolean;
  status: "ready" | "pending" | "reauth_required" | "unknown";
}

function checkState(): TakeoutState | "NO_TAKEOUT_TAB" {
  if (refresh) {
    runChrome(reloadJs);
    sleep(3000);
  }
  const raw = runChrome(js);
  if (raw === "NO_TAKEOUT_TAB") return raw;
  const state = JSON.parse(raw) as Omit<TakeoutState, "status">;
  if (state.isReauth) return { ...state, status: "reauth_required" };
  const lower = state.exportsText.toLowerCase();
  const isExpected = lower.includes(expected);
  const inProgress = /creating a copy|process can take|created:/i.test(state.exportsText) && isExpected;
  const ready = /download/i.test(state.exportsText) && isExpected && !inProgress;
  return { ...state, status: ready ? "ready" : inProgress ? "pending" : "unknown" };
}

function printState(state: TakeoutState): void {
  console.log(`url=${state.url}`);
  console.log(`expect=${expected}`);
  console.log(`status=${state.status}`);
  console.log(`downloads=${state.downloads.length}`);
  console.log(state.exportsText.slice(0, 1200));
}

function clickDownload(state: TakeoutState): void {
  const link =
    state.downloads.find((d) => /download/i.test(d.text) && !/report/i.test(d.text) && d.href.includes("takeout/download")) ??
    state.downloads.find((d) => d.href.includes("&i=0&") || d.href.endsWith("&i=0")) ??
    state.downloads.find((d) => d.href.includes("takeout/download"));
  if (!link) throw new Error("Ready state found, but no Takeout download link was visible");
  const click = String.raw`
(() => {
  const links = [...document.querySelectorAll('a')].filter(a => (a.href || '').includes('takeout/download'));
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const link =
    links.find(a => /download/i.test(clean(a.innerText || a.textContent)) && !/report/i.test(clean(a.innerText || a.textContent))) ||
    links.find(a => (a.href || '').includes('&i=0&') || (a.href || '').endsWith('&i=0')) ||
    links[0];
  if (!link) return JSON.stringify({ clicked: false });
  link.click();
  return JSON.stringify({ clicked: true, href: link.href });
})()
`;
  console.log(runChrome(click));
}

function freshDownloads(): string[] {
  const zips = fs.existsSync(downloadDir)
    ? fs.readdirSync(downloadDir).filter((f) => /takeout.*\.zip$/i.test(f)).map((f) => path.join(downloadDir, f))
    : [];
  return zips.filter((z) => !before.has(z) && !z.endsWith(".crdownload"));
}

function waitForDownload(): void {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const fresh = freshDownloads();
    if (fresh.length > 0) {
      console.log(`downloaded=${fresh.join(",")}`);
      if (importAfter) execFileSync("npx", ["tsx", "scripts/import-google-lifetime.ts"], { stdio: "inherit" });
      return;
    }
    sleep(5000);
  }
  console.log("downloaded=timeout_waiting_for_new_zip");
}

function handleState(state: TakeoutState): boolean {
  printState(state);
  if (download && state.status === "ready") {
    clickDownload(state);
    waitForDownload();
    return true;
  }
  if (state.status === "reauth_required") return false;
  return state.status === "ready";
}

const deadline = timeoutMinutes > 0 ? Date.now() + timeoutMinutes * 60 * 1000 : 0;
while (true) {
  const fresh = freshDownloads();
  if (fresh.length > 0) {
    console.log(`downloaded=${fresh.join(",")}`);
    if (importAfter) execFileSync("npx", ["tsx", "scripts/import-google-lifetime.ts"], { stdio: "inherit" });
    break;
  }
  const state = checkState();
  if (state === "NO_TAKEOUT_TAB") {
    console.log("status=no_takeout_tab");
    process.exit(2);
  }
  const done = handleState(state);
  if (!watch || done) break;
  if (deadline && Date.now() >= deadline) {
    console.log("watch=timeout");
    break;
  }
  console.log(`watch=sleep interval_seconds=${intervalSeconds}`);
  sleep(Math.max(1, intervalSeconds) * 1000);
}

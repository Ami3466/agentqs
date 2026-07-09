// Keep in sync with GOOGLE_PRESETS in src/lib/google-web-scraper.ts (canonical)
// and IMPORTERS in content.js. The popup builds its dropdown from this list.
const IMPORTERS = [
  { id: "google_activity_all", label: "All Google activity", url: "https://myactivity.google.com/myactivity?hl=en_GB" },
  { id: "browser_history", label: "Browser history", url: "https://myactivity.google.com/search-services/history?hl=en_GB" },
  { id: "google_search", label: "Search", url: "https://myactivity.google.com/product/search?hl=en_GB" },
  { id: "google_image_search", label: "Image Search", url: "https://myactivity.google.com/product/image_search?hl=en_GB" },
  { id: "google_video_search", label: "Video Search", url: "https://myactivity.google.com/product/video_search?hl=en_GB" },
  { id: "google_maps", label: "Maps", url: "https://myactivity.google.com/product/maps?hl=en_GB" },
  { id: "youtube_history", label: "YouTube", url: "https://myactivity.google.com/product/youtube?hl=en_GB" },
  { id: "google_assistant", label: "Assistant", url: "https://myactivity.google.com/product/assistant?hl=en_GB" },
  { id: "google_play", label: "Play", url: "https://myactivity.google.com/product/play?hl=en_GB" },
  { id: "google_news", label: "News", url: "https://myactivity.google.com/product/news?hl=en_GB" },
  { id: "google_chrome", label: "Chrome", url: "https://myactivity.google.com/product/chrome?hl=en_GB" },
  { id: "google_shopping", label: "Shopping", url: "https://myactivity.google.com/product/shopping?hl=en_GB" },
  { id: "google_translate", label: "Translate", url: "https://myactivity.google.com/product/translate?hl=en_GB" },
  { id: "google_discover", label: "Discover", url: "https://myactivity.google.com/product/discover?hl=en_GB" },
  { id: "google_gemini", label: "Gemini", url: "https://myactivity.google.com/product/gemini?hl=en_GB" },
  { id: "google_timeline", label: "Timeline", url: "https://timeline.google.com/maps/timeline" },
];
const TARGETS = Object.fromEntries(IMPORTERS.map((item) => [item.id, item.url]));
const STATUS_KEY = "agentqsImportStatus";
const BASE_KEY = "agentqsBaseUrl";
const RESUME_KEY = "agentqs-google-exporter-resume"; // mirror written by content.js
const DEFAULT_BASE = "http://localhost:3000";
const PING_ALARM = "agentqs-server-ping";
const WATCHDOG_ALARM = "agentqs-run-watchdog";
// No status write for this long while a checkpoint says "running" = the tab is
// gone, discarded, or frozen. Healthy runs update status every page; the longest
// legit quiet stretch is a ~2-minute retry backoff.
const WATCHDOG_STALE_MS = 5 * 60 * 1000;
// A checkpoint this old is a forgotten run, not an interrupted one — stand down
// instead of surprise-reopening Google tabs weeks later.
const WATCHDOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// Keep in sync with INGEST_FALLBACK in content.js and ingestPort() in
// src/lib/ingest-server.ts: the recompile-proof ingest listener, then the app's
// default port (the configured base is always tried first — a custom port lives
// there, not in this list).
const PING_FALLBACKS = ["http://localhost:3033", "http://localhost:3000"];

async function serverBase() {
  const result = await chrome.storage.local.get([BASE_KEY]);
  const raw = String(result[BASE_KEY] || DEFAULT_BASE).trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(raw) ? raw : DEFAULT_BASE;
}

// Heartbeat: lets the AgentQS Data tab tell "extension installed" from "nothing
// listening", so its Import buttons can guide instead of failing silently.
// Rotates through the same targets batch posts use — the configured base may be
// squatted by another app while the ingest listener still answers.
async function pingServer() {
  const base = await serverBase();
  const targets = [...new Set([base, ...PING_FALLBACKS])];
  for (const target of targets) {
    try {
      const res = await fetch(`${target}/api/automations/google-activity-extension/ping`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: chrome.runtime.getManifest().version }),
      });
      if (res.ok) return;
    } catch {
      /* try the next target; all down = the Data tab shows "not detected" */
    }
  }
}
const AUTO_KEY = "agentqsAutoScrape";
const ALARM_NAME = "agentqs-browser-history-daily";

function targetFor(importer) {
  return TARGETS[importer] || TARGETS.browser_history;
}

function hostFor(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

async function findTargetTab(url) {
  const host = hostFor(url);
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => {
    if (!tab.url) return false;
    try {
      const u = new URL(tab.url);
      return u.host === host;
    } catch {
      return false;
    }
  });
}

async function sendStart(tabId, importer, dryRun) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "agentqs-start-import", importer, dryRun, maxPages: dryRun ? 1 : 100000 });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await chrome.tabs.sendMessage(tabId, { type: "agentqs-start-import", importer, dryRun, maxPages: dryRun ? 1 : 100000 });
      return true;
    } catch {
      return false;
    }
  }
}

async function openAndStart(importer, dryRun) {
  const url = targetFor(importer);
  let tab = await findTargetTab(url);
  if (!tab || tab.id == null) tab = await chrome.tabs.create({ url, active: true });
  else await chrome.tabs.update(tab.id, { active: true, url });

  const status = {
    importer,
    status: "opening",
    text: `Opening ${url}`,
    url,
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [STATUS_KEY]: status });

  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const [fresh] = await chrome.tabs.query({ active: true, currentWindow: true });
    const targetId = (fresh && fresh.url && hostFor(fresh.url) === hostFor(url) ? fresh.id : tab.id);
    if (targetId != null && await sendStart(targetId, importer, dryRun)) return;
  }

  await chrome.storage.local.set({
    [STATUS_KEY]: {
      importer,
      status: "waiting",
      text: "Open the Google page and use the AgentQS panel. The extension could not auto-start yet.",
      url,
      updatedAt: new Date().toISOString(),
    },
  });
}

async function setAutoScrape(enabled, importer) {
  const selectedImporter = TARGETS[importer] ? importer : "browser_history";
  const value = {
    enabled: enabled === true,
    importer: selectedImporter,
    periodMinutes: 24 * 60,
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [AUTO_KEY]: value });
  if (value.enabled) {
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: value.periodMinutes });
  } else {
    await chrome.alarms.clear(ALARM_NAME);
  }
  await chrome.storage.local.set({
    [STATUS_KEY]: {
      importer: value.importer,
      status: value.enabled ? "scheduled" : "idle",
      text: value.enabled ? "Automatic scraping is scheduled daily while Chrome is running." : "Automatic scraping is off.",
      updatedAt: new Date().toISOString(),
    },
  });
  return value;
}

async function getAutoScrape() {
  const result = await chrome.storage.local.get([AUTO_KEY]);
  return result[AUTO_KEY] || { enabled: false, importer: "browser_history", periodMinutes: 24 * 60 };
}

async function restoreAutoScrape() {
  const auto = await getAutoScrape();
  if (auto.enabled) await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: auto.periodMinutes || 24 * 60 });
}

// Watchdog: a multi-day walk must survive everything short of a Google sign-out.
// content.js checkpoints every page into chrome.storage; if that checkpoint says
// "running" but status has gone quiet (computer was shut down and the tab never
// came back, tab discarded by Memory Saver, page frozen, Chrome restarted), this
// reopens/reloads the Google page — where the content script auto-resumes from
// the checkpoint. Pause, completion, and permanent errors mark the checkpoint
// not-running, which stands the watchdog down.
async function watchdogCheck() {
  const stored = await chrome.storage.local.get([RESUME_KEY, STATUS_KEY]);
  const resume = stored[RESUME_KEY];
  if (!resume || resume.running !== true) return;
  const checkpointAge = Date.now() - (Date.parse(resume.updatedAt || "") || 0);
  if (checkpointAge > WATCHDOG_MAX_AGE_MS) {
    await chrome.storage.local.set({
      [RESUME_KEY]: { ...resume, running: false, status: "stale" },
      [STATUS_KEY]: {
        importer: resume.importer,
        status: "stale",
        text: `Found a ${Math.round(checkpointAge / 86400000)}-day-old interrupted import. Start it again from the popup — already-imported items are skipped.`,
        updatedAt: new Date().toISOString(),
      },
    });
    return;
  }
  const status = stored[STATUS_KEY] || {};
  const lastBeat = Math.max(Date.parse(status.updatedAt || "") || 0, Date.parse(resume.updatedAt || "") || 0);
  if (Date.now() - lastBeat < WATCHDOG_STALE_MS) return; // run is alive
  const url = targetFor(resume.importer);
  const tab = await findTargetTab(url);
  if (tab && tab.id != null) {
    // Tab exists but silent — discarded/frozen/dead content script. Reload; the
    // content script's own checkpoint auto-resume takes it from there.
    await chrome.storage.local.set({
      [STATUS_KEY]: { importer: resume.importer, status: "opening", text: "Watchdog: reloading the stalled Google tab to resume the import.", updatedAt: new Date().toISOString() },
    });
    await chrome.tabs.reload(tab.id);
  } else {
    await chrome.storage.local.set({
      [STATUS_KEY]: { importer: resume.importer, status: "opening", text: "Watchdog: reopening the Google page to resume the interrupted import.", updatedAt: new Date().toISOString() },
    });
    await openAndStart(resume.importer, false);
  }
}

function armAlarms() {
  chrome.alarms.create(PING_ALARM, { delayInMinutes: 1, periodInMinutes: 5 });
  chrome.alarms.create(WATCHDOG_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "agentqs-list-importers") return false;
  void pingServer(); // popup open = fresh install signal for the Data tab
  sendResponse({ ok: true, importers: IMPORTERS.map(({ id, label }) => ({ id, label })) });
  return false;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "agentqs-open-and-start") return false;
  openAndStart(message.importer || "browser_history", message.dryRun === true)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

// Popup "Stop": mark the checkpoint not-running (stands the watchdog down) and
// tell the Google tab, if any, to pause its loop. Works even when the tab is gone.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "agentqs-stop-run") return false;
  (async () => {
    const stored = await chrome.storage.local.get([RESUME_KEY]);
    const resume = stored[RESUME_KEY];
    if (resume) await chrome.storage.local.set({ [RESUME_KEY]: { ...resume, running: false, status: "paused" } });
    const tab = await findTargetTab(targetFor(resume && resume.importer));
    if (tab && tab.id != null) await chrome.tabs.sendMessage(tab.id, { type: "agentqs-stop-import" }).catch(() => undefined);
    await chrome.storage.local.set({
      [STATUS_KEY]: {
        importer: (resume && resume.importer) || "browser_history",
        status: "paused",
        text: "Stopped. Start import resumes from the saved checkpoint.",
        updatedAt: new Date().toISOString(),
      },
    });
  })()
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "agentqs-auto-scrape") return false;
  setAutoScrape(message.enabled === true, message.importer)
    .then((auto) => sendResponse({ ok: true, auto }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "agentqs-auto-status") return false;
  getAutoScrape()
    .then((auto) => sendResponse({ ok: true, auto }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  let alarmImporter = "browser_history";
  getAutoScrape()
    .then((auto) => {
      alarmImporter = auto.importer || "browser_history";
      return openAndStart(alarmImporter, false);
    })
    .catch((error) => {
      chrome.storage.local.set({
        [STATUS_KEY]: {
          importer: alarmImporter,
          status: "error",
          text: `Automatic scrape failed: ${error.message}`,
          lastError: error.message,
          updatedAt: new Date().toISOString(),
        },
      });
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PING_ALARM) void pingServer();
  if (alarm.name === WATCHDOG_ALARM) watchdogCheck().catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(() => {
  restoreAutoScrape().catch(() => undefined);
  void pingServer();
  armAlarms();
  // An interrupted run must not wait for the first alarm tick after an
  // extension update/reload — check immediately.
  watchdogCheck().catch(() => undefined);
});

// Chrome (or the whole computer) restarted: this is the moment an interrupted
// multi-day import gets its tab back without any user action.
chrome.runtime.onStartup.addListener(() => {
  restoreAutoScrape().catch(() => undefined);
  void pingServer();
  armAlarms();
  watchdogCheck().catch(() => undefined);
});

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
const DEFAULT_BASE = "http://localhost:3000";
const PING_ALARM = "agentqs-server-ping";

async function serverBase() {
  const result = await chrome.storage.local.get([BASE_KEY]);
  const raw = String(result[BASE_KEY] || DEFAULT_BASE).trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(raw) ? raw : DEFAULT_BASE;
}

// Heartbeat: lets the AgentQS Data tab tell "extension installed" from "nothing
// listening", so its Import buttons can guide instead of failing silently.
async function pingServer() {
  try {
    const base = await serverBase();
    await fetch(`${base}/api/automations/google-activity-extension/ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: chrome.runtime.getManifest().version }),
    });
  } catch {
    /* server not running — the Data tab shows "not detected" until it is */
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
});

chrome.runtime.onInstalled.addListener(() => {
  restoreAutoScrape().catch(() => undefined);
  void pingServer();
  chrome.alarms.create(PING_ALARM, { delayInMinutes: 1, periodInMinutes: 5 });
});

chrome.runtime.onStartup.addListener(() => {
  restoreAutoScrape().catch(() => undefined);
  void pingServer();
  chrome.alarms.create(PING_ALARM, { delayInMinutes: 1, periodInMinutes: 5 });
});

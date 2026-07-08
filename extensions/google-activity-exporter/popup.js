(function () {
  const STATUS_KEY = "agentqsImportStatus";
  const BASE_KEY = "agentqsBaseUrl";
  const DEFAULT_BASE = "http://localhost:3000";
  const statusNode = document.getElementById("status");
  const autoBrowser = document.getElementById("auto-browser");
  const importerSelect = document.getElementById("importer");
  const baseInput = document.getElementById("base-url");

  function render(status) {
    if (!status) {
      statusNode.textContent = "Ready.";
      return;
    }
    const bits = [status.text || "Ready."];
    if (status.updatedAt) bits.push(`Updated ${new Date(status.updatedAt).toLocaleString()}`);
    if (status.lastError) bits.push(`Last error: ${status.lastError}`);
    statusNode.textContent = bits.join("\n");
  }

  function normalizedBase() {
    const raw = (baseInput.value || DEFAULT_BASE).trim().replace(/\/+$/, "");
    return /^https?:\/\//i.test(raw) ? raw : DEFAULT_BASE;
  }

  function loadImporters() {
    chrome.runtime.sendMessage({ type: "agentqs-list-importers" }, (response) => {
      if (!response || !Array.isArray(response.importers)) return;
      importerSelect.textContent = "";
      for (const item of response.importers) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.label;
        importerSelect.appendChild(option);
      }
      loadAuto();
    });
  }

  async function open(url) {
    const target = new URL(url);
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((tab) => {
      if (!tab.url) return false;
      try {
        return new URL(tab.url).origin === target.origin;
      } catch {
        return false;
      }
    });
    if (existing && existing.id != null) {
      await chrome.tabs.update(existing.id, { active: true, url });
      if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }
    await chrome.tabs.create({ url });
  }

  function start(importer, dryRun) {
    statusNode.textContent = dryRun ? "Testing..." : "Starting...";
    chrome.runtime.sendMessage({ type: "agentqs-open-and-start", importer, dryRun }, (response) => {
      if (response && response.error) statusNode.textContent = response.error;
    });
  }

  function loadAuto() {
    chrome.runtime.sendMessage({ type: "agentqs-auto-status" }, (response) => {
      if (response && response.auto) {
        autoBrowser.checked = response.auto.enabled === true;
        if (response.auto.importer) importerSelect.value = response.auto.importer;
      }
    });
  }

  function setAuto(enabled) {
    chrome.runtime.sendMessage({ type: "agentqs-auto-scrape", enabled, importer: importerSelect.value }, (response) => {
      if (response && response.error) {
        statusNode.textContent = response.error;
        autoBrowser.checked = !enabled;
      } else if (response && response.auto) {
        autoBrowser.checked = response.auto.enabled === true;
      }
    });
  }

  chrome.storage.local.get([STATUS_KEY, BASE_KEY], (result) => {
    render(result[STATUS_KEY]);
    baseInput.value = result[BASE_KEY] || DEFAULT_BASE;
  });
  loadImporters();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STATUS_KEY]) render(changes[STATUS_KEY].newValue);
  });

  baseInput.addEventListener("change", () => {
    const base = normalizedBase();
    baseInput.value = base;
    chrome.storage.local.set({ [BASE_KEY]: base });
  });
  document.getElementById("start-import").addEventListener("click", () => start(importerSelect.value, false));
  document.getElementById("test-import").addEventListener("click", () => start(importerSelect.value, true));
  document.getElementById("open-agentqs").addEventListener("click", () => void open(normalizedBase()));
  autoBrowser.addEventListener("change", () => setAuto(autoBrowser.checked));
})();

(function () {
  // The manifest injects this at document_idle AND background.js re-injects it as a
  // fallback when messaging fails; without this guard the second copy would run a
  // parallel export loop with its own state.
  if (window.__agentqsExporterLoaded) return;
  window.__agentqsExporterLoaded = true;

  const DEFAULT_BASE = "http://localhost:3000";
  const BASE_KEY = "agentqsBaseUrl";
  const STATUS_KEY = "agentqsImportStatus";
  const RESUME_KEY = "agentqs-google-exporter-resume";
  const STATE = { running: false, stop: false, pages: 0, seenItems: 0, added: 0, importer: "browser_history", retryTimer: null, workingBase: "" };

  // The AgentQS server base URL is a popup setting (chrome.storage.local) so the
  // extension keeps working when the app serves on a non-default port.
  function apiBase() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([BASE_KEY], (result) => {
          const raw = String((result && result[BASE_KEY]) || DEFAULT_BASE).trim().replace(/\/+$/, "");
          resolve(/^https?:\/\//i.test(raw) ? raw : DEFAULT_BASE);
        });
      } catch {
        resolve(DEFAULT_BASE);
      }
    });
  }
  function myActivityImporter(id, name, targetPath, detail) {
    return {
      id,
      name,
      url: `https://myactivity.google.com${targetPath}`,
      targetPath,
      detail,
      rpc: true,
      ready: () => location.hostname === "myactivity.google.com",
    };
  }

  // Keep in sync with GOOGLE_PRESETS in src/lib/google-web-scraper.ts — that list
  // is the canonical one (the server rejects presets it doesn't know).
  const IMPORTERS = [
    myActivityImporter("google_activity_all", "All Google activity", "/myactivity?hl=en_GB", "All Google My Activity items"),
    myActivityImporter("browser_history", "Browser history", "/search-services/history?hl=en_GB", "Web & App Activity browsing history"),
    myActivityImporter("google_search", "Search", "/product/search?hl=en_GB", "Google Search activity"),
    myActivityImporter("google_maps", "Maps", "/product/maps?hl=en_GB", "Google Maps activity"),
    myActivityImporter("youtube_history", "YouTube", "/product/youtube?hl=en_GB", "YouTube watch/search activity"),
    myActivityImporter("google_assistant", "Assistant", "/product/assistant?hl=en_GB", "Google Assistant activity"),
    myActivityImporter("google_news", "News", "/product/news?hl=en_GB", "Google News activity"),
    myActivityImporter("google_chrome", "Chrome", "/product/chrome?hl=en_GB", "Chrome browsing activity"),
    myActivityImporter("google_shopping", "Shopping", "/product/shopping?hl=en_GB", "Google Shopping activity"),
    myActivityImporter("google_translate", "Translate", "/product/translate?hl=en_GB", "Google Translate history"),
    myActivityImporter("google_gemini", "Gemini", "/product/gemini?hl=en_GB", "Gemini Apps activity"),
    {
      id: "google_timeline",
      name: "Timeline",
      url: "https://timeline.google.com/maps/timeline",
      targetPath: "",
      detail: "Maps location history. Imports the dates shown on the page",
      ready: () => location.hostname === "timeline.google.com",
    },
  ];

  function el(tag, attrs = {}, text = "") {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "style") Object.assign(node.style, v);
      else node.setAttribute(k, String(v));
    }
    if (text) node.textContent = text;
    return node;
  }

  function storageSet(value) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [STATUS_KEY]: value });
      }
    } catch {
      /* storage may be unavailable if the extension context is being torn down */
    }
  }

  // The checkpoint lives in BOTH stores: page localStorage (synchronous reads on
  // this origin) and chrome.storage.local (the background watchdog reads it there
  // to reopen this page after a Chrome/computer restart or a discarded tab).
  function saveResume(value) {
    localStorage.setItem(RESUME_KEY, JSON.stringify(value));
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [RESUME_KEY]: value });
      }
    } catch {
      /* extension context torn down — localStorage copy still resumes in-tab */
    }
    storageSet({ ...value, status: value.status || "running", text: value.text || "", url: location.href });
  }

  function readResume() {
    try {
      return JSON.parse(localStorage.getItem(RESUME_KEY) || "null");
    } catch {
      return null;
    }
  }

  function clearResume() {
    localStorage.removeItem(RESUME_KEY);
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove(RESUME_KEY);
      }
    } catch {
      /* mirror cleanup is best-effort */
    }
  }

  function buttonStyle(bg, color) {
    return {
      border: "1px solid #d0d7de",
      borderRadius: "6px",
      background: bg,
      color,
      cursor: "pointer",
      font: "600 12px system-ui, sans-serif",
      padding: "7px 9px",
    };
  }

  function setStatus(text, extra = {}) {
    const node = document.getElementById("agentqs-google-exporter-status");
    if (node) node.textContent = text;
    storageSet({
      importer: STATE.importer,
      status: STATE.running ? "running" : extra.status || "idle",
      text,
      pages: STATE.pages,
      seenItems: STATE.seenItems,
      added: STATE.added,
      url: location.href,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  }

  function installPanel() {
    if (document.getElementById("agentqs-google-exporter")) return;
    const root = el("div", {
      id: "agentqs-google-exporter",
      style: {
        position: "fixed",
        right: "16px",
        bottom: "16px",
        zIndex: 2147483647,
        width: "300px",
        padding: "12px",
        border: "1px solid #d0d7de",
        borderRadius: "8px",
        background: "#fff",
        color: "#111",
        boxShadow: "0 12px 40px rgba(0,0,0,.18)",
        font: "13px system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      },
    });
    const current = importerForLocation();
    const title = el("div", { style: { fontWeight: 700, marginBottom: "8px" } }, `AgentQS: ${current.name}`);
    const status = el(
      "div",
      { id: "agentqs-google-exporter-status", style: { color: "#57606a", lineHeight: 1.35, marginBottom: "10px" } },
      "Ready.",
    );
    const controls = el("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "10px" } });
    const start = el("button", { type: "button", style: buttonStyle("#0969da", "#fff") }, "Start import");
    const stop = el("button", { type: "button", style: buttonStyle("#f6f8fa", "#cf222e") }, "Pause");
    start.addEventListener("click", () => void runExport({ importerId: current.id, maxPages: 100000 }));
    stop.addEventListener("click", () => pauseRun());
    controls.append(start, stop);
    root.append(title, status, controls);
    document.documentElement.appendChild(root);
    setStatus(status.textContent || "Ready.", { status: "idle" });
  }

  // Pause = stop fetching AND mark the checkpoint not-running, so the background
  // watchdog stands down instead of reviving the run the user just stopped.
  function pauseRun() {
    STATE.stop = true;
    if (STATE.retryTimer) {
      window.clearTimeout(STATE.retryTimer);
      STATE.retryTimer = null;
    }
    const resume = readResume();
    if (resume && resume.running) saveResume({ ...resume, running: false, status: "paused" });
    if (STATE.running) {
      setStatus("Pausing after current page...", { status: "pausing" });
    } else {
      setStatus("Paused. Start import resumes from the saved checkpoint.", { status: "paused" });
    }
  }

  function importerForLocation() {
    if (location.hostname === "timeline.google.com") return IMPORTERS.find((item) => item.id === "google_timeline") || IMPORTERS[0];
    if (location.hostname !== "myactivity.google.com") return IMPORTERS[0];
    const here = location.pathname;
    return (
      IMPORTERS.find((item) => item.targetPath && item.targetPath.split("?")[0] === here) ||
      IMPORTERS.find((item) => item.id === "google_activity_all") ||
      IMPORTERS[0]
    );
  }

  function uniq(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function htmlToken(html, names) {
    for (const name of names) {
      const patterns = [
        new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`),
        new RegExp(`\\["${name}","([^"]+)"\\]`),
        new RegExp(`${name}["']?\\s*[:=]\\s*["']([^"']+)["']`),
      ];
      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) return match[1];
      }
    }
    return "";
  }

  function pageText(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Signed-IN pages also contain "accounts.google.com" and "Sign in" in their HTML
  // (sign-out link, account-switcher markup), so matching those anywhere flags every
  // page as signed out. Only trust unambiguous signals: a redirect onto
  // accounts.google.com, login-flow paths, or a login page <title>.
  function looksSignedOut(html, finalUrl) {
    try {
      if (finalUrl && new URL(finalUrl).hostname === "accounts.google.com") return true;
    } catch {
      /* malformed url — fall through to content checks */
    }
    if (/accounts\.google\.com\/(v3\/signin|ServiceLogin|signin)/i.test(html) && /<form[^>]+identifier|Use your Google Account|Couldn't sign you in/i.test(html)) return true;
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
    return /^\s*(sign in|choose an account)/i.test(title);
  }

  // Feed missing — work out the most helpful error for this page. Errors the user
  // must act on (sign in, preset unavailable) are marked permanent so runExport
  // reports them instead of auto-retrying forever.
  function feedNotFoundError(html, importer, finalUrl) {
    if (looksSignedOut(html, finalUrl)) {
      const err = new Error("Sign in to Google in this Chrome profile, then run the import again.");
      err.permanent = true;
      return err;
    }
    const text = pageText(html).slice(0, 1600);
    if (/Error 4\d\d|Error 5\d\d|not found|can't be found|isn't available|Bad request/i.test(text)) {
      const err = new Error(`${importer.name} is not available from Google My Activity in this account. Try All Google activity.`);
      err.permanent = true;
      return err;
    }
    return new Error(`Could not find Google My Activity data feed for ${importer.name}. Refresh the Google page and try again.`);
  }

  function parseAfRequest(html) {
    const exact = html.match(/'ds:7'\s*:\s*\{id:'([^']+)',request:(\[[\s\S]*?\])\}\s*,/);
    if (exact && exact[1] === "y3VFHd") return { id: exact[1], request: JSON.parse(exact[2]) };
    const all = [...html.matchAll(/'ds:\d+'\s*:\s*\{id:'([^']+)',request:(\[[\s\S]*?\])\}\s*,/g)];
    for (const match of all) {
      if (match[1] !== "y3VFHd") continue;
      return { id: match[1], request: JSON.parse(match[2]) };
    }
    return null;
  }

  async function discoverDisplayItemsRpc(importer) {
    const targetPath = importer.targetPath || (location.pathname + location.search) || "/myactivity?hl=en_GB";
    // The feed config in the current DOM is the fast path; finding it doubles as the
    // signed-in check (Google only serves it to authenticated users).
    let html = targetPath === location.pathname + location.search ? document.documentElement.innerHTML : "";
    let finalUrl = "";
    let af = html ? parseAfRequest(html) : null;
    if (!af) {
      // Fresh raw HTML: the SPA may have consumed the inline config out of the live
      // DOM, and a fetch also reveals a signed-out state via its redirect URL.
      const res = await fetch(targetPath, { credentials: "include" });
      finalUrl = res.url || "";
      html = await res.text();
      af = parseAfRequest(html);
    }
    if (!af || af.id !== "y3VFHd" || !Array.isArray(af.request)) {
      throw feedNotFoundError(html, importer, finalUrl);
    }

    const url = new URL("/_/FootprintsMyactivityUi/data/batchexecute", location.origin);
    url.searchParams.set("rpcids", "y3VFHd");
    url.searchParams.set("source-path", targetPath);
    const fSid = htmlToken(html, ["FdrFJe"]);
    const bl = htmlToken(html, ["cfb2h"]);
    const at = htmlToken(html, ["SNlM0e", "at"]);
    if (fSid) url.searchParams.set("f.sid", fSid);
    if (bl) url.searchParams.set("bl", bl);
    url.searchParams.set("hl", "en_GB");
    url.searchParams.set("soc-app", "712");
    url.searchParams.set("soc-platform", "1");
    url.searchParams.set("soc-device", "1");
    url.searchParams.set("rt", "c");

    return { url, at, initialRequest: af.request, targetPath };
  }

  function parseBatchText(text) {
    return text
      .replace(/^\)\]\}'\s*/, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        if (!line.startsWith("[") && !line.startsWith("{")) return [];
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }

  function decodeRpcPayload(parsed) {
    for (const entry of parsed) {
      if (!Array.isArray(entry)) continue;
      for (const row of entry) {
        if (!Array.isArray(row) || row[0] !== "wrb.fr" || row[1] !== "y3VFHd") continue;
        if (typeof row[2] !== "string") return null;
        return JSON.parse(row[2]);
      }
    }
    return null;
  }

  function extractActivityItems(payload) {
    const out = [];
    const seen = new Set();
    function walk(x) {
      if (!Array.isArray(x)) return;
      if (
        typeof x[4] === "number" &&
        x[4] > 1e15 &&
        Array.isArray(x[7]) &&
        Array.isArray(x[9])
      ) {
        // Dedup only on a real id — when x[5] is missing, seen.has(undefined)
        // would collapse every id-less item after the first into nothing.
        const id = x[5];
        if (id == null) {
          out.push(x);
        } else if (!seen.has(id)) {
          seen.add(id);
          out.push(x);
        }
      }
      for (const item of x) walk(item);
    }
    walk(payload);
    return out;
  }

  function continuationFromPayload(payload) {
    if (Array.isArray(payload) && typeof payload[1] === "string" && payload[1].length > 120) return payload[1];
    return "";
  }

  function continuationRequest(initialRequest, token) {
    return [initialRequest[0], token, initialRequest[2] || 100, null, initialRequest[4] || []];
  }

  function retryablePayloadError(parsed, text) {
    for (const entry of parsed) {
      if (!Array.isArray(entry)) continue;
      for (const row of entry) {
        if (!Array.isArray(row) || row[0] !== "wrb.fr" || row[1] !== "y3VFHd") continue;
        const code = Array.isArray(row[5]) ? row[5][0] : null;
        if (code === 13 || code === 14 || code === 4) {
          const err = new Error(`Temporary Google DisplayItems RPC code ${code}`);
          err.retryable = true;
          err.googleCode = code;
          return err;
        }
      }
    }
    return new Error(`Google DisplayItems RPC returned no payload: ${text.slice(0, 220).replace(/\s+/g, " ")}`);
  }

  async function fetchDisplayItemsPage(api, request) {
    const url = new URL(api.url.toString());
    url.searchParams.set("_reqid", String(10000 + Math.floor(Math.random() * 80000)));
    const envelope = [[["y3VFHd", JSON.stringify(request), null, "generic"]]];
    const form = new URLSearchParams();
    form.set("f.req", JSON.stringify(envelope));
    if (api.at) form.set("at", api.at);

    let res;
    try {
      res = await fetch(url.toString(), {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "x-same-domain": "1",
        },
        body: form.toString(),
      });
    } catch (e) {
      // Network-layer failure ("Failed to fetch": wifi blip, sleep/wake, transient
      // DNS) — retry inline with backoff instead of tearing the whole run down.
      const err = new Error(`Google RPC network error: ${e && e.message ? e.message : e}`);
      err.retryable = true;
      throw err;
    }
    const text = await res.text();
    if (!res.ok) {
      // 401/403 mid-run = the Google session expired — user action needed.
      if (res.status === 401 || res.status === 403) {
        const err = new Error("Google session expired mid-import. Sign in to Google again, then restart the import — it resumes where it left off.");
        err.permanent = true;
        return Promise.reject(err);
      }
      const err = new Error(`Google DisplayItems RPC returned ${res.status}: ${text.slice(0, 220).replace(/\s+/g, " ")}`);
      err.retryable = res.status === 429 || res.status >= 500;
      return Promise.reject(err);
    }
    const parsed = parseBatchText(text);
    const payload = decodeRpcPayload(parsed);
    if (!payload) throw retryablePayloadError(parsed, text);
    return { items: extractActivityItems(payload), ct: continuationFromPayload(payload) };
  }

  async function fetchDisplayItemsPageWithRetry(api, request) {
    let lastError = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        return await fetchDisplayItemsPage(api, request);
      } catch (e) {
        lastError = e;
        if (!e || e.retryable !== true || STATE.stop) break;
        const delay = Math.min(120000, 3000 * Math.pow(2, attempt));
        setStatus(`Google RPC temporary code ${e.googleCode || "http"}; retry ${attempt + 1}/10 in ${Math.round(delay / 1000)}s.`, {
          status: "retrying",
          lastError: e.message,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError || new Error("Google DisplayItems RPC failed.");
  }

  // The standalone ingest listener the agentqs server always runs next to the app
  // port (src/lib/ingest-server.ts) — it bypasses the Next router, so it keeps
  // accepting batches while the app port is down or mid-recompile.
  const INGEST_FALLBACK = "http://localhost:3033";

  async function postBatch(items, page, ct, final, preset = "browser_history") {
    let lastError = null;
    const base = await apiBase();
    // Try the last target that worked first, then rotate through the others —
    // typically the app port, then the recompile-proof ingest listener.
    const targets = [...new Set([STATE.workingBase, base, INGEST_FALLBACK].filter(Boolean))];
    // A LOCAL server can vanish for any stretch (restart, port clash, dev-server
    // recompile 404s, laptop sleep) and always comes back — so transient failures
    // retry without a cap. Pause and the resume checkpoint are the escape hatches.
    // Only a response that proves the request itself can never succeed (unknown
    // preset, rejected origin) fails immediately.
    for (let attempt = 0; !STATE.stop; attempt += 1) {
      const target = targets[attempt % targets.length];
      try {
        const res = await fetch(`${target}/api/automations/google-activity-extension`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ preset, items, page, ct, final }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = new Error(data.error || `AgentQS returned ${res.status}`);
          if (res.status === 400 || res.status === 403) err.permanent = true;
          throw err;
        }
        STATE.workingBase = target;
        STATE.added += data.result && Number.isFinite(data.result.added) ? data.result.added : 0;
        return data;
      } catch (e) {
        if (e && e.permanent === true) throw e;
        lastError = e;
        if (STATE.stop) break;
        // Back off only after a full rotation has failed — switching targets is
        // cheap and usually resolves a one-port outage instantly.
        const cycle = Math.floor((attempt + 1) / targets.length);
        const delay = attempt % targets.length === targets.length - 1
          ? Math.min(120000, 3000 * Math.pow(2, Math.min(cycle, 6)))
          : 250;
        setStatus(`AgentQS unreachable at ${target} (${e && e.message ? e.message : e}); retry ${attempt + 1} in ${Math.round(delay / 1000)}s. Keep this tab open — the import continues by itself once the server is back (URL configurable in the extension popup).`, {
          status: "waiting_for_agentqs",
          lastError: e && e.message ? e.message : String(e),
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError || new Error("AgentQS local server unavailable.");
  }

  function extractVisibleBlocks() {
    const selectors = [
      "main [role=listitem]",
      "main article",
      "[role=listitem]",
      "article",
      "[data-date]",
      "c-wiz",
      "main",
    ];
    const blocks = [];
    const seen = new Set();
    for (const node of document.querySelectorAll(selectors.join(","))) {
      const text = (node.innerText || node.textContent || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (text.length < 20 || text.length > 8000) continue;
      if (!/(20\d{2}|today|yesterday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}:\d{2}|visited|timeline|place|km|mi)/i.test(text)) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      // Plain text blocks — the server dates each block from its own text (a run
      // timestamp would collapse every event onto the import day).
      blocks.push(text);
    }
    return blocks.slice(0, 500);
  }

  async function runDomImport({ importer, dryRun }) {
    STATE.importer = importer.id;
    STATE.running = true;
    STATE.stop = false;
    try {
      setStatus(`Reading ${importer.name} from current page...`, { status: "running" });
      const items = extractVisibleBlocks();
      if (!items.length) throw new Error(`No readable ${importer.name} blocks found on this page.`);
      STATE.pages = 1;
      STATE.seenItems = items.length;
      if (!dryRun) await postBatch(items, 1, "", true, importer.id);
      setStatus(
        dryRun
          ? `Test passed. Found ${items.length} readable ${importer.name} blocks.`
          : `Done. Imported ${STATE.added} AgentQS events from ${items.length} ${importer.name} blocks.`,
        { status: dryRun ? "tested" : "done", running: false },
      );
    } catch (e) {
      setStatus(`Error: ${e && e.message ? e.message : String(e)}`, { status: "error", lastError: e && e.message ? e.message : String(e) });
    } finally {
      STATE.running = false;
    }
  }

  async function runExport({ importerId, maxPages, dryRun = false }) {
    if (STATE.running) return;
    const importer = IMPORTERS.find((item) => item.id === importerId) || IMPORTERS[0];
    STATE.importer = importer.id;
    STATE.running = true;
    STATE.stop = false;
    STATE.pages = 0;
    STATE.seenItems = 0;
    STATE.added = 0;
    // -1 = fresh walk; 0 = resumed from a checkpoint with no page fetched yet
    // (the catch block reads this, so it must exist before the try can throw).
    let pagesSinceResume = -1;
    try {
      if (!importer.rpc) {
        await runDomImport({ importer, dryRun });
        return;
      }
      setStatus("Resolving Google DisplayItems RPC...", { status: "running" });
      const api = await discoverDisplayItemsRpc(importer);
      let request = api.initialRequest;
      let previousCt = "";
      const firstIds = [];
      if (!dryRun) {
        const resume = readResume();
        if (resume && resume.importer === importer.id && resume.targetPath === api.targetPath && typeof resume.ct === "string" && resume.ct.length > 120) {
          STATE.pages = Number(resume.pages) || 0;
          STATE.seenItems = Number(resume.seenItems) || 0;
          STATE.added = Number(resume.added) || 0;
          previousCt = resume.ct;
          pagesSinceResume = 0;
          request = continuationRequest(api.initialRequest, resume.ct);
          setStatus(`Resuming from page ${STATE.pages}, ${STATE.seenItems} prior Google items...`, { status: "running" });
        }
      }

      while (!STATE.stop && STATE.pages < maxPages) {
        const { items, ct } = await fetchDisplayItemsPageWithRetry(api, request);
        STATE.pages += 1;
        if (pagesSinceResume >= 0) pagesSinceResume += 1;
        STATE.seenItems += items.length;
        firstIds.push(items[0] && items[0][5]);
        if (!dryRun) await postBatch(items, STATE.pages, ct, false, importer.id);
        if (!dryRun && ct) {
          saveResume({
            importer: importer.id,
            targetPath: api.targetPath,
            ct,
            pages: STATE.pages,
            seenItems: STATE.seenItems,
            added: STATE.added,
            running: true,
            updatedAt: new Date().toISOString(),
            text: `Exporting... pages ${STATE.pages}, Google items ${STATE.seenItems}, new AgentQS events ${STATE.added}.`,
          });
        }
        setStatus(
          dryRun
            ? `Test ok. Page ${STATE.pages}: ${items.length} items. Next token ${ct ? "present" : "missing"}.`
            : `Exporting... pages ${STATE.pages}, Google items ${STATE.seenItems}, new AgentQS events ${STATE.added}.`,
          { status: dryRun ? "tested" : "running" },
        );
        if (!ct || ct === previousCt || items.length === 0) break;
        previousCt = ct;
        request = continuationRequest(api.initialRequest, ct);
        // No timer between pages: Chrome clamps background-tab timers to 1s (and
        // to 1/minute under intensive throttling), which once stretched a ~2-hour
        // walk into days. The RPC round-trip itself paces the loop; 429/5xx
        // backoff in fetchDisplayItemsPageWithRetry protects Google.
      }

      if (STATE.stop) {
        const resume = readResume();
        if (resume) saveResume({ ...resume, running: false, status: "paused", text: `Paused at page ${STATE.pages}, Google items ${STATE.seenItems}.` });
        setStatus(`Paused at page ${STATE.pages}, Google items ${STATE.seenItems}.`, { status: "paused" });
        return;
      }

      if (!dryRun) await postBatch([], STATE.pages, previousCt, true, importer.id);
      if (!dryRun) clearResume();
      const uniqueFirstPages = uniq(firstIds).length;
      setStatus(
        dryRun
          ? `Test passed. Pages ${STATE.pages}, items ${STATE.seenItems}, unique page starts ${uniqueFirstPages}.`
          : `Done. Pages ${STATE.pages}, Google items ${STATE.seenItems}, new AgentQS events ${STATE.added}.`,
        { status: dryRun ? "tested" : "done", running: false },
      );
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      const resume = readResume();
      // Self-heal: anything not needing user action (Google RPC hiccup, machine
      // sleep, page state gone stale) restarts the export after a cooldown — the
      // resume checkpoint makes the rerun skip everything already imported.
      if (STATE.stop) {
        if (resume) saveResume({ ...resume, running: false, status: "paused", lastError: msg });
        setStatus(`Paused at page ${STATE.pages}, Google items ${STATE.seenItems}.`, { status: "paused" });
      } else if (!dryRun && pagesSinceResume === 0 && (!e || e.permanent !== true)) {
        // The resumed checkpoint produced zero pages — its continuation token has
        // expired (multi-day gap). Restarting from the top is always safe: the
        // server dedups events, so already-imported pages just fast-forward.
        clearResume();
        setStatus(`Saved checkpoint expired (${msg}). Restarting the walk from the top in 5s — already-imported items are skipped server-side.`, { status: "retrying", lastError: msg });
        STATE.retryTimer = window.setTimeout(() => {
          STATE.retryTimer = null;
          if (!STATE.running) void runExport({ importerId: importer.id, maxPages, dryRun });
        }, 5000);
      } else if (!dryRun && (!e || e.permanent !== true)) {
        // Keep the checkpoint marked running: if Chrome dies during this wait, the
        // background watchdog must still know there is a run to revive.
        if (resume) saveResume({ ...resume, running: true, status: "retrying", lastError: msg });
        setStatus(`Error: ${msg} Retrying automatically in 60s (Pause cancels).`, { status: "retrying", lastError: msg });
        STATE.retryTimer = window.setTimeout(() => {
          STATE.retryTimer = null;
          if (!STATE.running) void runExport({ importerId: importer.id, maxPages, dryRun });
        }, 60000);
      } else {
        // Permanent errors (sign in again, preset unavailable) need the user —
        // stand the watchdog down so it does not reopen this page forever.
        if (resume) saveResume({ ...resume, running: false, status: "error", lastError: msg });
        setStatus(`Error: ${msg}`, { status: "error", lastError: msg });
      }
    } finally {
      STATE.running = false;
    }
  }

  installPanel();
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== "agentqs-start-import") return false;
      void runExport({
        importerId: typeof message.importer === "string" ? message.importer : "browser_history",
        maxPages: Number.isFinite(message.maxPages) ? message.maxPages : 100000,
        dryRun: message.dryRun === true,
      });
      sendResponse({ ok: true });
      return false;
    });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== "agentqs-stop-import") return false;
      pauseRun();
      sendResponse({ ok: true });
      return false;
    });
  }
  function autoResume(resume) {
    if (!resume || resume.running !== true || location.hostname !== "myactivity.google.com") return;
    window.setTimeout(() => {
      if (!STATE.running) void runExport({ importerId: resume.importer || "browser_history", maxPages: 100000 });
    }, 1500);
  }
  const resume = readResume();
  if (resume) {
    autoResume(resume);
  } else {
    // localStorage empty (cleared site data) — fall back to the chrome.storage
    // mirror the watchdog uses, so an interrupted run still continues here.
    try {
      chrome.storage.local.get([RESUME_KEY], (result) => {
        const mirrored = result && result[RESUME_KEY];
        if (mirrored && !readResume()) {
          localStorage.setItem(RESUME_KEY, JSON.stringify(mirrored));
          autoResume(mirrored);
        }
      });
    } catch {
      /* no extension storage — nothing to adopt */
    }
  }

  // Deep link from the AgentQS Pipeline tab: opening a Google page with
  // #agentqs-import=<presetId> starts that import once the panel is up, so the
  // web app's "Import" button is one click end to end.
  const deepLink = location.hash.match(/agentqs-import=([a-z_]+)/);
  if (deepLink && IMPORTERS.some((item) => item.id === deepLink[1])) {
    window.setTimeout(() => {
      if (!STATE.running) void runExport({ importerId: deepLink[1], maxPages: 100000 });
    }, 1500);
  }
})();

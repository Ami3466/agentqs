(async function () {
  const key = "__agentqs_live_rpc_probe";
  function save(value) {
    localStorage.setItem(key, JSON.stringify(value));
    return value;
  }

  function parseAfRequest(html) {
    const match = html.match(/'ds:7'\s*:\s*\{id:'([^']+)',request:(\[[\s\S]*?\])\}\s*,/);
    if (!match) return null;
    return { id: match[1], request: JSON.parse(match[2]) };
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

  function extractLongContinuationFromHtml(html) {
    const scripts = Array.from(html.matchAll(/AF_initDataCallback\(([\s\S]*?)\);/g)).map((m) => m[1]);
    const tokenRe = /"((?:AODP|E)[A-Za-z0-9_=-]{140,})"/g;
    for (const script of scripts.reverse()) {
      let match;
      while ((match = tokenRe.exec(script))) {
        if (match[1].length > 140) return match[1];
      }
    }
    return "";
  }

  function batchexecuteTextToPayload(text) {
    const lines = text
      .replace(/^\)\]\}'\s*/, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const arrays = [];
    for (const line of lines) {
      if (!line.startsWith("[") && !line.startsWith("{")) continue;
      try {
        arrays.push(JSON.parse(line));
      } catch {
        /* ignore size lines and partial chunks */
      }
    }
    return arrays;
  }

  function summarizePayload(value) {
    const items = [];
    const longStrings = [];
    const seen = new Set();
    function walk(x, path) {
      if (!x) return;
      if (typeof x === "string") {
        if (x.length > 140) longStrings.push({ path, len: x.length, prefix: x.slice(0, 80) });
        return;
      }
      if (Array.isArray(x)) {
        if (
          typeof x[4] === "number" &&
          x[4] > 1e15 &&
          Array.isArray(x[7]) &&
          Array.isArray(x[9]) &&
          !seen.has(x[5])
        ) {
          seen.add(x[5]);
          items.push({
            path,
            id: x[5],
            ts: x[4],
            service: x[7] && x[7][0],
            title: x[9] && x[9][0],
            action: x[9] && x[9][2],
            url: x[9] && x[9][3],
          });
        }
        for (let i = 0; i < x.length; i++) walk(x[i], `${path}.${i}`);
      }
    }
    walk(value, "root");
    return {
      itemCount: items.length,
      firstItem: items[0] || null,
      lastItem: items[items.length - 1] || null,
      longStrings: longStrings.slice(-8),
      continuation: (Array.isArray(value) && typeof value[1] === "string" && value[1].length > 140 ? value[1] : longStrings.find((s) => /^root\.1$/.test(s.path))?.prefix) || "",
      continuationFull: Array.isArray(value) && typeof value[1] === "string" && value[1].length > 140 ? value[1] : "",
    };
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

  async function callRpc(baseUrl, at, request) {
    const envelope = [[["y3VFHd", JSON.stringify(request), null, "generic"]]];
    const form = new URLSearchParams();
    form.set("f.req", JSON.stringify(envelope));
    if (at) form.set("at", at);
    const res = await fetch(baseUrl.toString(), {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-same-domain": "1",
      },
      body: form.toString(),
    });
    const text = await res.text();
    const parsed = batchexecuteTextToPayload(text);
    const payload = decodeRpcPayload(parsed);
    const summary = payload ? summarizePayload(payload) : null;
    return {
      status: res.status,
      ok: res.ok,
      responsePrefix: text.slice(0, 600),
      parsedTopCount: parsed.length,
      payloadTopLen: Array.isArray(payload) ? payload.length : null,
      summary: summary
        ? {
            itemCount: summary.itemCount,
            firstItem: summary.firstItem,
            lastItem: summary.lastItem,
            continuationLength: summary.continuationFull.length,
            continuationPrefix: summary.continuationFull.slice(0, 80),
            longStrings: summary.longStrings,
          }
        : null,
      continuation: summary ? summary.continuationFull : "",
    };
  }

  try {
    const targetPath = localStorage.getItem("__agentqs_probe_target_path") || (location.pathname + location.search);
    const html = targetPath === location.pathname + location.search
      ? document.documentElement.innerHTML
      : await fetch(targetPath, { credentials: "include" }).then((r) => r.text());
    const af = (window.AF_dataServiceRequests && window.AF_dataServiceRequests["ds:7"]) || parseAfRequest(html);
    const wiz = window.WIZ_global_data || {};
    const fSid = wiz.FdrFJe || htmlToken(html, ["FdrFJe"]);
    const bl = wiz.cfb2h || htmlToken(html, ["cfb2h"]);
    const at = wiz.SNlM0e || htmlToken(html, ["SNlM0e", "at"]);
    if (!af || af.id !== "y3VFHd") throw new Error("Could not find ds:7/y3VFHd request.");

    const baseUrl = new URL("/_/FootprintsMyactivityUi/data/batchexecute", location.origin);
    baseUrl.searchParams.set("rpcids", "y3VFHd");
    baseUrl.searchParams.set("source-path", targetPath);
    if (fSid) baseUrl.searchParams.set("f.sid", fSid);
    if (bl) baseUrl.searchParams.set("bl", bl);
    baseUrl.searchParams.set("hl", "en_GB");
    baseUrl.searchParams.set("soc-app", "712");
    baseUrl.searchParams.set("soc-platform", "1");
    baseUrl.searchParams.set("soc-device", "1");
    baseUrl.searchParams.set("_reqid", String(10000 + Math.floor(Math.random() * 80000)));
    baseUrl.searchParams.set("rt", "c");

    const firstRequest = af.request;
    const htmlContinuation = extractLongContinuationFromHtml(html);
    const results = [];
    const initial = await callRpc(baseUrl, at, firstRequest);
    results.push({ name: "initial", request: firstRequest, ...initial });

    const continuation = initial.continuation || htmlContinuation;
    if (continuation) {
      const continuationRequests = [
        [firstRequest[0], firstRequest[1], firstRequest[2], continuation, firstRequest[4] || []],
        [firstRequest[0], firstRequest[1], firstRequest[2], null, [continuation]],
        [firstRequest[0], continuation, firstRequest[2], null, firstRequest[4] || []],
      ];
      for (let i = 0; i < continuationRequests.length; i++) {
        const req = continuationRequests[i];
        const response = await callRpc(baseUrl, at, req);
        results.push({ name: `continuation-${i + 1}`, request: req, ...response });
      }
    }

    save({
      ok: true,
      url: location.href,
      targetPath,
      af,
      tokens: {
        fSid: fSid || "",
        bl: bl || "",
        atPrefix: at ? String(at).slice(0, 40) : "",
        htmlContinuationLength: htmlContinuation.length,
        htmlContinuationPrefix: htmlContinuation.slice(0, 80),
      },
      results,
    });
  } catch (e) {
    save({ ok: false, error: e && e.message ? e.message : String(e), stack: e && e.stack ? e.stack : "" });
  }
})();

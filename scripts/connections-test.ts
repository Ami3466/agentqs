#!/usr/bin/env tsx
/**
 * Pressure test for the newest API sources — WakaTime, YNAB, Readwise.
 *
 * Beyond "does it land a row" (integration-batch) and "does it bucket by local day"
 * (truncation-test), this hammers the edge cases each normalizer must get right, and
 * drives the REAL plugin.fetch against a controllable fake fetch to prove the auth
 * header, the request shape, and — for Readwise — that it pages to the END.
 *
 * No network. Run: npm run connections:test
 */
import { normalizeWakatime, wakatimePlugin } from "../src/lib/importers/wakatime";
import { normalizeYnab, ynabPlugin } from "../src/lib/importers/ynab";
import { normalizeReadwise, readwisePlugin } from "../src/lib/importers/readwise";
import type { FetchLike } from "../src/lib/importers/plugin";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const FROM = "2026-06-01";
const TO = "2026-06-30";
const NY = "America/New_York";
const jsonFetch = (payload: unknown, capture?: (url: string, init?: RequestInit) => void): FetchLike =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    capture?.(String(url), init);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as FetchLike;

async function main() {
  // ---- WakaTime -------------------------------------------------------------
  console.log("\nWakaTime — coding seconds → minutes, per its own local day:");
  const wk = normalizeWakatime(
    [
      { range: { date: "2026-06-09" }, grand_total: { total_seconds: 7200 } }, // 120 min
      { range: { date: "2026-05-30" }, grand_total: { total_seconds: 3600 } }, // OUT of window
      { range: { date: "2026-06-10" }, grand_total: {} }, // no total_seconds → skipped
      { range: { date: "2026-06-11" }, grand_total: { total_seconds: 90 } }, // 1.5 min
    ],
    FROM,
    TO,
  );
  check("seconds convert to minutes", wk.rows.find((r) => r[0] === "2026-06-09")?.[1] === "120", JSON.stringify(wk.rows));
  check("a day outside the window is dropped", !wk.rows.some((r) => r[0] === "2026-05-30"));
  check("a day with no grand_total is skipped", !wk.rows.some((r) => r[0] === "2026-06-10"));
  check("rows are date-sorted", wk.rows.map((r) => r[0]).join(",") === "2026-06-09,2026-06-11");
  check("empty data → empty table", normalizeWakatime([], FROM, TO).rows.length === 0);
  // fetch sends the key Basic-encoded.
  let wkAuth = "";
  await wakatimePlugin.fetch!({
    from: FROM,
    to: TO,
    credential: "waka_secret",
    fetchImpl: jsonFetch({ data: [{ range: { date: "2026-06-09" }, grand_total: { total_seconds: 60 } }] }, (_u, init) => {
      wkAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    }),
  });
  check("the key is sent Basic-base64 encoded", wkAuth === `Basic ${Buffer.from("waka_secret").toString("base64")}`, wkAuth);

  // ---- YNAB -----------------------------------------------------------------
  console.log("\nYNAB — milliunits → dollars, outflow vs income, deleted skipped:");
  const yn = normalizeYnab(
    [
      { date: "2026-06-12", amount: -52340 }, // spent 52.34
      { date: "2026-06-12", amount: -8000 }, // + spent 8.00 same day
      { date: "2026-06-14", amount: 250000 }, // income 250.00
      { date: "2026-06-14", amount: -15990 }, // spent 15.99 same day
      { date: "2026-06-15", amount: -1000, deleted: true }, // deleted → ignored
      { date: "2026-05-01", amount: -9999 }, // out of window
    ],
    FROM,
    TO,
  );
  const jun12 = yn.rows.find((r) => r[0] === "2026-06-12");
  check("milliunits sum to dollars spent, same day combined", jun12?.[1] === "60.34", JSON.stringify(jun12));
  check("two transactions on the day are counted", jun12?.[3] === "2", JSON.stringify(jun12));
  const jun14 = yn.rows.find((r) => r[0] === "2026-06-14");
  check("income and spend split on the same day", jun14?.[1] === "15.99" && jun14?.[2] === "250", JSON.stringify(jun14));
  check("a deleted transaction is ignored", !yn.rows.some((r) => r[0] === "2026-06-15"));
  check("an out-of-window transaction is dropped", !yn.rows.some((r) => r[0] === "2026-05-01"));
  // fetch sends Bearer + since_date.
  let ynAuth = "", ynUrl = "";
  await ynabPlugin.fetch!({
    from: FROM,
    to: TO,
    credential: "ynab_pat",
    fetchImpl: jsonFetch({ data: { transactions: [{ date: "2026-06-12", amount: -1000 }] } }, (u, init) => {
      ynUrl = u;
      ynAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    }),
  });
  check("the token is sent as a Bearer", ynAuth === "Bearer ynab_pat", ynAuth);
  check("since_date scopes the request to the window start", new URL(ynUrl).searchParams.get("since_date") === FROM, ynUrl);

  // ---- Readwise -------------------------------------------------------------
  console.log("\nReadwise — local-day bucketing, nulls skipped, and it PAGES to the end:");
  const rw = normalizeReadwise(
    [
      { highlighted_at: "2026-06-11T01:00:00Z" }, // 9pm on the 10th in NY
      { highlighted_at: "2026-06-11T02:00:00Z" }, // also the 10th in NY → count 2
      { highlighted_at: null }, // undated → skipped
      { highlighted_at: "2026-06-18T15:00:00Z" }, // the 18th
      { highlighted_at: "2026-05-20T12:00:00Z" }, // out of window
    ],
    FROM,
    TO,
    NY,
  );
  check("UTC timestamps bucket by the local day", rw.rows.find((r) => r[0] === "2026-06-10")?.[1] === "2", JSON.stringify(rw.rows));
  check("a null highlighted_at is skipped", rw.rows.reduce((n, r) => n + Number(r[1]), 0) === 3);
  check("an out-of-window highlight is dropped", !rw.rows.some((r) => r[0] === "2026-05-20"));
  // fetch pages to the END — a plugin that stopped at page 1 would see only page 1.
  let rwAuth = "", pagesAsked = 0;
  const pageBody = (page: number) => ({
    count: 1,
    next: page < 3 ? `https://readwise.io/api/v2/highlights/?page=${page + 1}` : null,
    results: [{ highlighted_at: `2026-06-${String(9 + page).padStart(2, "0")}T12:00:00Z` }],
  });
  const readwiseFetch: FetchLike = (async (url: string | URL | Request, init?: RequestInit) => {
    pagesAsked++;
    rwAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    const page = Number(new URL(String(url)).searchParams.get("page") ?? 1);
    return new Response(JSON.stringify(pageBody(page)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as FetchLike;
  const res = await readwisePlugin.fetch!({ from: FROM, to: TO, credential: "rw_token", fetchImpl: readwiseFetch });
  check("it follows the cursor across all 3 pages (not just page 1)", pagesAsked === 3, `asked ${pagesAsked} pages`);
  check("every page's highlight lands", res.table.rows.length === 3, `${res.table.rows.length} days`);
  check("the token is sent as `Token <key>`", rwAuth === "Token rw_token", rwAuth);

  console.log(
    failures
      ? `\n✗ ${failures} check(s) failed.\n`
      : "\n✓ Connections: WakaTime / YNAB / Readwise — units, windows, edge cases, auth, and paging all hold.\n",
  );
  process.exit(failures ? 1 : 0);
}

void main();

#!/usr/bin/env tsx
/**
 * Ships-when proof for GOOGLE AS ONE CONNECTION.
 *
 *   MAIN: Google is ONE account with ONE key and a tree of products
 *   (Google → Gmail → Sent). Authorizing once connects Calendar AND Gmail off the
 *   same grant; the scope asked for is the union over what is TICKED, so a user who
 *   never wanted Gmail is never asked for their mail; ticking Gmail on a
 *   Calendar-only key reports needsAuthorize instead of dying with a 403 later; and
 *   an UNTICKED product never syncs even though it still holds a working key.
 *
 *   PLUS: the Gmail importer counts (never reads) — real fetch path, message IDs
 *   only — and an unticked half lands no column at all.
 *
 *   AND: backup is not the pipeline. gdrive_backup speaks the same Google OAuth and
 *   is deliberately NOT in the tree and NOT on the shared key.
 *
 * Drives the production core against a temp data dir — no network (Google's token
 * and Gmail endpoints faked via injected fetch). Run: npm run google:test
 */
import fs from "fs";
import os from "os";
import path from "path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-google-"));
process.env.AGENTQS_DATA_DIR = dataDir;

import { readConfig, writeConfig, type AppConfig } from "../src/lib/config";
import { pluginById } from "../src/lib/importers/registry";
import { connectionState, type FetchLike } from "../src/lib/importers/plugin";
import { beginOAuth, completeOAuth } from "../src/lib/oauth";
import { SCOPE_CALENDAR, SCOPE_GMAIL, googleEnabled, googleScopes, nextGoogleSelection } from "../src/lib/google";
import { googleState } from "../src/lib/google-connect";
import { disconnectSource, google, syncSource } from "../src/lib/cli-core";
import { buildSources } from "../src/lib/source-registry";
import { normalizeGmail } from "../src/lib/importers/gmail";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

/** Google's token endpoint. `scope` is what Google says it GRANTED. */
function fakeToken(scope: string) {
  return (async () =>
    new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as FetchLike;
}

/** Run the whole dance for real, granting exactly `scope`. */
async function authorize(scope: string) {
  const { authorizeUrl } = beginOAuth("gcal", "cid", "csec", "http://127.0.0.1:3106");
  const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
  await completeOAuth("code", state, fakeToken(scope));
  return new URL(authorizeUrl);
}

/**
 * Gmail's messages.list. Counts come from `perDay`; the request must ask for IDs
 * only (that is the privacy promise, so the test enforces it).
 */
function fakeGmail(perDay: Record<string, { received: number; sent: number }>) {
  const asked: string[] = [];
  const fn = (async (url: unknown) => {
    const u = new URL(String(url));
    const q = u.searchParams.get("q") ?? "";
    asked.push(q);
    // THE PRIVACY PROMISE: Gmail may only ever ask for message IDs — no bodies, no
    // subjects, no senders, no snippets. Assert the SHAPE of the mask, not one exact
    // string: the cheap hasAnyData probe asks for `messages/id` alone (it does not page),
    // which is strictly less, and an over-literal fixture called that a violation.
    const fields = u.searchParams.get("fields") ?? "";
    const allowed = new Set(["nextPageToken", "messages/id"]);
    if (!fields || fields.split(",").some((f) => !allowed.has(f.trim()))) {
      return new Response(`importer asked for more than message IDs: ${fields}`, { status: 500 });
    }
    // Q_SENT starts with "in:sent"; Q_RECEIVED starts with "-in:sent".
    const sent = q.startsWith("in:sent");
    // Gmail answers a RANGE, and both callers use one: the per-day counter asks about a
    // single day, the cheap hasAnyData probe about a whole year. A fake that only
    // understood one-day windows made every year look empty to the probe.
    const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
    const before = Number(/before:(\d+)/.exec(q)?.[1] ?? 0);
    const from = new Date(after * 1000).toISOString().slice(0, 10);
    const to = new Date((before - 1) * 1000).toISOString().slice(0, 10);
    const n = Object.entries(perDay)
      .filter(([day]) => day >= from && day <= to)
      .reduce((sum, [, c]) => sum + c[sent ? "sent" : "received"], 0);
    return new Response(
      JSON.stringify({ messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}` })) }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as FetchLike;
  return { fn, asked };
}

async function main() {
  fs.mkdirSync(path.join(dataDir, "record", "daily"), { recursive: true });
  writeConfig({
    username: "t",
    passwordHash: "x",
    sessionSecret: "s",
    createdAt: new Date().toISOString(),
  } as unknown as AppConfig);

  // ---- 1. The tree, and the default -------------------------------------------
  console.log("\nthe tree:");
  const fresh = googleState();
  check(
    "Calendar is on by default, Gmail is NOT (a new scope is never taken silently)",
    fresh.products.find((p) => p.id === "calendar")?.enabled === true &&
      fresh.products.find((p) => p.id === "gmail")?.enabled === false,
  );
  check(
    "Gmail nests Inbox and Sent under it (google >> gmail >> sent)",
    fresh.products.filter((p) => p.parent === "gmail").map((p) => p.id).join(",") ===
      "gmail.inbox,gmail.sent",
  );
  check("nothing is connected before a key is stored", fresh.connected === false);

  // ---- 2. ONE KEY -------------------------------------------------------------
  console.log("\none key, two products:");
  check(
    "Calendar and Gmail declare the SAME provider key",
    pluginById("gcal")?.oauth?.providerKey === "google" &&
      pluginById("gmail")?.oauth?.providerKey === "google",
  );
  check(
    "the Drive BACKUP target does not join the source key (backup is not the pipeline)",
    pluginById("gdrive_backup")?.oauth?.providerKey === undefined,
  );

  // Calendar only → we ask Google for calendar, and NOT for mail.
  let url = await authorize(SCOPE_CALENDAR);
  check(
    "with only Calendar ticked, the consent screen asks for calendar and NOT gmail",
    url.searchParams.get("scope") === SCOPE_CALENDAR,
    String(url.searchParams.get("scope")),
  );
  const cfg1 = readConfig();
  check("the grant lands in the SHARED slot, not under the plugin id", Boolean(cfg1?.sourceOAuth?.google?.refreshToken));
  check(
    "…and BOTH products read as connected off that one key",
    connectionState(pluginById("gcal")!, cfg1, "gcal").connected === true &&
      connectionState(pluginById("gmail")!, cfg1, "gmail").connected === true,
  );

  // ---- 3. Ticking is not connecting -------------------------------------------
  console.log("\nticking a product the key can't open:");
  let state = google({ enable: ["gmail.inbox", "gmail.sent"] });
  check("Gmail is now ticked", state.products.find((p) => p.id === "gmail")?.enabled === true);
  check(
    "the card says the stored key was never granted the mail scope",
    state.needsAuthorize === true && state.missingProducts.join(",") === "Gmail",
    `needsAuthorize=${state.needsAuthorize} missing=${state.missingProducts.join(",")}`,
  );
  check(
    "the scope we would now ask for is the UNION over what's ticked",
    googleScopes(readConfig()) === `${SCOPE_CALENDAR} ${SCOPE_GMAIL}`,
    googleScopes(readConfig()),
  );

  // Re-authorize the SAME key, this time granted both.
  url = await authorize(`${SCOPE_CALENDAR} ${SCOPE_GMAIL}`);
  check(
    "re-authorizing asks for both scopes at once",
    (url.searchParams.get("scope") ?? "").includes(SCOPE_GMAIL),
  );
  state = googleState();
  check("…and the nag clears — one key, both doors", state.needsAuthorize === false);
  check("still ONE grant, not two", Object.keys(readConfig()?.sourceOAuth ?? {}).join(",") === "google");

  // A dropped scope on the consent screen is caught: Google's reply is the truth.
  await authorize(SCOPE_CALENDAR); // user unticked Gmail on Google's own screen
  check(
    "if the user drops a scope at Google, the card believes GOOGLE, not our request",
    googleState().needsAuthorize === true,
  );
  await authorize(`${SCOPE_CALENDAR} ${SCOPE_GMAIL}`); // put it back for the rest

  // ---- 4. The importer COUNTS, it does not READ --------------------------------
  console.log("\nthe Gmail importer:");
  const gmail = pluginById("gmail")!;
  const { fn, asked } = fakeGmail({
    "2026-07-10": { received: 12, sent: 3 },
    "2026-07-11": { received: 0, sent: 1 },
  });
  const res = await gmail.fetch!({ credential: "at", from: "2026-07-10", to: "2026-07-11", fetchImpl: fn });
  check(
    "it lands received + sent per day",
    JSON.stringify(res.table) ===
      JSON.stringify({
        header: ["date", "emails_received", "emails_sent"],
        rows: [
          ["2026-07-10", "12", "3"],
          ["2026-07-11", "0", "1"],
        ],
      }),
    JSON.stringify(res.table),
  );
  check(
    "'received' is not in:inbox — archiving must never rewrite last Tuesday",
    asked.every((q) => !q.startsWith("in:inbox")) && asked.some((q) => q.startsWith("-in:sent")),
  );

  // Untick Sent → the column must not exist at all (not a wall of zeroes).
  google({ disable: ["gmail.sent"] });
  const inboxOnly = await gmail.fetch!({
    credential: "at",
    from: "2026-07-10",
    to: "2026-07-10",
    fetchImpl: fakeGmail({ "2026-07-10": { received: 12, sent: 3 } }).fn,
  });
  check(
    "an unticked half lands NO column (never a fake zero)",
    JSON.stringify(inboxOnly.table.header) === JSON.stringify(["date", "emails_received"]),
    JSON.stringify(inboxOnly.table.header),
  );
  check(
    "normalizeGmail is pure and agrees",
    JSON.stringify(normalizeGmail([{ date: "2026-07-10", received: 12 }], { inbox: true, sent: false })) ===
      JSON.stringify({ header: ["date", "emails_received"], rows: [["2026-07-10", "12"]] }),
  );
  check(
    "a day with no mail at all lands NO row — we never claim you received nothing in 2011",
    normalizeGmail([{ date: "2011-01-01", received: 0, sent: 0 }], { inbox: true, sent: true }).rows.length === 0,
  );

  // ---- 4b. A FIRST IMPORT TAKES THE WHOLE ACCOUNT ------------------------------
  // Gmail used to declare a 400-day ceiling, and that ceiling was PERMANENT: the
  // first import took the last 400 days, every later sync resumed from the newest
  // recorded day, and `--days 3000` was sliced straight back to the same recent 400.
  // Mail from 2022 was unreachable by any command — the record just reported that
  // Gmail began the year you connected it. Drives the REAL sync path (syncWindow →
  // backfill walk → merge), with Google's token endpoint and Gmail both faked.
  console.log("\na first Gmail import walks the whole account:");
  google({ enable: ["gmail.inbox", "gmail.sent"] });
  const lifetime = {
    "2022-03-15": { received: 7, sent: 2 }, // ~1,580 days back — far past any 400-day cap
    "2023-06-01": { received: 9, sent: 1 },
    "2024-01-01": { received: 4, sent: 0 },
    "2025-05-05": { received: 11, sent: 3 },
    "2026-07-10": { received: 12, sent: 3 },
  };
  const mail = fakeGmail(lifetime);
  const realFetch = globalThis.fetch;
  // One stub for the whole path: refresh the grant, then count mail.
  globalThis.fetch = (async (url: unknown, init: unknown) =>
    String(url).includes("oauth2.googleapis.com")
      ? await fakeToken(`${SCOPE_CALENDAR} ${SCOPE_GMAIL}`)(url as string, init as RequestInit)
      : await mail.fn(url as string, init as RequestInit)) as unknown as typeof fetch;
  let synced: Awaited<ReturnType<typeof syncSource>> | null = null;
  try {
    synced = await syncSource({ id: "gmail" });
  } finally {
    globalThis.fetch = realFetch;
  }
  const landed = fs.readFileSync(path.join(dataDir, "record", "daily", "gmail.csv"), "utf8").trim().split("\n");
  const dates = landed.slice(1).map((l) => l.split(",")[0]);
  check(
    `it reaches back to the account's first mail (${dates[0]}), not a 400-day slice`,
    dates[0] === "2022-03-15",
    dates[0],
  );
  check(
    "every year in between lands too, and only the days that HAD mail",
    JSON.stringify(dates) === JSON.stringify(Object.keys(lifetime)),
    JSON.stringify(dates),
  );
  // It ASKS about every year back to the floor (a gap is not an ending — see
  // truncation:test), but it REPORTS the window that actually held mail.
  check(
    `the reported window starts at the account's first mail, not at the floor (from=${synced?.from})`,
    (synced?.from ?? "") > "2020-01-01",
  );
  // That was a REAL sync: it stamped the ledger AND wrote record/daily/gmail.csv,
  // and "when did this last sync?" falls back to that file's mtime. The scheduling
  // checks below ask whether a ticked Gmail is DUE, which presumes it has never run —
  // so put the world back exactly as they found it.
  const afterSync = readConfig()!;
  delete afterSync.sourceSyncedAt?.gmail;
  writeConfig(afterSync);
  fs.rmSync(path.join(dataDir, "record", "daily", "gmail.csv"), { force: true });

  // ---- 4c. "I ticked Sent, and it saved BOTH" ---------------------------------
  // The card used to POST deltas (enable/disable), which the server applies to
  // whatever it holds WHEN THEY ARRIVE. The natural way to get "Gmail, sent only" is
  // to tick Gmail — which turns on both leaves — and then untick Inbox. Two deltas,
  // in flight together: if `disable:[inbox]` reached the server before
  // `enable:[inbox,sent]`, the enable won and Inbox came back ON. You asked for Sent,
  // you got both, and nothing you clicked afterwards looked like it saved.
  // The card now sends the WHOLE TICKED SET, which cannot be reordered into a
  // different answer, and this is that set — the same function the checkboxes call.
  console.log("\nticking Sent saves Sent, and nothing else:");
  google({ products: ["calendar"] }); // back to the default
  const ticked = () => googleEnabled(readConfig()).join(",");

  // Straight at the leaf.
  google({ products: nextGoogleSelection(googleEnabled(readConfig()), ["gmail.sent"], true) });
  check(`tick Sent → Sent only (${ticked()})`, ticked() === "calendar,gmail.sent");

  // The branch: one click, both leaves. Then take Inbox back off.
  google({ products: ["calendar"] });
  const bothOn = nextGoogleSelection(googleEnabled(readConfig()), ["gmail"], true);
  google({ products: bothOn });
  check(`tick the Gmail branch → both leaves (${ticked()})`, ticked() === "calendar,gmail.inbox,gmail.sent");
  google({ products: nextGoogleSelection(googleEnabled(readConfig()), ["gmail.inbox"], false) });
  check(`…then untick Inbox → Sent survives (${ticked()})`, ticked() === "calendar,gmail.sent");

  // The set is a STATEMENT, not an instruction: replaying it in any order lands the
  // same place. A delta could not say that — which is the whole bug.
  const sentOnly = nextGoogleSelection(["calendar", "gmail.inbox", "gmail.sent"], ["gmail.inbox"], false);
  google({ products: sentOnly });
  google({ products: sentOnly });
  check(`re-sending the same set is idempotent (${ticked()})`, ticked() === "calendar,gmail.sent");
  check(
    "unticking the Gmail branch clears BOTH leaves, never half of it",
    nextGoogleSelection(["calendar", "gmail.inbox", "gmail.sent"], ["gmail"], false).join(",") === "calendar",
  );

  // ---- 5. Unticking actually STOPS it -----------------------------------------
  // The trap: Gmail shares the connected key, so it stays "connected" when unticked.
  // If `due` ignored the checkbox, unticking Gmail while it had a daily schedule
  // would go on pulling mail on a cadence the user thought they'd switched off.
  console.log("\nunticking a product actually stops it:");
  const cfg = readConfig()!;
  cfg.sourceIntervals = { ...(cfg.sourceIntervals ?? {}), gmail: "daily" };
  writeConfig(cfg);
  google({ disable: ["gmail.inbox", "gmail.sent"] }); // Gmail fully off, key still valid
  const rows = buildSources(readConfig(), path.join(dataDir, "record"));
  const gmailRow = rows.find((s) => s.id === "gmail")!;
  check(
    "an unticked Gmail still holds the key (connected ⇔ stored credential — the rule holds)",
    gmailRow.connected === true,
  );
  check(
    "…but it is NEVER due, schedule or no schedule",
    gmailRow.interval === "daily" && gmailRow.due === false,
    `interval=${gmailRow.interval} due=${gmailRow.due}`,
  );
  check(
    "syncing it anyway fails LOUDLY instead of silently pulling nothing",
    await gmail
      .fetch!({ credential: "at", from: "2026-07-10", to: "2026-07-10", fetchImpl: fn })
      .then(() => false)
      .catch((e: Error) => /nothing checked/i.test(e.message)),
  );
  google({ enable: ["gmail.inbox"] });
  check(
    "tick it back on and it is due again",
    buildSources(readConfig(), path.join(dataDir, "record")).find((s) => s.id === "gmail")?.due === true,
  );

  // ---- 6. One card, not three strangers ---------------------------------------
  console.log("\none card:");
  const all = buildSources(readConfig(), path.join(dataDir, "record"));
  check(
    "Calendar and Gmail are tagged as ONE provider, so the UI folds them into one card",
    all.filter((s) => s.provider === "google").map((s) => s.id).sort().join(",") === "gcal,gmail",
  );
  check(
    "the Drive backup target is not a source row at all",
    !all.some((s) => s.id === "gdrive_backup"),
  );
  check(
    "unticking never deleted the credential",
    Boolean(readConfig()?.sourceOAuth?.google?.refreshToken),
  );

  // ---- 7. Removing ONE product must not disconnect the other -------------------
  // They share a key, so a naive "forget this source's grant" would take Gmail's
  // key away when the user removed Calendar. And the key must still GO once the
  // last product on it is gone — a dangling credential is a lie about connectedness.
  console.log("\nremoving one product of a shared key:");
  google({ products: ["calendar", "gmail.inbox"] });
  fs.writeFileSync(path.join(dataDir, "record", "daily", "gcal.csv"), "date,meetings\n2026-07-10,2\n");
  disconnectSource("gcal");
  check(
    "removing Calendar leaves the key — Gmail is still riding it",
    Boolean(readConfig()?.sourceOAuth?.google?.refreshToken),
  );
  check(
    "…and Gmail is still connected and still ticked",
    connectionState(pluginById("gmail")!, readConfig(), "gmail").connected === true &&
      googleState().products.find((p) => p.id === "gmail.inbox")?.enabled === true,
  );
  check("…while Calendar is unticked", googleState().products.find((p) => p.id === "calendar")?.enabled === false);

  disconnectSource("gmail"); // the last product on the key
  check(
    "removing the LAST product finally forgets the key (no dangling credential)",
    !readConfig()?.sourceOAuth?.google,
  );
  check("…and Google reads as disconnected", googleState().connected === false);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall good\n");
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

void main();

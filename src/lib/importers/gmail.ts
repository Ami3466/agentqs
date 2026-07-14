import { readConfig, type AppConfig } from "../config";
import { gmailParts, googleScopes, SCOPE_GMAIL } from "../google";
import {
  getJson,
  mapPool,
  type DailyTable,
  type FetchLike,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Gmail — how much mail moves through your day.
 *
 * It COUNTS, it does not READ. Every request asks Gmail for message IDs and
 * nothing else (`fields=messages/id`): no bodies, no subjects, no senders, no
 * snippets. Two numbers land in the record and that is all:
 *
 *   emails_received — mail that ARRIVED that day
 *   emails_sent     — mail you sent that day
 *
 * Half of Gmail can be off: the Pipeline's Google card checks Inbox and Sent
 * independently (Google → Gmail → Sent), so an unchecked half is never fetched
 * and never lands a column.
 *
 * WHY "received" is not `in:inbox`: the record must not rewrite its own past.
 * `in:inbox` means "is in the inbox RIGHT NOW", so archiving a message from last
 * Tuesday would silently lower last Tuesday's count on the next sync. What
 * arrived on a day never changes, so that is what we ask for — everything that
 * isn't yours and isn't a draft or a chat. Archive all you like; the history holds.
 *
 * Auth is the SHARED Google OAuth grant (provider key `google`) — the same key
 * Calendar uses. Ticking Gmail widens that grant's scope; it does not create a
 * second connection.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

/** Mail that arrived: not sent by me, not a draft, not a chat. Stable forever —
 *  unlike `in:inbox`, archiving does not retro-edit it. Spam and trash are
 *  excluded by Gmail's default search scope, which is what we want. */
const Q_RECEIVED = "-in:sent -in:draft -in:chats";
const Q_SENT = "in:sent";

/**
 * Gmail is counted one day at a time, so a year of history is ~730 round-trips.
 * That cost once bought a HARD CAP of 400 days — and a cap is a lie about your
 * mail: the first import took the last 400 days, every later sync resumed from the
 * newest recorded day, and `--days 3000` was silently trimmed back to the same
 * recent 400. There was no path to 2019 at all; the record simply reported that
 * Gmail began the year you connected it.
 *
 * The cost was never Google's limit, it was our patience. Gmail's quota allows ~50
 * list calls a second; the walk was just SERIAL. So we fan the days out (`mapPool`)
 * and let Gmail take the same backward walk as every other source — a year-chunk at
 * a time until the account runs dry, each chunk merged as it lands, so a long first
 * import is resumable and never re-fetches what it already has.
 */
const DAY_CONCURRENCY = 8;

export interface GmailDay {
  date: string;
  received?: number;
  sent?: number;
}

/** UTC midnight, in epoch SECONDS — Gmail's after:/before: accept a timestamp,
 *  which is exact, where `after:2026/07/12` is interpreted in the account's own
 *  timezone and quietly slides the boundary. */
function epochDay(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Count the messages matching `q` — IDs only, following every page. */
async function countMessages(
  q: string,
  credential: string,
  fetchImpl: FetchLike,
): Promise<number> {
  let total = 0;
  let pageToken: string | undefined;
  do {
    const url = new URL(API);
    url.searchParams.set("q", q);
    url.searchParams.set("maxResults", "500");
    // IDs and nothing else. The one line that keeps this importer a counter.
    url.searchParams.set("fields", "nextPageToken,messages/id");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const raw = (await getJson(
      url.toString(),
      { Authorization: `Bearer ${credential}`, Accept: "application/json" },
      fetchImpl,
    )) as { messages?: { id: string }[]; nextPageToken?: string };
    total += raw?.messages?.length ?? 0;
    pageToken = raw?.nextPageToken;
  } while (pageToken);
  return total;
}

/** Pure: days → the daily table. A half that was never fetched lands NO column
 *  (an unchecked Sent must not write a wall of zeroes into the record).
 *
 *  A day where every fetched half is zero lands NO ROW. Before the account existed
 *  there is no mail to count, and writing `0` for those days would be a claim we
 *  cannot make — that you received no mail in 2011, rather than that Gmail did not
 *  yet know you. It also matters mechanically: the backward walk stops when a chunk
 *  comes back empty, so a year of invented zeroes would look like data and march the
 *  walk all the way to the floor, one wasted round-trip per day. (An active account
 *  does not have zero-mail days; a day with a single newsletter still lands.) */
export function normalizeGmail(days: GmailDay[], parts: { inbox: boolean; sent: boolean }): DailyTable {
  const header = ["date"];
  if (parts.inbox) header.push("emails_received");
  if (parts.sent) header.push("emails_sent");
  const rows = [...days]
    .filter((d) => (parts.inbox ? (d.received ?? 0) : 0) + (parts.sent ? (d.sent ?? 0) : 0) > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((d) => {
      const row = [d.date];
      if (parts.inbox) row.push(String(d.received ?? 0));
      if (parts.sent) row.push(String(d.sent ?? 0));
      return row;
    });
  return { header, rows };
}

export const gmailPlugin: ImporterPlugin = {
  id: "gmail",
  name: "Gmail",
  detail: "mail received & sent per day",
  live: true,
  // NO backfillDays. Gmail takes the same walk as every other source: a first import
  // steps back a year at a time until the account runs dry. It is the slowest source
  // we have (one search per day, per half) — that is a reason to fan out and to warn,
  // never a reason to decide on the user's behalf that their mail begins in 2025.
  historyNote:
    "Gmail is counted one day at a time, so a first import walks your whole account year by year and can take several minutes — it runs in the background and each year is saved as it lands, so it picks up where it left off.",
  requiresCredential: true,
  credentialLabel: "OAuth access token",
  credentialPlaceholder: "ya29.… (OAuth access token)",
  credentialHelp: {
    url: "https://console.cloud.google.com/apis/credentials",
    steps: [
      "Gmail rides the SAME Google connection as Calendar — if Google is already connected, just tick Gmail on the Pipeline's Google card and press Re-authorize. Google has to be asked for the mail scope once; there is no second key to paste.",
      "Setting Google up from scratch: in Google Cloud Console create a project and enable BOTH the Google Calendar API and the Gmail API.",
      "Configure the OAuth consent screen (External) and add your own Google account as a test user.",
      "Credentials → Create OAuth client ID → Web application, with the Redirect URI shown here.",
      "Paste the Client ID and Client Secret here and press Authorize.",
    ],
  },
  oauth: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: SCOPE_GMAIL,
    // ONE Google connection: Calendar and Gmail share this grant, and the scope
    // asked for is the union over what's ticked on the Google card. See google.ts.
    providerKey: "google",
    scopeFor: googleScopes,
    tokenAuth: "body",
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  envKey: "GMAIL_TOKEN",
  primaryMetric: "emails_received",
  unit: "emails",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const cfg: AppConfig | null = readConfig();
    const parts = gmailParts(cfg);
    if (!parts.inbox && !parts.sent) {
      throw new Error(
        "Gmail has nothing checked. Tick Inbox and/or Sent under Google → Gmail on the Pipeline tab (CLI: agentqs google enable gmail.inbox).",
      );
    }
    const credential = ctx.credential ?? "";

    // The window is asked for EXACTLY as given — no slicing back to a "recent end".
    // The old cap kept the newest 400 days of whatever it was handed, which is why
    // asking for more could never reach further back: the extra days were thrown
    // away rather than fetched.
    const days = eachDay(ctx.from, ctx.to);
    const out = await mapPool(days, DAY_CONCURRENCY, async (date) => {
      const start = epochDay(date);
      const end = start + 86_400;
      const window = `after:${start} before:${end}`;
      const day: GmailDay = { date };
      try {
        if (parts.inbox) day.received = await countMessages(`${Q_RECEIVED} ${window}`, credential, fetchImpl);
        if (parts.sent) day.sent = await countMessages(`${Q_SENT} ${window}`, credential, fetchImpl);
      } catch (e) {
        throw new Error(`Gmail messages (${date}) → ${(e as Error).message}`);
      }
      return day;
    });

    return {
      table: normalizeGmail(out, parts),
      meta: {
        days: days.length,
        parts: [parts.inbox ? "inbox" : null, parts.sent ? "sent" : null].filter(Boolean).join("+"),
      },
    };
  },
};

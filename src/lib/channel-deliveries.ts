import fs from "fs";
import path from "path";
import { dataDir } from "./paths";

/**
 * Inbound delivery ledger for capture channels (Slack · Telegram).
 *
 * The failure this exists for: messages stopped arriving and there was NO WAY to
 * tell why. The record simply had nothing after a certain date, and every question
 * that would settle it was unanswerable from the app —
 *
 *   did Slack even POST us?          (subscription disabled → nothing arrives)
 *   did it POST and we refuse it?    (signing-secret mismatch → every event 401s)
 *   did we take it and drop it?      (bot echo, edit, retry → deliberately ignored)
 *
 * All three look identical from the outside: an empty inbox. So every inbound POST
 * now writes down what happened to it, ACCEPTED OR REFUSED, and the channel's
 * Pipeline row and Settings card say so out loud. "Nothing since Jul 16" and
 * "rejected 3 minutes ago: bad request signature" are completely different bugs
 * with completely different fixes, and the app should never make you guess which
 * one you have.
 *
 * Derived state under the data dir, never part of the record: losing it costs only
 * delivery history, and a corrupt file degrades to "no history". Bounded — the last
 * few deliveries per channel, so a chatty bot can't grow it without limit.
 */

/** What became of one inbound webhook POST. */
export type DeliveryOutcome =
  | "captured" // became an inbox item (a memo / a log-only channel)
  | "replied" // answered with a grounded reply
  | "ignored" // valid but nothing to answer (bot echo, edit, retry, handshake)
  | "duplicate" // the platform re-delivered something we already have
  | "rejected"; // refused before we did any work — see `detail`

/**
 * WHICH DIRECTION the row is about. This ledger is named for inbound deliveries,
 * and the poll wrote into it as if it were one: a poll that could not reach
 * slack.com recorded outcome "rejected", and the card then said "Slack delivered a
 * message and this app REFUSED it — C0BEXMYAVU3: fetch failed" when Slack had
 * delivered nothing at all. The inverse lied too — a successful poll wrote
 * "captured", so a webhook that had never once fired read as healthy.
 *
 * "push" = an inbound webhook POST from the platform. "pull" = our own outbound
 * poll of its history API. Absent means "push": every row written before this
 * field existed was an inbound POST.
 */
export type DeliveryVia = "push" | "pull";

export interface DeliveryRecord {
  at: string; // ISO time the POST reached us
  outcome: DeliveryOutcome;
  detail?: string; // why it was rejected / what was ignored
  via?: DeliveryVia; // default "push" — see DeliveryVia
}

export interface ChannelDeliveryState {
  /** Most recent row of ANY outcome and either direction. */
  last?: DeliveryRecord;
  /** Most recent inbound WEBHOOK row, whatever its outcome. The only evidence that
   *  the platform is still calling us — a poll capturing happily says nothing
   *  about it, and that is precisely how a dead subscription stayed invisible. */
  lastPush?: DeliveryRecord;
  /** Most recent PUSH we refused — the thing that silently kills a bot. A poll that
   *  failed is our side of the wire and never belongs here. */
  lastRejected?: DeliveryRecord;
  /** Most recent one that actually landed in the record (either direction). */
  lastAccepted?: DeliveryRecord;
  /** Lifetime counts per outcome, so a rejection RATE is visible, not just the last one. */
  counts?: Partial<Record<DeliveryOutcome, number>>;
  /** Tail of recent deliveries, newest first (bounded). */
  recent?: DeliveryRecord[];
}

const RECENT_LIMIT = 20;

export function deliveriesFile(dir: string = dataDir()): string {
  return path.join(dir, "channel-deliveries.json");
}

export function readDeliveries(dir: string = dataDir()): Record<string, ChannelDeliveryState> {
  try {
    const raw = JSON.parse(fs.readFileSync(deliveriesFile(dir), "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, ChannelDeliveryState>) : {};
  } catch {
    return {};
  }
}

export function readChannelDeliveries(channel: string, dir: string = dataDir()): ChannelDeliveryState {
  return readDeliveries(dir)[channel] ?? {};
}

/** Write down one inbound POST. Best-effort: a read-only disk must never turn a
 *  delivery we could otherwise handle into a failed one. */
export function recordDelivery(
  channel: string,
  outcome: DeliveryOutcome,
  detail?: string,
  opts: { via?: DeliveryVia; dir?: string } = {},
): void {
  const dir = opts.dir ?? dataDir();
  const via: DeliveryVia = opts.via ?? "push";
  try {
    const all = readDeliveries(dir);
    const prev = all[channel] ?? {};
    const rec: DeliveryRecord = {
      at: new Date().toISOString(),
      outcome,
      ...(detail ? { detail: detail.split("\n")[0].slice(0, 300) } : {}),
      via,
    };
    all[channel] = {
      ...prev,
      last: rec,
      lastPush: via === "push" ? rec : prev.lastPush,
      // A refusal is something WE did to something THEY sent. A poll that could not
      // reach the platform is the opposite situation and must never land here.
      lastRejected: via === "push" && outcome === "rejected" ? rec : prev.lastRejected,
      lastAccepted: outcome === "captured" || outcome === "replied" ? rec : prev.lastAccepted,
      counts: { ...(prev.counts ?? {}), [outcome]: ((prev.counts ?? {})[outcome] ?? 0) + 1 },
      recent: [rec, ...(prev.recent ?? [])].slice(0, RECENT_LIMIT),
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(deliveriesFile(dir), JSON.stringify(all, null, 2));
  } catch {
    /* best-effort ledger */
  }
}

/** The most recent inbound WEBHOOK row. Falls back to scanning the recent tail so a
 *  ledger written before `via` existed still reads right: every row in one of those
 *  was an inbound POST. */
export function lastPushDelivery(state: ChannelDeliveryState): DeliveryRecord | undefined {
  if (state.lastPush) return state.lastPush;
  const fromTail = (state.recent ?? []).find((r) => (r.via ?? "push") === "push");
  if (fromTail) return fromTail;
  return state.last && (state.last.via ?? "push") === "push" ? state.last : undefined;
}

/**
 * One line a human can act on. This is the whole point of the ledger: it names
 * WHICH of the three silent failures you have, and what to do about it.
 */
export function deliveryVerdict(
  state: ChannelDeliveryState,
  opts: { configured: boolean; label: string; webhookUrl?: string; pullOnly?: boolean },
): { tone: "ok" | "warn" | "error"; text: string } {
  const { configured, label } = opts;
  // A channel with NO webhook (email) has no bot token and no subscription to
  // check, so "only arriving by poll" is its healthy state, not a warning. Only a
  // failed POLL is news — a stray POST at its (non-existent) webhook is not.
  const pollFailed = state.last?.outcome === "rejected" && (state.last.via ?? "push") === "pull";
  if (opts.pullOnly && !configured) return { tone: "warn", text: `${label} is not set up yet — nothing can be sent.` };
  if (opts.pullOnly && !pollFailed) {
    return {
      tone: "ok",
      text: state.last ? `Last poll of ${label}: ${state.last.outcome}.` : `No ${label} reply captured yet — replies are collected by polling.`,
    };
  }
  if (!configured) {
    return { tone: "warn", text: `${label} has no bot token yet — nothing can arrive.` };
  }
  if (!state.last) {
    return {
      tone: "warn",
      text:
        `No message has ever reached this app from ${label}. The bot token is saved, so the gap is on the ` +
        `platform side: check the app's Event Subscriptions / webhook URL points here and is enabled.`,
    };
  }
  // The adapter's reason is already a sentence; don't punctuate it twice.
  const why = (rec: DeliveryRecord) => (rec.detail ?? rec.outcome).replace(/[.\s]+$/, "");
  const push = lastPushDelivery(state);

  // A refused PUSH is the classic silent killer: the platform is still calling and
  // we are refusing every call. It outranks everything, including a poll that is
  // quietly making up the difference — that poll is why nobody notices.
  if (push?.outcome === "rejected" && !opts.pullOnly) {
    return {
      tone: "error",
      text: `${label} delivered a message and this app REFUSED it — ${why(push)}. Nothing will be captured until that is fixed.`,
    };
  }
  // A failed POLL is OUR side of the wire. Saying the platform delivered something
  // we refused would be a straight lie, and it sent this exact record's owner
  // hunting a signing-secret bug that did not exist.
  if (state.last.outcome === "rejected" && (state.last.via ?? "push") === "pull") {
    return {
      tone: "error",
      text: `This app could not reach ${label} on its last poll — ${why(state.last)}. Nothing new is being captured until the poll succeeds.`,
    };
  }
  if (state.last.outcome === "rejected") {
    return {
      tone: "error",
      text: `${label} delivered a message and this app REFUSED it — ${why(state.last)}. Nothing will be captured until that is fixed.`,
    };
  }
  // Messages ARE arriving, but only because we go and fetch them. The webhook has
  // never fired once, which reads as healthy from every other angle.
  if (!push) {
    return {
      tone: "warn",
      text:
        `${label} messages are only arriving because this app POLLS for them — the webhook has never delivered one. ` +
        `Check the app's Event Subscriptions Request URL points here and is enabled.`,
    };
  }
  return { tone: "ok", text: `Last delivery from ${label}: ${state.last.outcome} (${state.last.via ?? "push"}).` };
}

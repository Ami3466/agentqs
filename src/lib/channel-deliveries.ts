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

export interface DeliveryRecord {
  at: string; // ISO time the POST reached us
  outcome: DeliveryOutcome;
  detail?: string; // why it was rejected / what was ignored
}

export interface ChannelDeliveryState {
  /** Most recent POST of ANY outcome — proves the platform is still calling us. */
  last?: DeliveryRecord;
  /** Most recent one we refused — the thing that silently kills a bot. */
  lastRejected?: DeliveryRecord;
  /** Most recent one that actually landed in the record. */
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
  dir: string = dataDir(),
): void {
  try {
    const all = readDeliveries(dir);
    const prev = all[channel] ?? {};
    const rec: DeliveryRecord = {
      at: new Date().toISOString(),
      outcome,
      ...(detail ? { detail: detail.split("\n")[0].slice(0, 300) } : {}),
    };
    all[channel] = {
      ...prev,
      last: rec,
      lastRejected: outcome === "rejected" ? rec : prev.lastRejected,
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

/**
 * One line a human can act on. This is the whole point of the ledger: it names
 * WHICH of the three silent failures you have, and what to do about it.
 */
export function deliveryVerdict(
  state: ChannelDeliveryState,
  opts: { configured: boolean; label: string; webhookUrl?: string },
): { tone: "ok" | "warn" | "error"; text: string } {
  const { configured, label } = opts;
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
  // A rejection AFTER the last accepted delivery is the classic silent killer:
  // the platform is still calling, we are refusing every call.
  const rejectedLast = state.last.outcome === "rejected";
  if (rejectedLast) {
    // The adapter's reason is already a sentence; don't punctuate it twice.
    const why = (state.last.detail ?? "rejected").replace(/[.\s]+$/, "");
    return {
      tone: "error",
      text: `${label} delivered a message and this app REFUSED it — ${why}. Nothing will be captured until that is fixed.`,
    };
  }
  return { tone: "ok", text: `Last delivery from ${label}: ${state.last.outcome}.` };
}

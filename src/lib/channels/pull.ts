import { appendInboxItems, landInboxCaptures } from "../record";
import { recordDir } from "../paths";
import { readBackfillState, writeBackfillState } from "../sync-runs";
import { recordDelivery } from "../channel-deliveries";
import { channelEnv, getChannelAdapter } from "./registry";

/**
 * PULL a channel's history into the record, on our own schedule.
 *
 * Why this exists, plainly: the Slack capture for this record was never running in
 * this app at all. It was a GitHub Actions cron in a different repo, polling
 * `#daily-log` every three hours and committing to a JSON file — so it stopped the
 * moment that account's Actions minutes ran out, and it reported SUCCESS the whole
 * time it was capturing nothing (the script exits 0 with "no new messages", and the
 * commit step is `git diff --quiet || git commit`, so a dead job and a healthy one
 * produce identical green checks).
 *
 * Two rules follow from that, and they are the whole design:
 *
 *   1. IT RUNS WHERE THE DATA LIVES. This is an ordinary due-source, swept by the
 *      in-process scheduler on the same host as the record. No external minutes to
 *      exhaust, no second repo, nothing to keep in sync with a deploy.
 *   2. A PULL THAT CAPTURES NOTHING IS NOT A SUCCESS. Every sweep records what it
 *      actually landed, and the cursor only moves over messages that reached the
 *      record — so a silent stall is visible on the Pipeline row instead of being
 *      indistinguishable from a quiet day.
 *
 * It complements the webhook rather than replacing it: push is instant, pull is what
 * still works after the platform stops calling, and the shared `eventId` dedupe
 * means a message that arrives both ways lands exactly once.
 */

export interface PullSummary {
  channel: string;
  /** The conversation polled (as configured). */
  from: string;
  /** New messages that reached the record this sweep. */
  captured: number;
  /** Fetched but already held (arrived via the webhook, or an overlapping window). */
  duplicates: number;
  cursor: string;
}

/** Where each channel's pull cursor lives — the same ledger source backfills use,
 *  so "how far has this got?" has one answer in one file. */
function cursorKey(channelId: string): string {
  return `channel-pull:${channelId}`;
}

export function pullCursor(channelId: string): string {
  return readBackfillState(cursorKey(channelId)).cursor ?? "";
}

/**
 * Run one pull for a channel. Throws with a human cause (bot not in the channel,
 * missing scope, no conversation configured) so the failure lands on the row rather
 * than in a log nobody reads.
 */
export async function pullChannel(
  channelId: string,
  opts: { recordDir?: string; dataDir?: string } = {},
): Promise<PullSummary> {
  const adapter = getChannelAdapter(channelId);
  if (!adapter) throw new Error(`Unknown channel "${channelId}".`);
  if (!adapter.pull) throw new Error(`${adapter.label} has no history API to pull from.`);

  const env = channelEnv();
  if (!adapter.configured(env)) {
    throw new Error(`${adapter.label} is not connected — save its bot token in Settings → Channels.`);
  }
  const from = pullChannelName(channelId, env);
  if (!from) {
    throw new Error(
      `No ${adapter.label} conversation to pull. Set one in Settings → Channels (e.g. "daily-log") — ` +
        "until then the bot only captures what is pushed to its webhook.",
    );
  }

  const since = pullCursor(channelId);
  const { messages, cursor } = await adapter.pull({ env, channel: from, since });

  const rDir = opts.recordDir ?? recordDir(opts.dataDir);
  // The SAME inbox append the webhook uses, keyed by the platform's own message id,
  // so a message that arrived both ways is stored once. appendInboxItems skips ids
  // it already holds and tells us how many it actually added.
  const { items, added } = appendInboxItems(
    messages.map((m) => ({ id: m.eventId, text: m.text, source: adapter.id, kind: "text" as const })),
    { recordDir: rDir },
  );
  if (items.length) landInboxCaptures(items, opts);

  if (added > 0) recordDelivery(adapter.id, "captured", `pulled ${added} from #${from}`);

  // Only now — the messages are on disk — is it safe to move on. A pull that threw
  // above never gets here, so the next sweep re-reads the same window.
  writeBackfillState(cursorKey(channelId), { cursor, at: new Date().toISOString() });

  return { channel: adapter.id, from, captured: added, duplicates: messages.length - added, cursor };
}

/** The conversation configured for this channel's pull, if any. */
export function pullChannelName(channelId: string, env = channelEnv()): string {
  return channelId === "slack" ? (env.slackPullChannel ?? "").trim() : "";
}

/** Is this channel set up to be pulled on a schedule? */
export function pullable(channelId: string, env = channelEnv()): boolean {
  const adapter = getChannelAdapter(channelId);
  return Boolean(adapter?.pull && adapter.configured(env) && pullChannelName(channelId, env));
}

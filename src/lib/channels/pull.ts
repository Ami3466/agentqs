import { appendInboxItems, landInboxCaptures } from "../record";
import { recordDir } from "../paths";
import { readBackfillState, writeBackfillState } from "../sync-runs";
import { recordDelivery } from "../channel-deliveries";
import { channelEnv, getChannelAdapter } from "./registry";
import type { ChannelEnv } from "./types";

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
  /** How many conversations were actually read this sweep. */
  conversations: number;
  /** Conversations that errored, with why — never silently dropped. */
  failed: string[];
}

/** Where each conversation's pull cursor lives — the same ledger source backfills
 *  use, so "how far has this got?" has one answer in one file. PER CONVERSATION:
 *  one shared cursor across several would let the busiest one drag the others past
 *  messages nobody had read yet. */
function cursorKey(channelId: string, conversation = ""): string {
  return conversation ? `channel-pull:${channelId}:${conversation}` : `channel-pull:${channelId}`;
}

export function pullCursor(channelId: string, conversation = ""): string {
  return readBackfillState(cursorKey(channelId, conversation)).cursor ?? "";
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
  const targets = await resolveTargets(adapter, env);
  if (!targets.length) {
    throw new Error(
      `No ${adapter.label} conversation to pull. Set one in Settings → Channels — a channel name ` +
        `("daily-log"), a comma-separated list, or "*" for every conversation the bot is in.`,
    );
  }

  const rDir = opts.recordDir ?? recordDir(opts.dataDir);
  const messages: Awaited<ReturnType<NonNullable<typeof adapter.pull>>>["messages"] = [];
  const cursors: Array<[string, string]> = [];
  const failed: string[] = [];
  // Each conversation is pulled and cursored independently: one that errors (the bot
  // was removed, a scope is missing) must not stop the others or lose their place.
  for (const t of targets) {
    try {
      const r = await adapter.pull!({ env, channel: t, since: pullCursor(channelId, t) });
      messages.push(...r.messages);
      cursors.push([t, r.cursor]);
    } catch (e) {
      failed.push(`${t}: ${(e as Error).message}`);
    }
  }
  if (!cursors.length && failed.length) throw new Error(failed.join(" | "));
  const from = targets.join(", ");
  // The SAME inbox append the webhook uses, keyed by the platform's own message id,
  // so a message that arrived both ways is stored once. appendInboxItems skips ids
  // it already holds and tells us how many it actually added.
  const { items, added } = appendInboxItems(
    messages.map((m) => ({
      id: m.eventId,
      text: m.text,
      source: adapter.id,
      kind: "text" as const,
      // Dated when it was SENT, not when we happened to collect it.
      ...(m.at ? { ts: m.at } : {}),
    })),
    { recordDir: rDir },
  );
  if (items.length) landInboxCaptures(items, opts);

  if (added > 0) recordDelivery(adapter.id, "captured", `pulled ${added} from ${from}`);
  else if (failed.length) recordDelivery(adapter.id, "rejected", failed[0]);

  // Only now — the messages are on disk — is it safe to move on. A conversation that
  // threw never reaches here, so the next sweep re-reads its window.
  const at = new Date().toISOString();
  for (const [t, cursor] of cursors) writeBackfillState(cursorKey(channelId, t), { cursor, at });

  return {
    channel: adapter.id,
    from,
    captured: added,
    duplicates: messages.length - added,
    conversations: cursors.length,
    failed,
  };
}

/** The conversation setting as typed: a name, a comma-separated list, or "*". */
export function pullChannelName(channelId: string, env = channelEnv()): string {
  return channelId === "slack" ? (env.slackPullChannel ?? "").trim() : "";
}

/**
 * Turn that setting into the conversations to read.
 *
 * "*" means EVERY conversation the bot is a member of. That exists because naming
 * one channel is a guess: a week of daily logs went missing here, and the reason was
 * simply that they had been written somewhere other than the channel the poll was
 * pointed at. The bot can only ever read where it has been invited, so "capture
 * everything I can see" is both the honest default for a personal log and the thing
 * that makes a missing week impossible to explain away.
 */
async function resolveTargets(
  adapter: { id: string; conversations?: (env: ChannelEnv) => Promise<Array<{ id: string; member: boolean }>> },
  env: ChannelEnv,
): Promise<string[]> {
  const raw = pullChannelName(adapter.id, env);
  if (!raw) return [];
  if (raw !== "*") {
    return raw.split(",").map((p) => p.trim().replace(/^#/, "")).filter(Boolean);
  }
  if (!adapter.conversations) return [];
  const all = await adapter.conversations(env);
  return all.filter((c) => c.member).map((c) => c.id);
}

/** Is this channel set up to be pulled on a schedule? */
export function pullable(channelId: string, env = channelEnv()): boolean {
  const adapter = getChannelAdapter(channelId);
  return Boolean(adapter?.pull && adapter.configured(env) && pullChannelName(channelId, env));
}

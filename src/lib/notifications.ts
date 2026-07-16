import { readConfig, recordTimeZone, writeConfig, type Notification } from "./config";
import { channelEnv, getChannelAdapter } from "./channels/registry";
import { localDay } from "./importers/plugin";

/**
 * Scheduled outbound notifications — a daily message the app sends YOU on a channel
 * (Slack/Telegram) at a local time, the classic case being an 8pm "how was your
 * day?". Data going OUT, so it touches no daily rows; your reply rides the normal
 * inbound channel path into your record. The Settings panel and the /api route are
 * thin faces over this; the in-process scheduler calls `sweepNotifications`.
 */

export interface NotificationInput {
  id?: string;
  channel: string;
  target: string;
  text: string;
  atLocal: string;
  enabled?: boolean;
}

/** Minutes since local midnight for `at` in `tz` (0–1439), or NaN on a bad tz. */
function localMinutes(at: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    return Number.isNaN(h) || Number.isNaN(m) ? NaN : h * 60 + m;
  } catch {
    return NaN;
  }
}

/** "HH:MM" → minutes since midnight, or null if malformed / out of range. */
function parseAtLocal(atLocal: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(atLocal || "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function normalizeAtLocal(atLocal: string): string {
  const total = parseAtLocal(atLocal);
  if (total === null) throw new Error(`Invalid time "${atLocal}" — use 24h HH:MM, e.g. 20:00.`);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function readAll(): Notification[] {
  const list = readConfig()?.notifications;
  return Array.isArray(list) ? list : [];
}

export function listNotifications(): Notification[] {
  return readAll().slice();
}

/** Create or update a notification. */
export function upsertNotification(input: NotificationInput): Notification {
  const cfg = readConfig();
  if (!cfg) throw new Error("Run setup first.");
  const channel = (input.channel || "").trim().toLowerCase();
  if (!getChannelAdapter(channel)) throw new Error(`Unknown channel "${input.channel}". Known: slack, telegram.`);
  const target = (input.target || "").trim();
  if (!target) throw new Error("Missing target (the Slack channel/DM id or Telegram chat id).");
  const text = (input.text || "").trim();
  if (!text) throw new Error("Missing message text.");
  const atLocal = normalizeAtLocal(input.atLocal);
  const id = slugify(input.id || `${channel}-${atLocal.replace(":", "")}`);
  if (!id) throw new Error("Could not derive an id.");

  const all = readAll();
  const existing = all.find((n) => n.id === id);
  const next: Notification = {
    id,
    channel,
    target,
    text,
    atLocal,
    enabled: input.enabled ?? existing?.enabled ?? true,
    // Re-arm today if the destination or time changed.
    lastSentDay:
      existing && existing.channel === channel && existing.target === target && existing.atLocal === atLocal
        ? existing.lastSentDay
        : undefined,
    lastError: existing?.lastError ?? null,
  };
  writeConfig({ ...cfg, notifications: [...all.filter((n) => n.id !== id), next] });
  return next;
}

export function removeNotification(id: string): { id: string; removed: boolean } {
  const cfg = readConfig();
  if (!cfg) throw new Error("Run setup first.");
  const all = readAll();
  const kept = all.filter((n) => n.id !== id);
  if (kept.length === all.length) return { id, removed: false };
  writeConfig({ ...cfg, notifications: kept });
  return { id, removed: true };
}

/** Persist one notification's send outcome (re-reading so a concurrent edit isn't
 *  clobbered). */
function stamp(id: string, patch: Partial<Notification>): void {
  const cfg = readConfig();
  if (!cfg) return;
  const all = readAll();
  const idx = all.findIndex((n) => n.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch };
  writeConfig({ ...cfg, notifications: all });
}

/** Send one notification's message via its channel now. `stampDay` records it as
 *  `now`'s day (the scheduled path); a manual test sends without consuming the day. */
async function send(n: Notification, now: Date, stampDay: boolean): Promise<void> {
  const adapter = getChannelAdapter(n.channel);
  if (!adapter) throw new Error(`Unknown channel "${n.channel}".`);
  const env = channelEnv();
  if (!adapter.configured(env)) {
    const why = adapter.describe(env).reason || `${adapter.label} is not configured.`;
    stamp(n.id, { lastError: why });
    throw new Error(why);
  }
  try {
    await adapter.send(env, n.target, n.text);
  } catch (e) {
    stamp(n.id, { lastError: (e as Error).message });
    throw e;
  }
  stamp(n.id, { lastError: null, ...(stampDay ? { lastSentDay: localDay(now) } : {}) });
}

/** Send a specific notification right now (the panel's "Send now" / test), ignoring
 *  the schedule and NOT consuming today's slot. */
export async function testNotification(id: string): Promise<Notification> {
  const n = readAll().find((x) => x.id === id);
  if (!n) throw new Error(`No notification "${id}".`);
  await send(n, new Date(), false);
  return readAll().find((x) => x.id === id) ?? n;
}

/** The scheduler's per-sweep entry point: send every due notification. Never throws —
 *  one bad send is recorded on its row and the rest still run. */
export async function sweepNotifications(now: Date = new Date()): Promise<{ sent: string[]; failed: string[] }> {
  const tz = recordTimeZone();
  const today = localDay(now, tz);
  const nowMin = localMinutes(now, tz);
  const sent: string[] = [];
  const failed: string[] = [];
  for (const n of listNotifications()) {
    if (n.enabled === false) continue;
    const at = parseAtLocal(n.atLocal);
    if (at === null || Number.isNaN(nowMin) || nowMin < at || n.lastSentDay === today) continue;
    try {
      await send(n, now, true);
      sent.push(n.id);
    } catch {
      failed.push(n.id); // the error is already recorded on the row
    }
  }
  return { sent, failed };
}

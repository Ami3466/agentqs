import { readConfig, recordTimeZone, writeConfig, type AppConfig, type Nudge } from "./config";
import { channelEnv, getChannelAdapter } from "./channels/registry";
import { localDay } from "./importers/plugin";
import { slugifyId } from "./automation-types";

/**
 * Daily nudges — the OUTBOUND side of a channel. A nudge is one scheduled message
 * the app sends TO you (Slack/Telegram) at a local wall-clock time; the classic
 * case is an 8pm "how was your day?" whose reply rides the normal inbound path and
 * lands in your record. This is the one brain: the CLI, MCP tool, API route and
 * Settings panel are thin faces, and the in-process scheduler calls `sweepNudges`.
 *
 * A nudge is data going OUT (like a backup), so it does NOT touch the daily record
 * and leaves no undo/inbox item — its whole state is the config row it lives in
 * (last send day/time, last error). The once-per-day guard is `lastSentDay` in the
 * record timezone, so a server that was down at 8pm still fires when it wakes at 9.
 */

export interface NudgeInput {
  id?: string;
  channel: string;
  target: string;
  text: string;
  atLocal: string;
  enabled?: boolean;
}

export interface NudgeSweepResult {
  sent: string[]; // ids sent this sweep
  failed: { id: string; error: string }[];
  skipped: number; // due-but-not-yet + not-enabled + not-yet-time
}

/** Minutes since local midnight for `instant` in `tz` (0–1439), or NaN on a bad tz. */
export function localMinutes(instant: Date, tz: string = recordTimeZone()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
    return h * 60 + m;
  } catch {
    return NaN;
  }
}

/** Parse "HH:MM" → minutes since midnight, or null if malformed / out of range. */
export function parseAtLocal(atLocal: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(atLocal || "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Normalise to a zero-padded "HH:MM" (validated). Throws on a bad time. */
function normalizeAtLocal(atLocal: string): string {
  const total = parseAtLocal(atLocal);
  if (total === null) throw new Error(`Invalid time "${atLocal}" — use 24h HH:MM, e.g. 20:00.`);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Is this nudge due to send at `now`? Enabled, its local time has passed today,
 *  and it hasn't already sent today (in the record timezone). */
export function nudgeDue(n: Nudge, now: Date, tz: string = recordTimeZone()): boolean {
  if (n.enabled === false) return false;
  const at = parseAtLocal(n.atLocal);
  if (at === null) return false;
  const nowMin = localMinutes(now, tz);
  if (Number.isNaN(nowMin) || nowMin < at) return false;
  return n.lastSentDay !== localDay(now, tz);
}

function readNudges(cfg: AppConfig | null = readConfig()): Nudge[] {
  return Array.isArray(cfg?.nudges) ? cfg!.nudges : [];
}

/** Every configured nudge, newest schedule state included. */
export function listNudges(): Nudge[] {
  return readNudges().slice();
}

/** Create or update a nudge (by id, or a slug of a channel+time when unset). */
export function upsertNudge(input: NudgeInput): Nudge {
  const cfg = readConfig();
  if (!cfg) throw new Error("Run setup first.");
  const channel = (input.channel || "").trim().toLowerCase();
  if (!getChannelAdapter(channel)) {
    throw new Error(`Unknown channel "${input.channel}". Known: slack, telegram.`);
  }
  const target = (input.target || "").trim();
  if (!target) throw new Error("Missing target (the Slack channel/DM id or Telegram chat id).");
  const text = (input.text || "").trim();
  if (!text) throw new Error("Missing message text.");
  const atLocal = normalizeAtLocal(input.atLocal);
  const id = slugifyId(input.id || `${channel}-${atLocal.replace(":", "")}`);
  if (!id) throw new Error("Could not derive an id — pass an explicit --id.");

  const nudges = readNudges(cfg);
  const existing = nudges.find((n) => n.id === id);
  const next: Nudge = {
    id,
    channel,
    target,
    text,
    atLocal,
    enabled: input.enabled ?? existing?.enabled ?? true,
    // Preserve schedule state on edit; a channel/time change re-arms today.
    lastSentDay:
      existing && existing.channel === channel && existing.target === target && existing.atLocal === atLocal
        ? existing.lastSentDay
        : undefined,
    lastSentAt: existing?.lastSentAt,
    lastError: existing?.lastError ?? null,
  };
  const others = nudges.filter((n) => n.id !== id);
  writeConfig({ ...cfg, nudges: [...others, next] });
  return next;
}

/** Remove a nudge. Returns whether one was actually there. */
export function removeNudge(id: string): { id: string; removed: boolean } {
  const cfg = readConfig();
  if (!cfg) throw new Error("Run setup first.");
  const nudges = readNudges(cfg);
  const kept = nudges.filter((n) => n.id !== id);
  if (kept.length === nudges.length) return { id, removed: false };
  writeConfig({ ...cfg, nudges: kept });
  return { id, removed: true };
}

/** Persist one nudge's send outcome back into config (re-reading so a concurrent
 *  edit elsewhere isn't clobbered). */
function stampNudge(id: string, patch: Partial<Nudge>): void {
  const cfg = readConfig();
  if (!cfg) return;
  const nudges = readNudges(cfg);
  const idx = nudges.findIndex((n) => n.id === id);
  if (idx < 0) return;
  nudges[idx] = { ...nudges[idx], ...patch };
  writeConfig({ ...cfg, nudges });
}

/** Send one nudge's message now via its channel adapter. `stamp` records the send
 *  as `now`'s day (the scheduled path — so the once-per-day guard matches the same
 *  clock the due-check used); a manual test sends without consuming the day. */
export async function sendNudge(n: Nudge, opts: { stamp?: boolean; now?: Date } = {}): Promise<void> {
  const adapter = getChannelAdapter(n.channel);
  if (!adapter) throw new Error(`Unknown channel "${n.channel}".`);
  const env = channelEnv();
  if (!adapter.configured(env)) {
    const why = adapter.describe(env).reason || `${adapter.label} is not configured.`;
    stampNudge(n.id, { lastError: why });
    throw new Error(why);
  }
  try {
    await adapter.send(env, n.target, n.text);
  } catch (e) {
    const msg = (e as Error).message;
    stampNudge(n.id, { lastError: msg });
    throw e;
  }
  const now = opts.now ?? new Date();
  stampNudge(n.id, {
    lastError: null,
    lastSentAt: now.toISOString(),
    ...(opts.stamp ? { lastSentDay: localDay(now) } : {}),
  });
}

/** Send a specific nudge right now (Settings "Send test" / `nudge test`), ignoring
 *  the schedule and NOT consuming today's slot. */
export async function testNudge(id: string): Promise<Nudge> {
  const n = readNudges().find((x) => x.id === id);
  if (!n) throw new Error(`No nudge "${id}".`);
  await sendNudge(n, { stamp: false });
  return readNudges().find((x) => x.id === id) ?? n;
}

/** The scheduler's per-sweep entry point: send every due nudge, stamping each. Never
 *  throws — one bad nudge (or channel outage) is recorded on its row and the rest
 *  still run. */
export async function sweepNudges(now: Date = new Date()): Promise<NudgeSweepResult> {
  const tz = recordTimeZone();
  const result: NudgeSweepResult = { sent: [], failed: [], skipped: 0 };
  for (const n of listNudges()) {
    if (!nudgeDue(n, now, tz)) {
      result.skipped++;
      continue;
    }
    try {
      await sendNudge(n, { stamp: true, now });
      result.sent.push(n.id);
    } catch (e) {
      result.failed.push({ id: n.id, error: (e as Error).message });
    }
  }
  return result;
}

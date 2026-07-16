import {
  readConfig,
  recordTimeZone,
  writeConfig,
  type Rule,
  type RuleAction,
  type RuleTrigger,
} from "./config";
import fs from "fs";
import { channelEnv, getChannelAdapter } from "./channels/registry";
import { localDay } from "./importers/plugin";
import { localMinutes, parseAtLocal } from "./notifications";
import { openReadonly } from "./db";
import { dbPath } from "./paths";
import { prepareSql } from "./query-async";

/**
 * Agent rules — "when X, message me". The generalization of a Notification:
 *
 *   when = time      → a clock time in the record timezone (the daily-brief case)
 *   when = threshold → a plain numeric compare against your record (resting_hr > 55).
 *                      NO AI — just an `if` over a daily value.
 *   then = text      → send a fixed line
 *   then = brief     → hand a prompt to the grounded agent and send its reply (the
 *                      only path that spends a token)
 *
 * Data goes OUT, so this touches no daily rows; a reply you send back rides the
 * normal inbound channel path into your record. The Settings panel and /api/rules
 * are thin faces; the in-process scheduler calls `sweepRules` every sweep.
 */

export interface RuleInput {
  id?: string;
  channel: string;
  target: string;
  when: RuleTrigger;
  then: RuleAction;
  enabled?: boolean;
}

const OPS = new Set([">", ">=", "<", "<="]);

function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function readAll(): Rule[] {
  const list = readConfig()?.rules;
  return Array.isArray(list) ? list : [];
}

export function listRules(): Rule[] {
  return readAll().slice();
}

/** A short human line for a rule ("resting_hr > 55 → Slack", "20:00 → brief"). */
export function describeRule(r: Rule): string {
  const when =
    r.when.kind === "time"
      ? r.when.atLocal
      : `${r.when.source}.${r.when.metric} ${r.when.op} ${r.when.value}`;
  const then = r.then.kind === "text" ? `“${r.then.text}”` : "AI brief";
  return `${when} → ${then} · ${r.channel}→${r.target}`;
}

function normalizeTrigger(when: RuleTrigger): RuleTrigger {
  if (!when || typeof when !== "object") throw new Error("Missing trigger.");
  if (when.kind === "time") {
    const total = parseAtLocal(when.atLocal);
    if (total === null) throw new Error(`Invalid time "${when.atLocal}" — use 24h HH:MM, e.g. 20:00.`);
    const atLocal = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    return { kind: "time", atLocal };
  }
  if (when.kind === "threshold") {
    const source = (when.source || "").trim();
    const metric = (when.metric || "").trim();
    if (!source || !metric) throw new Error("Threshold needs a source and metric.");
    if (!OPS.has(when.op)) throw new Error(`Bad operator "${when.op}" — use >, >=, <, <=.`);
    const value = Number(when.value);
    if (!Number.isFinite(value)) throw new Error("Threshold value must be a number.");
    return { kind: "threshold", source, metric, op: when.op, value };
  }
  throw new Error(`Unknown trigger kind "${(when as { kind?: string }).kind}".`);
}

function normalizeAction(then: RuleAction): RuleAction {
  if (!then || typeof then !== "object") throw new Error("Missing action.");
  if (then.kind === "text") {
    const text = (then.text || "").trim();
    if (!text) throw new Error("A text action needs a message.");
    return { kind: "text", text };
  }
  if (then.kind === "brief") {
    const prompt = (then.prompt || "").trim();
    if (!prompt) throw new Error("A brief action needs a prompt for the agent.");
    return { kind: "brief", prompt };
  }
  throw new Error(`Unknown action kind "${(then as { kind?: string }).kind}".`);
}

function deriveId(channel: string, when: RuleTrigger, then: RuleAction): string {
  const w =
    when.kind === "time" ? `at-${when.atLocal.replace(":", "")}` : `${when.source}-${when.metric}-${when.op}${when.value}`;
  return slugify(`${channel}-${w}-${then.kind}`);
}

/** Create or update a rule. */
export function upsertRule(input: RuleInput): Rule {
  const cfg = readConfig();
  if (!cfg) throw new Error("Run setup first.");
  const channel = (input.channel || "").trim().toLowerCase();
  if (!getChannelAdapter(channel)) throw new Error(`Unknown channel "${input.channel}". Known: slack, telegram.`);
  const target = (input.target || "").trim();
  if (!target) throw new Error("Missing target (the Slack channel/DM id or Telegram chat id).");
  const when = normalizeTrigger(input.when);
  const then = normalizeAction(input.then);
  const id = slugify(input.id || "") || deriveId(channel, when, then);
  if (!id) throw new Error("Could not derive an id.");

  const all = readAll();
  const existing = all.find((r) => r.id === id);
  // Re-arm / clear the day if anything that changes WHEN the rule fires changed.
  const sameTrigger = existing && JSON.stringify(existing.when) === JSON.stringify(when) && existing.channel === channel && existing.target === target;
  const next: Rule = {
    id,
    channel,
    target,
    when,
    then,
    enabled: input.enabled ?? existing?.enabled ?? true,
    lastFiredDay: sameTrigger ? existing?.lastFiredDay : undefined,
    lastError: existing?.lastError ?? null,
    armed: sameTrigger ? existing?.armed : true,
  };
  writeConfig({ ...cfg, rules: [...all.filter((r) => r.id !== id), next] });
  return next;
}

export function removeRule(id: string): { id: string; removed: boolean } {
  const cfg = readConfig();
  if (!cfg) throw new Error("Run setup first.");
  const all = readAll();
  const kept = all.filter((r) => r.id !== id);
  if (kept.length === all.length) return { id, removed: false };
  writeConfig({ ...cfg, rules: kept });
  return { id, removed: true };
}

/** Persist one rule's state, re-reading so a concurrent edit isn't clobbered. */
function stamp(id: string, patch: Partial<Rule>): void {
  const cfg = readConfig();
  if (!cfg) return;
  const all = readAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch };
  writeConfig({ ...cfg, rules: all });
}

/** Escape a string literal for the read-only query path (doubles single quotes). */
function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** One scalar read over the rebuilt daily cache — the same read-only path `query`
 *  uses, kept local so this module never imports the heavy cli-core. */
function readScalar(sql: string): unknown {
  const file = dbPath();
  if (!fs.existsSync(file)) return undefined;
  const { sql: capped } = prepareSql(sql, 1);
  const db = openReadonly(file);
  try {
    const row = db.prepare(capped).get() as Record<string, unknown> | undefined;
    return row ? Object.values(row)[0] : undefined;
  } finally {
    db.close();
  }
}

export interface ThresholdEval {
  value: number | null; // today's numeric value, or null if no row yet
  met: boolean; // does the value cross the threshold now?
}

/** Read today's value for a threshold and test the comparison. No AI, no writes. */
export function evalThreshold(when: Extract<RuleTrigger, { kind: "threshold" }>, now: Date = new Date()): ThresholdEval {
  const today = localDay(now, recordTimeZone());
  const sql =
    `SELECT value_num AS v FROM daily WHERE source = ${sqlStr(when.source)} AND metric = ${sqlStr(when.metric)} ` +
    `AND date = ${sqlStr(today)} AND value_num IS NOT NULL ORDER BY date DESC LIMIT 1`;
  let value: number | null = null;
  try {
    const raw = readScalar(sql);
    value = typeof raw === "number" ? raw : raw == null ? null : Number(raw);
    if (value !== null && !Number.isFinite(value)) value = null;
  } catch {
    value = null; // no cache yet / bad metric — treat as "no data", never fire
  }
  if (value === null) return { value: null, met: false };
  const met =
    when.op === ">" ? value > when.value
      : when.op === ">=" ? value >= when.value
      : when.op === "<" ? value < when.value
      : value <= when.value;
  return { value, met };
}

/** Build the message body for a rule's action, spending a token only for `brief`. */
async function renderAction(then: RuleAction): Promise<string> {
  if (then.kind === "text") return then.text;
  const { composeReply } = await import("./reply");
  const reply = await composeReply({ message: then.prompt, channel: "cli", ai: true });
  const text = (reply.text || "").trim();
  if (!text) throw new Error("The agent returned an empty brief.");
  return text;
}

/** Send a rule's message now. `commit` records the send against today (the scheduled
 *  path); a manual test sends without consuming today's slot or touching arm state. */
async function fire(r: Rule, now: Date, commit: boolean): Promise<void> {
  const adapter = getChannelAdapter(r.channel);
  if (!adapter) throw new Error(`Unknown channel "${r.channel}".`);
  const env = channelEnv();
  if (!adapter.configured(env)) {
    const why = adapter.describe(env).reason || `${adapter.label} is not configured.`;
    if (commit) stamp(r.id, { lastError: why });
    throw new Error(why);
  }
  let body: string;
  try {
    body = await renderAction(r.then);
    await adapter.send(env, r.target, body);
  } catch (e) {
    if (commit) stamp(r.id, { lastError: (e as Error).message });
    throw e;
  }
  if (commit) stamp(r.id, { lastError: null, lastFiredDay: localDay(now, recordTimeZone()) });
}

/** Send a specific rule right now (the panel's "Test"), ignoring the trigger and NOT
 *  consuming today's slot or arm state. */
export async function testRule(id: string): Promise<Rule> {
  const r = readAll().find((x) => x.id === id);
  if (!r) throw new Error(`No rule "${id}".`);
  await fire(r, new Date(), false);
  return readAll().find((x) => x.id === id) ?? r;
}

/** The scheduler's per-sweep entry point. Evaluates every enabled rule and fires the
 *  due ones. Never throws — one bad send/eval is recorded on its row, the rest run. */
export async function sweepRules(now: Date = new Date()): Promise<{ fired: string[]; failed: string[] }> {
  const tz = recordTimeZone();
  const today = localDay(now, tz);
  const nowMin = localMinutes(now, tz);
  const fired: string[] = [];
  const failed: string[] = [];

  for (const r of listRules()) {
    if (r.enabled === false) continue;

    if (r.when.kind === "time") {
      const at = parseAtLocal(r.when.atLocal);
      if (at === null || Number.isNaN(nowMin) || nowMin < at || r.lastFiredDay === today) continue;
      try {
        await fire(r, now, true);
        fired.push(r.id);
      } catch {
        failed.push(r.id);
      }
      continue;
    }

    // Threshold: fire on the false→true edge; re-arm when it drops back. `armed`
    // absent means armed. This makes "HR high" fire once per spike, not every sweep,
    // and social-minutes reset naturally next day (new date row starts below).
    const { met } = evalThreshold(r.when, now);
    const armed = r.armed !== false;
    if (!met) {
      if (!armed) stamp(r.id, { armed: true }); // re-arm for the next crossing
      continue;
    }
    if (!armed) continue; // already fired this crossing
    try {
      await fire(r, now, true);
      stamp(r.id, { armed: false });
      fired.push(r.id);
    } catch {
      // keep armed so a transient send failure retries next sweep; error is on the row
      failed.push(r.id);
    }
  }
  return { fired, failed };
}

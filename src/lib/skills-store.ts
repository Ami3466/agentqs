/**
 * Server-only skill store (uses fs via config). Merges the built-in personas
 * (mentor · therapist · coach) with the user's own mentors saved in config, and
 * owns their CRUD. This is the single core every face calls — the `agentqs skill`
 * CLI, the /api/skills route, the MCP `skill_*` tools, and the chat brain — so a
 * mentor you add from the terminal answers in the GUI too.
 *
 * Built-in ids are reserved: a custom mentor can't shadow or delete them.
 */
import { readConfig, writeConfig, type AppConfig } from "./config";
import { SKILLS, type Skill } from "./skills";

const BUILTIN_IDS = new Set(SKILLS.map((s) => s.id));

/** fs-safe, lowercase persona id derived from a name (matches the record slug style). */
export function slugSkillId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function coerceSkill(raw: unknown): Skill | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const id = typeof v.id === "string" ? slugSkillId(v.id) : "";
  const name = typeof v.name === "string" ? v.name.trim() : "";
  const system = typeof v.system === "string" ? v.system.trim() : "";
  const blurb = typeof v.blurb === "string" ? v.blurb.trim() : "";
  if (!id || !name || !system) return null;
  return { id, name: name.slice(0, 60), blurb: blurb.slice(0, 120) || name, system };
}

/** Custom mentors from config, cleaned and de-conflicted against the built-ins. */
export function customSkills(cfg: AppConfig | null = readConfig()): Skill[] {
  const raw = Array.isArray(cfg?.customSkills) ? cfg!.customSkills : [];
  const seen = new Set(BUILTIN_IDS);
  const out: Skill[] = [];
  for (const r of raw) {
    const s = coerceSkill(r);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** Every persona the chat can wear: built-ins first, then the user's own. */
export function listSkills(cfg: AppConfig | null = readConfig()): Skill[] {
  return [...SKILLS, ...customSkills(cfg)];
}

/** Resolve an id to a persona, falling back to the default mentor (never throws). */
export function resolveSkill(id: string | null | undefined, cfg: AppConfig | null = readConfig()): Skill {
  const all = listSkills(cfg);
  return all.find((s) => s.id === id) ?? SKILLS[0];
}

export function isBuiltinSkill(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

export interface UpsertSkillInput {
  id?: string; // omit to derive from name
  name: string;
  blurb?: string;
  system: string;
}

export interface UpsertSkillResult {
  skill: Skill;
  created: boolean;
}

/** Add a new mentor or edit an existing custom one. Built-in ids are protected. */
export function upsertSkill(input: UpsertSkillInput): UpsertSkillResult {
  const cfg = readConfig();
  if (!cfg) throw new Error("agentqs isn't set up yet — run setup first.");
  const skill = coerceSkill({
    id: input.id || slugSkillId(input.name),
    name: input.name,
    blurb: input.blurb,
    system: input.system,
  });
  if (!skill) throw new Error("A mentor needs a name and a system prompt.");
  if (BUILTIN_IDS.has(skill.id)) {
    throw new Error(`"${skill.id}" is a built-in persona — pick another id.`);
  }
  const existing = Array.isArray(cfg.customSkills) ? cfg.customSkills : [];
  const idx = existing.findIndex((s) => s && (s as Skill).id === skill.id);
  const created = idx < 0;
  const next = existing.slice();
  if (created) next.push(skill);
  else next[idx] = skill;
  cfg.customSkills = next;
  writeConfig(cfg);
  return { skill, created };
}

/** Delete a custom mentor. Returns false if it doesn't exist; throws on built-ins. */
export function removeSkill(id: string): boolean {
  const slug = slugSkillId(id);
  if (BUILTIN_IDS.has(slug)) throw new Error(`"${slug}" is a built-in persona — it can't be removed.`);
  const cfg = readConfig();
  if (!cfg) return false;
  const existing = Array.isArray(cfg.customSkills) ? cfg.customSkills : [];
  const next = existing.filter((s) => s && (s as Skill).id !== slug);
  if (next.length === existing.length) return false;
  cfg.customSkills = next;
  writeConfig(cfg);
  return true;
}

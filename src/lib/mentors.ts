/**
 * Mentors — the voices the chat can wear. A mentor is just a system prompt + a
 * label for the chip beside the input; switch mid-conversation and the next reply
 * is framed by the new one. Three ship built-in; the user can add their own and
 * edit/delete any of them (built-ins become editable copies once touched), all
 * persisted in config.json under `mentors`.
 *
 * Pure data + string helpers only (no fs), so it is safe to import on both the
 * client (chip list) and the server (system prompt for /api/chat). Persistence
 * lives in config.ts; CRUD lives in /api/mentors.
 */

export interface Mentor {
  id: string;
  name: string;
  blurb: string; // one line, shown in the chip dropdown
  system: string; // system prompt handed to the model
}

const GROUNDING =
  "You are part of agentqs, a private life-record the user actually lives inside — sleep, heart rate, workouts, calendar, commits, messages, memos. " +
  "Reason like a friend who has read their whole file. Quote their real numbers when you have them; never give generic horoscope advice. " +
  "Be concise and direct: short sentences, no filler, no hedging.";

/** The three mentors that ship out of the box. Seeded into config on first edit. */
export const BUILTIN_MENTORS: Mentor[] = [
  {
    id: "mentor",
    name: "Mentor",
    blurb: "Direct, spots your patterns, holds you accountable",
    system:
      `${GROUNDING} Right now you are the MENTOR: sharp, honest, a little demanding. ` +
      "Name the pattern, connect it to what their data shows, and end on the single next move that matters.",
  },
  {
    id: "therapist",
    name: "Therapist",
    blurb: "CBT-grounded, reflective, gentle",
    system:
      `${GROUNDING} Right now you are the THERAPIST: warm, CBT-grounded. ` +
      "Reflect the feeling back first, look for the thought behind it, and offer one small, kind experiment — never a diagnosis.",
  },
  {
    id: "coach",
    name: "Coach",
    blurb: "Energetic, action-first, momentum",
    system:
      `${GROUNDING} Right now you are the COACH: energetic and action-first. ` +
      "Cut to the plan. Turn the answer into one concrete rep they can do today and make them want to start.",
  },
];

export const DEFAULT_MENTOR = "mentor";

const BUILTIN_IDS = new Set(BUILTIN_MENTORS.map((m) => m.id));

/** Is this id one of the three shipped built-ins? (Used to label copies.) */
export function isBuiltinMentor(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

/** The effective mentor list: the user's saved set once they've touched it,
 *  otherwise the built-ins. This is the single source both UI and server read. */
export function effectiveMentors(custom?: Mentor[] | null): Mentor[] {
  return custom && custom.length ? custom : BUILTIN_MENTORS;
}

/** Resolve a mentor by id against a list (defaults to built-ins). Falls back to
 *  the first mentor so a stale/unknown id never breaks a reply. */
export function mentorById(id: string | null | undefined, mentors: Mentor[] = BUILTIN_MENTORS): Mentor {
  const list = mentors.length ? mentors : BUILTIN_MENTORS;
  return list.find((m) => m.id === id) ?? list[0];
}

/** Slugify a name into a stable id; ensure it doesn't collide with `taken`. */
export function mentorId(name: string, taken: Iterable<string> = []): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "mentor";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const next = `${base}-${i}`;
    if (!used.has(next)) return next;
  }
}

/** Coerce one untrusted object into a clean Mentor; null if name or system is empty. */
export function sanitizeMentor(raw: unknown): Mentor | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const blurb = typeof o.blurb === "string" ? o.blurb.trim() : "";
  const system = typeof o.system === "string" ? o.system.trim() : "";
  if (!id || !name || !system) return null;
  return { id, name: name.slice(0, 40), blurb: blurb.slice(0, 120), system: system.slice(0, 4000) };
}

/** Coerce an untrusted array into a clean, id-deduped Mentor[] for config.json. */
export function sanitizeMentors(input: unknown): Mentor[] {
  if (!Array.isArray(input)) return [];
  const out: Mentor[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const m = sanitizeMentor(raw);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
    if (out.length >= 50) break; // hard cap
  }
  return out;
}

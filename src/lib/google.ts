/**
 * GOOGLE, AS ONE THING.
 *
 * Google was smeared across the app as three unrelated strangers: a source called
 * "Google Calendar", an automation card called "Google", and a backup target
 * called "Google Drive backup". Three names, three connect flows, one account.
 * That is what "I don't get the connections under pipeline" meant.
 *
 * This module is the single source of truth for what Google can bring in. It is a
 * TREE — Google → Gmail → Sent — and the UI, the CLI, the API and the sync all
 * read it from here.
 *
 *   Google
 *     ├─ Calendar                  (API, one OAuth key)
 *     └─ Gmail                     (API, same OAuth key)
 *          ├─ Inbox
 *          └─ Sent
 *     └─ Search / Maps / Gemini…   (Chrome extension, no key — GOOGLE_PRESETS)
 *
 * ONE KEY, TWO PRODUCTS: Calendar and Gmail share a single OAuth grant, stored
 * under the provider key `google` (see `oauthGrantKey` in importers/plugin.ts).
 * Checking Gmail therefore does not mean "connect a second thing", it means "ask
 * the same Google connection for one more scope" — which is a re-authorize, not a
 * new credential.
 *
 * BUT A IS NOT B IN THE UI. Sharing a key never means merging the surfaces:
 * `gdrive_backup` also speaks Google OAuth and is deliberately NOT in this tree —
 * it is a BACKUP TARGET (data going OUT, Settings → Data), and the pipeline is
 * data coming IN. Same dance, different animal. Do not "unify" it in here.
 *
 * This file stays PURE (no fs, no node) — the browser imports it for the card.
 */

import type { AppConfig } from "./config";

/** A leaf is a thing you can actually check on/off. A branch (`gmail`) is on when
 *  any of its leaves is. */
export interface GoogleProductDef {
  id: string; // "calendar" | "gmail" | "gmail.inbox" | "gmail.sent"
  parent?: string; // "gmail" for "gmail.inbox" — one level of nesting, that's all
  label: string;
  detail: string;
  /** OAuth scope this product needs. Leaves under one plugin share it. */
  scope?: string;
  /** The importer plugin that pulls it (its daily/<id>.csv). */
  plugin?: string;
  /** Daily columns it lands — shown on the checkbox so the user knows what they get. */
  metrics?: string[];
}

/** The Google Calendar scope: read-only, events only. */
export const SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar.readonly";
/**
 * Gmail. We only ever COUNT messages — we never read a body — but Gmail's cheaper
 * `gmail.metadata` scope forbids the `q` search parameter, and without `q` there is
 * no way to ask "how many arrived on Tuesday". So `gmail.readonly` is the smallest
 * scope that can answer the question at all. We request nothing else, and the
 * importer only ever asks for message IDs (`fields=messages/id`) — no headers, no
 * snippets, no bodies leave Google.
 */
export const SCOPE_GMAIL = "https://www.googleapis.com/auth/gmail.readonly";

/**
 * The API side of Google — the part behind the one OAuth key.
 * (The Chrome-extension side lives in GOOGLE_PRESETS, google-web-scraper.ts: it
 * needs no key, so it is not part of the grant, only of the card.)
 */
export const GOOGLE_PRODUCTS: GoogleProductDef[] = [
  {
    id: "calendar",
    label: "Calendar",
    detail: "meetings & hours per day",
    scope: SCOPE_CALENDAR,
    plugin: "gcal",
    metrics: ["meetings", "meeting_hours"],
  },
  {
    id: "gmail",
    label: "Gmail",
    detail: "how much mail moves through your day",
    scope: SCOPE_GMAIL,
    plugin: "gmail",
  },
  {
    id: "gmail.inbox",
    parent: "gmail",
    label: "Inbox",
    detail: "messages that arrived",
    scope: SCOPE_GMAIL,
    plugin: "gmail",
    metrics: ["emails_received"],
  },
  {
    id: "gmail.sent",
    parent: "gmail",
    label: "Sent",
    detail: "messages you sent",
    scope: SCOPE_GMAIL,
    plugin: "gmail",
    metrics: ["emails_sent"],
  },
];

/** The ids you can actually toggle: a branch with children is toggled BY its children. */
export const GOOGLE_LEAVES: string[] = GOOGLE_PRODUCTS.filter(
  (p) => !GOOGLE_PRODUCTS.some((c) => c.parent === p.id),
).map((p) => p.id);

export function googleProductById(id: string): GoogleProductDef | undefined {
  return GOOGLE_PRODUCTS.find((p) => p.id === id);
}

export function isGoogleProduct(id: unknown): id is string {
  return typeof id === "string" && GOOGLE_LEAVES.includes(id);
}

/**
 * What's switched on.
 *
 * The default is CALENDAR ONLY, and that is deliberate: before this tree existed,
 * "Google" meant `gcal`, so every already-connected user must land on exactly what
 * they had. Gmail is opt-in because switching it on widens the OAuth scope, and
 * silently asking someone's Google account for their mail because we shipped a
 * feature would be indefensible.
 */
export function googleEnabled(cfg: AppConfig | null): string[] {
  const saved = cfg?.googleProducts;
  if (!Array.isArray(saved)) return ["calendar"];
  return saved.filter(isGoogleProduct);
}

/** Is this product on? A branch is on when any leaf under it is. */
export function googleProductOn(cfg: AppConfig | null, id: string): boolean {
  const on = googleEnabled(cfg);
  if (on.includes(id)) return true;
  return GOOGLE_PRODUCTS.some((p) => p.parent === id && on.includes(p.id));
}

/** The leaves a click lands on: a leaf is itself, a branch (Gmail) is all its
 *  children — one click, no half-ticked Gmail. */
export function googleLeavesOf(id: string): string[] {
  if (GOOGLE_LEAVES.includes(id)) return [id];
  return GOOGLE_PRODUCTS.filter((p) => p.parent === id).map((p) => p.id);
}

/**
 * WHAT SHOULD BE TICKED after clicking `ids` on/off, given what is ticked now.
 *
 * The card sends THIS — the whole set, never a delta. A delta (`enable`/`disable`) is
 * applied to whatever the server happens to hold the moment it arrives, so two clicks
 * in flight could land in either order: ticking Gmail (which turns on BOTH leaves) and
 * then unticking Inbox would put Inbox back ON if the enable arrived last. The user
 * asked for Sent, got Inbox too, and nothing they clicked afterwards seemed to save.
 *
 * A full set cannot be re-ordered into a different answer: it says what the checkboxes
 * ARE. The delta API stays for the CLI, where the calls are sequential by definition.
 */
export function nextGoogleSelection(enabled: string[], ids: string[], on: boolean): string[] {
  const next = new Set(enabled.filter(isGoogleProduct));
  for (const id of ids) {
    for (const leaf of googleLeavesOf(id)) {
      if (on) next.add(leaf);
      else next.delete(leaf);
    }
  }
  return [...next].sort();
}

/**
 * May this Google plugin sync at all?
 *
 * The key opens the door; the checkbox says whether we walk through it. Calendar and
 * Gmail share ONE credential, so an unticked Gmail still reads as "connected" — and
 * without this guard, unticking Gmail after it had picked up a daily schedule would
 * go on pulling someone's mail on a cadence they thought they had switched off.
 * A plugin outside the Google tree is never constrained by it.
 */
export function googlePluginOn(cfg: AppConfig | null, pluginId: string): boolean {
  if (!GOOGLE_PRODUCTS.some((p) => p.plugin === pluginId)) return true; // not ours to gate
  return googlePluginsOn(cfg).includes(pluginId);
}

/** The plugins a sync should actually run, given what's checked. */
export function googlePluginsOn(cfg: AppConfig | null): string[] {
  const on = googleEnabled(cfg);
  const plugins = new Set<string>();
  for (const id of on) {
    const plugin = googleProductById(id)?.plugin;
    if (plugin) plugins.add(plugin);
  }
  return [...plugins];
}

/** Which halves of Gmail to pull. Both off → Gmail is off and never syncs. */
export function gmailParts(cfg: AppConfig | null): { inbox: boolean; sent: boolean } {
  const on = googleEnabled(cfg);
  return { inbox: on.includes("gmail.inbox"), sent: on.includes("gmail.sent") };
}

/**
 * The scope to ask Google for: the union over what's CHECKED, never more.
 * Uncheck Gmail and the next authorize stops asking for mail access.
 */
export function googleScopes(cfg: AppConfig | null): string {
  const scopes = new Set<string>();
  for (const id of googleEnabled(cfg)) {
    const scope = googleProductById(id)?.scope;
    if (scope) scopes.add(scope);
  }
  // Never mint a grant with an empty scope — Google rejects it, and an
  // "everything unchecked" account should still hold a usable connection.
  if (!scopes.size) scopes.add(SCOPE_CALENDAR);
  return [...scopes].join(" ");
}

/**
 * Scopes the user has CHECKED but the stored grant was never granted — i.e. "you
 * ticked Gmail, but the key in the drawer only opens Calendar". The card turns this
 * into "Re-authorize to add Gmail" instead of letting the next sync 403.
 */
export function googleMissingScopes(cfg: AppConfig | null): string[] {
  const grant = cfg?.sourceOAuth?.google;
  if (!grant?.refreshToken && !grant?.accessToken) return []; // not connected at all — not a scope problem
  const granted = new Set((grant.scopes ?? "").split(/\s+/).filter(Boolean));
  // A grant minted before we tracked scopes: assume it holds what it was born with
  // (calendar) rather than nagging a working connection.
  if (!granted.size) granted.add(SCOPE_CALENDAR);
  return googleScopes(cfg)
    .split(" ")
    .filter((s) => s && !granted.has(s));
}

/** Human names for the products behind the missing scopes ("Gmail"). */
export function googleMissingProducts(cfg: AppConfig | null): string[] {
  const missing = new Set(googleMissingScopes(cfg));
  if (!missing.size) return [];
  const names = new Set<string>();
  for (const id of googleEnabled(cfg)) {
    const p = googleProductById(id);
    if (!p?.scope || !missing.has(p.scope)) continue;
    const top = p.parent ? googleProductById(p.parent) : p;
    names.add(top?.label ?? p.label);
  }
  return [...names];
}

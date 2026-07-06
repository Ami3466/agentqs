/**
 * Provider backbone (model-agnostic). A provider is an ACCOUNT the user adds in
 * Settings — a label + API key + base URL over one of a few known wire protocols
 * (Anthropic, Google, or the OpenAI-compatible shape that OpenAI / OpenRouter /
 * Groq / any custom endpoint all speak). NOTHING about model ids is hardcoded: the
 * picker lists live models pulled from each account's own /models endpoint (see
 * /api/models) after a key is entered, exactly like a real console.
 *
 * Pure data + pure resolution only (no fs, no React) so it's safe to import on the
 * client (the Settings list, the chat model chip) and the server (the call layer).
 */

export type Protocol = "anthropic" | "google" | "openai";

/** A known provider *type* — the wire protocol + its default base URL + a key hint.
 *  The account carries the actual key/base; the type says how to talk to it. */
export interface ProviderType {
  type: string;
  label: string;
  protocol: Protocol;
  defaultBase: string;
  keyHint: string;
  custom?: boolean; // requires the user to supply the base URL
}

export const PROVIDER_TYPES: ProviderType[] = [
  { type: "anthropic", label: "Anthropic", protocol: "anthropic", defaultBase: "https://api.anthropic.com/v1", keyHint: "sk-ant-…" },
  { type: "openai", label: "OpenAI", protocol: "openai", defaultBase: "https://api.openai.com/v1", keyHint: "sk-…" },
  { type: "google", label: "Google", protocol: "google", defaultBase: "https://generativelanguage.googleapis.com/v1beta", keyHint: "AIza…" },
  { type: "openrouter", label: "OpenRouter", protocol: "openai", defaultBase: "https://openrouter.ai/api/v1", keyHint: "sk-or-…" },
  { type: "groq", label: "Groq", protocol: "openai", defaultBase: "https://api.groq.com/openai/v1", keyHint: "gsk_…" },
  { type: "custom", label: "Custom endpoint", protocol: "openai", defaultBase: "", keyHint: "key", custom: true },
];

export function providerTypeOf(type: string | null | undefined): ProviderType | undefined {
  return PROVIDER_TYPES.find((p) => p.type === type);
}

/** Is `type` a known provider protocol? (legacy validation + CLI) */
export function isProvider(type: string): boolean {
  return PROVIDER_TYPES.some((p) => p.type === type);
}

export function protocolOf(type: string): Protocol {
  return providerTypeOf(type)?.protocol ?? "openai";
}

export function defaultBaseFor(type: string): string {
  return providerTypeOf(type)?.defaultBase ?? "";
}

/** A provider account the user has added: label + key + base over a known type. */
export interface ProviderAccount {
  id: string;
  type: string; // anthropic | openai | google | openrouter | groq | custom
  label: string;
  apiKey: string;
  baseUrl: string; // where /models + calls live (defaults to the type's base)
}

/** The chat model in use: a provider account + a live model id from it. */
export interface ModelSelection {
  providerId: string;
  model: string;
}

/** A resolved call target: the protocol, key, base and model to actually hit. */
export interface ResolvedLlm {
  type: string;
  protocol: Protocol;
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * Last-resort model per protocol, used ONLY when an account is set but no model was
 * ever picked (the call layer must send *something*). Not a catalog and never shown
 * as a preset — the picker always offers the live list instead.
 */
const FALLBACK_MODEL: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o",
  google: "gemini-2.5-flash",
};

export function fallbackModel(type: string, model?: string | null): string {
  return model?.trim() || FALLBACK_MODEL[type] || "";
}

export function accountBase(a: ProviderAccount): string {
  return (a.baseUrl && a.baseUrl.trim()) || defaultBaseFor(a.type);
}

/**
 * Resolve which account + model to call. Precedence: an explicit per-request
 * `override` (the chat model chip) wins, else the saved `selected` model, else the
 * first added account. Returns null when there's no usable account (no key).
 */
export function resolveLlm(
  providers: ProviderAccount[],
  selected?: ModelSelection | null,
  override?: Partial<ModelSelection> | null,
): ResolvedLlm | null {
  if (!providers.length) return null;
  const wantId = override?.providerId || selected?.providerId || providers[0].id;
  const account = providers.find((p) => p.id === wantId) ?? providers[0];
  if (!account.apiKey) return null;
  const model =
    (override?.model && override.model.trim()) ||
    (account.id === selected?.providerId ? selected?.model : "") ||
    fallbackModel(account.type);
  return {
    type: account.type,
    protocol: protocolOf(account.type),
    apiKey: account.apiKey,
    baseUrl: accountBase(account),
    model,
  };
}

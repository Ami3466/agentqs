/**
 * Provider catalog for the LLM picker. A provider is just an id + label + a key
 * hint + the base URL its models are fetched from — NOTHING about model ids is
 * hardcoded. The picker lists live models pulled from the provider's own /models
 * endpoint (see /api/models) after a key is entered, exactly like a real console.
 */
export interface Provider {
  id: string;
  label: string;
  keyHint: string;
  base: string; // where GET /models lives
}

export const PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    label: "Anthropic — Claude",
    keyHint: "sk-ant-…",
    base: "https://api.anthropic.com/v1",
  },
  {
    id: "openai",
    label: "OpenAI",
    keyHint: "sk-…",
    base: "https://api.openai.com/v1",
  },
  {
    id: "google",
    label: "Google — Gemini",
    keyHint: "AIza…",
    base: "https://generativelanguage.googleapis.com/v1beta",
  },
];

export const DEFAULT_PROVIDER = "anthropic";

export function isProvider(id: string): boolean {
  return PROVIDERS.some((p) => p.id === id);
}

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Last-resort model per provider, used ONLY when a key is set but the user never
 * picked a model (the call layer must send *something*). Not a catalog and never
 * shown as a preset choice — the picker always offers the live list instead.
 */
const FALLBACK_MODEL: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o",
  google: "gemini-2.5-flash",
};

/** The model id to actually call: the user's saved pick, else the provider default. */
export function fallbackModel(provider: string, model?: string | null): string {
  return model?.trim() || FALLBACK_MODEL[provider] || "";
}

/**
 * Provider + model catalog for the LLM picker (setup + settings). Illustrative
 * defaults; the real provider wiring lands in the agent loop.
 */
export interface Provider {
  id: string;
  label: string;
  keyHint: string;
  models: string[];
}

export const PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    label: "Anthropic — Claude",
    keyHint: "sk-ant-…",
    models: ["claude-opus-4-8", "claude-sonnet-4-5", "claude-haiku-4-5"],
  },
  {
    id: "openai",
    label: "OpenAI",
    keyHint: "sk-…",
    models: ["gpt-4.1", "gpt-4o", "o4-mini"],
  },
  {
    id: "google",
    label: "Google — Gemini",
    keyHint: "AIza…",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
];

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-sonnet-4-5";

/** Sensible default model per provider when the user hasn't picked one. Single
 *  source of truth shared by the legacy completion helper (llm.ts) and the
 *  tool-using agent (agent.ts). */
export const FALLBACK_MODEL: Record<string, string> = {
  anthropic: DEFAULT_MODEL,
  openai: "gpt-4o",
  google: "gemini-2.5-flash",
};

/** The model id to actually call: the user's pick, else the provider default. */
export function fallbackModel(provider: string, model?: string | null): string {
  return model?.trim() || FALLBACK_MODEL[provider] || "";
}

export function modelsForProvider(id: string): string[] {
  return PROVIDERS.find((p) => p.id === id)?.models ?? [];
}

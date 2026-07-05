/**
 * Provider metadata for the LLM picker (setup + settings). Model ids are NEVER
 * hardcoded here — they are fetched live from each provider's /models endpoint
 * (see /api/models) once the user pastes a key, and persisted per-instance in
 * config (`llmModels`). This file only knows which providers exist.
 */
export interface Provider {
  id: string;
  label: string;
  keyHint: string;
}

export const PROVIDERS: Provider[] = [
  { id: "anthropic", label: "Anthropic — Claude", keyHint: "sk-ant-…" },
  { id: "openai", label: "OpenAI", keyHint: "sk-…" },
  { id: "google", label: "Google — Gemini", keyHint: "AIza…" },
];

export function isProvider(id: string): boolean {
  return PROVIDERS.some((p) => p.id === id);
}

/** The model id to actually call: the user's saved pick, else the first model
 *  fetched live from the provider. Never a hardcoded literal. */
export function pickModel(model?: string | null, models?: string[] | null): string {
  return model?.trim() || models?.[0] || "";
}

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

export function modelsForProvider(id: string): string[] {
  return PROVIDERS.find((p) => p.id === id)?.models ?? [];
}

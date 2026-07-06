/**
 * A lean, dependency-free chat-completion call over the three providers agentqs
 * supports (Anthropic / OpenAI / Google). Loop 4's grounded agent will layer
 * SQL/FTS tools on top; Loop 6 only needs a single-turn reply so the smart-input
 * chat path is real when the user has pasted a key, and degrades gracefully when
 * they haven't. One helper, one fetch, provider chosen by id.
 */

import { fallbackModel, type ResolvedLlm } from "./models";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  llm: ResolvedLlm; // protocol + key + base + model to call
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* leave json empty; surfaced below */
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || text || res.statusText;
    throw new Error(`${res.status} ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  return json;
}

/** Run one completion. Returns the assistant's text; throws on transport/API error.
 *  Honours each provider's base URL so OpenAI-compatible endpoints (OpenRouter /
 *  Groq / custom) work through the same path as OpenAI. */
export async function llmComplete(req: LlmRequest): Promise<string> {
  const { llm } = req;
  const model = fallbackModel(llm.type, llm.model);
  const maxTokens = req.maxTokens ?? 1024;
  const base = (llm.baseUrl || "").replace(/\/$/, "");

  if (llm.protocol === "anthropic") {
    const data = await post(
      `${base}/messages`,
      { "x-api-key": llm.apiKey, "anthropic-version": "2023-06-01" },
      { model, max_tokens: maxTokens, system: req.system, messages: req.messages },
      req.signal,
    );
    const parts = Array.isArray(data.content) ? data.content : [];
    return parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("").trim();
  }

  if (llm.protocol === "google") {
    const data = await post(
      `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(llm.apiKey)}`,
      {},
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: maxTokens },
      },
      req.signal,
    );
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    return parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("").trim();
  }

  // openai-compatible (openai / openrouter / groq / custom)
  const data = await post(
    `${base}/chat/completions`,
    { authorization: `Bearer ${llm.apiKey}` },
    {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: req.system }, ...req.messages],
    },
    req.signal,
  );
  return String(data?.choices?.[0]?.message?.content ?? "").trim();
}

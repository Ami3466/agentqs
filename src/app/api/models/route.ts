import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readConfig } from "@/lib/config";
import { providerById } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live model list, pulled from the provider's own /models endpoint — the console
 * face of "paste a key, load its models". Nothing is hardcoded: the ids returned
 * are whatever the provider currently serves for that key. Pass a `key` to test a
 * new one, or omit it to reuse the saved key. The CLI (`agentqs models`) and MCP
 * hit the same normalizer.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { provider?: string; key?: string };
  const provider = providerById(String(body.provider ?? ""));
  if (!provider) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  }
  const key = (body.key && body.key.trim()) || readConfig()?.llmKey || "";
  if (!key) {
    return NextResponse.json({ error: "Add an API key first." }, { status: 400 });
  }
  try {
    const models = await fetchModels(provider.id, provider.base, key);
    return NextResponse.json({ ok: true, provider: provider.id, models });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

async function fetchModels(id: string, base: string, key: string): Promise<string[]> {
  const b = base.replace(/\/$/, "");
  if (id === "google") {
    const res = await fetch(`${b}/models?key=${encodeURIComponent(key)}&pageSize=1000`);
    const json = await readJson(res);
    const models = (json.models ?? []) as Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    return dedupeSort(
      models
        .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
        .map((m) => String(m.name ?? "").replace(/^models\//, ""))
        .filter(Boolean),
    );
  }
  const headers: Record<string, string> =
    id === "anthropic"
      ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${key}` };
  const res = await fetch(`${b}/models`, { headers });
  const json = await readJson(res);
  const rows = (json.data ?? json.models ?? []) as Array<{ id?: string; name?: string }>;
  return dedupeSort(rows.map((m) => String(m.id ?? m.name ?? "")).filter(Boolean));
}

async function readJson(res: Response): Promise<{ data?: unknown[]; models?: unknown[]; error?: unknown }> {
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* fall through */
  }
  if (!res.ok) {
    const err = json.error as { message?: string } | string | undefined;
    const msg = (typeof err === "object" ? err?.message : err) || text || res.statusText;
    throw new Error(`${res.status} ${String(msg).slice(0, 200)}`);
  }
  return json as { data?: unknown[]; models?: unknown[] };
}

function dedupeSort(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { effectiveProviders, readConfig } from "@/lib/config";
import { accountBase, defaultBaseFor, protocolOf, providerTypeOf, type Protocol } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live model list, pulled from a provider account's own /models endpoint — the
 * console face of "add a provider, load its models". Nothing is hardcoded: the ids
 * returned are whatever that key currently serves. Two shapes:
 *   { providerId }        — an already-saved account (reuse its key/base).
 *   { type, key, base? }  — an account being added in Settings (test the key live).
 * The CLI (`agentqs models`) and MCP hit the same normalizer.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    providerId?: string;
    type?: string;
    key?: string;
    base?: string;
  };

  let type = "";
  let base = "";
  let key = "";

  if (body.providerId) {
    const acct = effectiveProviders(readConfig()).find((p) => p.id === body.providerId);
    if (!acct) return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
    type = acct.type;
    base = accountBase(acct);
    key = (body.key && body.key.trim()) || acct.apiKey;
  } else {
    type = String(body.type ?? "");
    if (!providerTypeOf(type)) return NextResponse.json({ error: "Unknown provider type." }, { status: 400 });
    base = (body.base && body.base.trim()) || defaultBaseFor(type);
    key = (body.key ?? "").trim();
  }

  if (!key) return NextResponse.json({ error: "Add an API key first." }, { status: 400 });
  if (!base) return NextResponse.json({ error: "Add a base URL for this endpoint." }, { status: 400 });

  try {
    const models = await fetchModels(protocolOf(type), base, key);
    return NextResponse.json({ ok: true, type, models });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

async function fetchModels(protocol: Protocol, base: string, key: string): Promise<string[]> {
  const b = base.replace(/\/$/, "");
  if (protocol === "google") {
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
    protocol === "anthropic"
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

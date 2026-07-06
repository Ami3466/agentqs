import { NextResponse } from "next/server";
import { isProvider } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live model discovery. POST { provider, key } → the provider's real /models
 * response, deduped + sorted. There is no fallback list: if the key is bad or the
 * call fails we return { ok:false, error } and the UI leaves the picker empty.
 * Mirrors wpbot's testAndFetch — paste key, load the ids the API actually returns.
 */

function clean(ids: unknown[]): string[] {
  return [
    ...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0)),
  ].sort();
}

async function fetchModels(provider: string, key: string): Promise<string[]> {
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return clean((json?.data ?? []).map((m: { id?: string }) => m?.id));
  }
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return clean((json?.data ?? []).map((m: { id?: string }) => m?.id));
  }
  if (provider === "google") {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
    );
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return clean(
      (json?.models ?? []).map((m: { name?: string }) =>
        String(m?.name ?? "").replace(/^models\//, ""),
      ),
    );
  }
  throw new Error(`Unknown provider "${provider}".`);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const provider = String(body?.provider ?? "");
  const key = String(body?.key ?? "").trim();

  if (!isProvider(provider)) {
    return NextResponse.json({ ok: false, error: "Unknown provider." }, { status: 400 });
  }
  if (!key) {
    return NextResponse.json({ ok: false, error: "Paste an API key first." }, { status: 400 });
  }

  try {
    const models = await fetchModels(provider, key);
    if (!models.length) {
      return NextResponse.json(
        { ok: false, error: "No models returned for this key." },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true, models });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}

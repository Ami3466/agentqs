import { NextResponse } from "next/server";
import { hashPassword } from "@/lib/auth";
import { readConfig, sessionSecretFor, writeConfig } from "@/lib/config";
import { getCurrentUser, setSessionCookie } from "@/lib/session";
import { isProvider, pickModel } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const cfg = readConfig();
  if (!cfg) {
    return NextResponse.json({ error: "No config." }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));

  // Profile
  if (typeof body.username === "string") {
    const username = body.username.trim();
    if (username.length < 2) {
      return NextResponse.json(
        { error: "Username too short." },
        { status: 400 },
      );
    }
    cfg.username = username;
  }
  if (typeof body.password === "string" && body.password) {
    if (body.password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters." },
        { status: 400 },
      );
    }
    cfg.passwordHash = hashPassword(body.password);
  }

  // AI provider
  if (typeof body.llmProvider === "string") {
    const provider = body.llmProvider;
    if (provider && !isProvider(provider)) {
      return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
    }
    cfg.llmProvider = provider;
    if (!provider) {
      cfg.model = "";
      cfg.llmModels = [];
    }
  }
  // The live-fetched model list (empty when no provider). Persist before picking a model.
  if (Array.isArray(body.llmModels) && cfg.llmProvider) {
    cfg.llmModels = body.llmModels.filter((m: unknown): m is string => typeof m === "string");
  }
  if (typeof body.model === "string" && cfg.llmProvider) {
    const models = cfg.llmModels ?? [];
    cfg.model =
      models.length && !models.includes(body.model) ? pickModel("", models) : body.model;
  }
  if (typeof body.llmKey === "string" && body.llmKey) {
    cfg.llmKey = body.llmKey;
  }

  // Appearance (persisted server-side too; client localStorage drives paint)
  if (body.theme === "light" || body.theme === "dark" || body.theme === "system") {
    cfg.theme = body.theme;
  }

  // First-run tour finished/dismissed — stamp once so it never reappears.
  if (typeof body.onboardedAt === "string" && body.onboardedAt && !cfg.onboardedAt) {
    cfg.onboardedAt = body.onboardedAt;
  }

  try {
    writeConfig(cfg);
  } catch {
    return NextResponse.json({ error: "Could not save." }, { status: 500 });
  }

  // Re-issue the session so a renamed user stays signed in as the new name.
  if (cfg.username !== user.username) {
    setSessionCookie(cfg.username, sessionSecretFor(cfg));
  }

  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { hashPassword, newSecret } from "@/lib/auth";
import { configExists, writeConfig, type AppConfig } from "@/lib/config";
import { setSessionCookie } from "@/lib/session";
import { isProvider } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (configExists()) {
    return NextResponse.json({ error: "Already set up." }, { status: 409 });
  }

  const body = await req.json().catch(() => null);
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");
  const llmProvider = String(body?.llmProvider ?? "");
  const llmKey = String(body?.llmKey ?? "");
  // The picker's ids are fetched live from the provider (POST /api/models); the
  // client sends the id it chose plus that live list. We trust and persist them —
  // never a hardcoded catalog.
  let model = String(body?.model ?? "");
  let llmModels = Array.isArray(body?.llmModels)
    ? (body.llmModels as unknown[]).filter((x): x is string => typeof x === "string")
    : [];

  if (username.length < 2) {
    return NextResponse.json({ error: "Username too short." }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters." },
      { status: 400 },
    );
  }
  if (llmProvider) {
    if (!isProvider(llmProvider)) {
      return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
    }
    if (!model) model = llmModels[0] || "";
  } else {
    model = "";
    llmModels = [];
  }

  const secret = process.env.SESSION_SECRET || newSecret();
  const cfg: AppConfig = {
    username,
    passwordHash: hashPassword(password),
    sessionSecret: secret,
    llmProvider,
    llmKey,
    model,
    llmModels,
    theme: "system",
    createdAt: new Date().toISOString(),
  };

  try {
    writeConfig(cfg);
  } catch {
    return NextResponse.json(
      { error: "Could not write config to the data directory." },
      { status: 500 },
    );
  }

  setSessionCookie(username, secret);
  return NextResponse.json({ ok: true });
}

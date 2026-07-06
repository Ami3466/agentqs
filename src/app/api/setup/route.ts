import { NextResponse } from "next/server";
import { hashPassword, newSecret } from "@/lib/auth";
import { configExists, writeConfig, type AppConfig } from "@/lib/config";
import { setSessionCookie } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * First-run signup: username + password, nothing else. The AI provider, key and
 * model are added later in Settings (or from the CLI) — signup stays a two-field
 * wall so a new instance is live in seconds.
 */
export async function POST(req: Request) {
  if (configExists()) {
    return NextResponse.json({ error: "Already set up." }, { status: 409 });
  }

  const body = await req.json().catch(() => null);
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");

  if (username.length < 2) {
    return NextResponse.json({ error: "Username too short." }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters." },
      { status: 400 },
    );
  }

  const secret = process.env.SESSION_SECRET || newSecret();
  const cfg: AppConfig = {
    username,
    passwordHash: hashPassword(password),
    sessionSecret: secret,
    llmProvider: "",
    llmKey: "",
    model: "",
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

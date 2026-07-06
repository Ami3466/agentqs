import { NextResponse } from "next/server";
import { hashPassword, newSecret } from "@/lib/auth";
import { configExists, writeConfig, type AppConfig } from "@/lib/config";
import { setSessionCookie } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * First-run signup: email OR username, password + confirm, nothing else. What you
 * type is stored in the config `username` field. The AI provider, key and model
 * are added later in Settings or from the CLI.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;

export async function POST(req: Request) {
  if (configExists()) {
    return NextResponse.json({ error: "Already set up." }, { status: 409 });
  }

  const body = await req.json().catch(() => null);
  const username = String(body?.username ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  const confirm = String(body?.confirm ?? "");

  if (!EMAIL_RE.test(username) && !USERNAME_RE.test(username)) {
    return NextResponse.json(
      { error: "Enter a valid email or username (letters/numbers, 2+ characters)." },
      { status: 400 },
    );
  }
  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters." },
      { status: 400 },
    );
  }
  if (password !== confirm) {
    return NextResponse.json({ error: "Passwords don't match." }, { status: 400 });
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

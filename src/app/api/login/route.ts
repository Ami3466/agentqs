import { NextResponse } from "next/server";
import { verifyPassword } from "@/lib/auth";
import { readConfig, sessionSecretFor } from "@/lib/config";
import { setSessionCookie } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const cfg = readConfig();
  if (!cfg) {
    return NextResponse.json({ error: "Not set up yet." }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const username = String(body?.username ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");

  const ok = username === cfg.username && verifyPassword(password, cfg.passwordHash);
  if (!ok) {
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 },
    );
  }

  setSessionCookie(cfg.username, sessionSecretFor(cfg));
  return NextResponse.json({ ok: true });
}

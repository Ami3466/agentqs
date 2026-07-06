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
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");

  // Case-insensitive so a pre-email-signup username ("Amit") still signs in.
  const ok =
    username.toLowerCase() === cfg.username.toLowerCase() &&
    verifyPassword(password, cfg.passwordHash);
  if (!ok) {
    return NextResponse.json(
      { error: "Invalid username or password." },
      { status: 401 },
    );
  }

  setSessionCookie(cfg.username, sessionSecretFor(cfg));
  return NextResponse.json({ ok: true });
}

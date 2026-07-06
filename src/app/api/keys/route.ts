import crypto from "crypto";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { readConfig, writeConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The API key that authenticates the HTTP API + CLI + MCP over the wire (the
 * bearer `getCurrentUser` accepts). Generated on demand from the Connect panel.
 * GET returns a masked status; POST mints a fresh key (rotating any old one) and
 * returns it in full ONCE so the snippets can be filled in; DELETE revokes it.
 * Cookie-authed only — you can't rotate the key using the key.
 */
export async function GET() {
  const cfg = requireCookieUser();
  if (!cfg) return unauth();
  return NextResponse.json({ hasKey: Boolean(cfg.apiKey), masked: mask(cfg.apiKey) });
}

export async function POST() {
  const cfg = requireCookieUser();
  if (!cfg) return unauth();
  const key = `aqs_${crypto.randomBytes(24).toString("base64url")}`;
  cfg.apiKey = key;
  try {
    writeConfig(cfg);
  } catch {
    return NextResponse.json({ error: "Could not save the key." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, key, masked: mask(key) });
}

export async function DELETE() {
  const cfg = requireCookieUser();
  if (!cfg) return unauth();
  delete cfg.apiKey;
  try {
    writeConfig(cfg);
  } catch {
    return NextResponse.json({ error: "Could not revoke the key." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

/** Only a real browser session (cookie) may manage keys — never the bearer itself. */
function requireCookieUser() {
  if (!getSessionUser()) return null;
  return readConfig();
}

function unauth() {
  return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
}

function mask(key?: string): string {
  return key ? `${key.slice(0, 8)}••••${key.slice(-4)}` : "";
}

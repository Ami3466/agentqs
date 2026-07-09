import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { linkedApiKey, readConfig } from "@/lib/config";
import { describeSession, elevenLabsSignedUrl, geminiLiveToken, type SessionEnv } from "@/lib/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The in-chat live voice session — ElevenLabs Conversational AI or Gemini Live,
 *  picked in Settings → Voice (the key may be linked to a provider account).
 *  ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID stay the env fallback. */
function sessionEnv(): SessionEnv {
  const cfg = readConfig();
  const v = cfg?.voice;
  const key = v?.provider ? linkedApiKey(cfg, v.providerId, v.apiKey) : "";
  return {
    provider: v?.provider || "",
    elevenLabsKey: (v?.provider === "elevenlabs" ? key : "") || process.env.ELEVENLABS_API_KEY || "",
    elevenLabsAgentId: v?.agentId || process.env.ELEVENLABS_AGENT_ID || "",
    googleKey:
      (v?.provider === "google-live" ? key : "") ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      "",
  };
}

/** Capability probe for the in-chat toggle — is the live session configured? */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json(describeSession(sessionEnv()));
}

/**
 * Start a live voice session. Config-gated: with nothing configured this returns
 * 501 + the setup reason (the toggle explains what to set). When configured it's
 * real wiring — ElevenLabs mints a signed URL its Conversational AI widget
 * connects to; Gemini Live mints a single-use ephemeral token the browser uses
 * as its API key, so the real key never leaves this machine. The client writes
 * the session's key points back to the record on close.
 */
export async function POST() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const env = sessionEnv();
  const status = describeSession(env);
  if (!status.enabled) {
    return NextResponse.json({ error: status.reason, ...status }, { status: 501 });
  }
  try {
    if (status.provider === "google-live") {
      const { token, model } = await geminiLiveToken(env);
      return NextResponse.json({
        ok: true,
        provider: "google-live",
        model,
        token,
        note: "Open the Gemini Live WebSocket with this ephemeral token as the API key. Write key points back to the record on close.",
      });
    }
    const signedUrl = await elevenLabsSignedUrl(env);
    return NextResponse.json({
      ok: true,
      provider: "elevenlabs",
      brain: "claude",
      agentId: env.elevenLabsAgentId,
      signedUrl,
      note: "Connect the ElevenLabs Conversational AI widget to this signed URL. Write key points back to the record on close.",
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

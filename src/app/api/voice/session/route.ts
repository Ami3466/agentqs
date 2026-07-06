import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { linkedApiKey, readConfig } from "@/lib/config";
import { describeSession, elevenLabsSignedUrl, type SessionEnv } from "@/lib/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The in-chat live voice session is ElevenLabs Conversational AI — configured from
 *  the Settings voice picker (its key may be linked to a provider account), falling
 *  back to ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID. */
function sessionEnv(): SessionEnv {
  const cfg = readConfig();
  const v = cfg?.voice;
  const key = v?.provider === "elevenlabs" ? linkedApiKey(cfg, v.providerId, v.apiKey) : "";
  return {
    elevenLabsKey: key || process.env.ELEVENLABS_API_KEY || "",
    elevenLabsAgentId: v?.agentId || process.env.ELEVENLABS_AGENT_ID || "",
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
 * Start a live voice session. Config-gated: with no ElevenLabs key/agent this is
 * a stub that returns 501 + the setup reason (the toggle explains what to set).
 * When configured it's real wiring — it mints a signed URL the ElevenLabs
 * Conversational AI widget connects to for the WebRTC audio channel. The agent's
 * brain is Claude (configured on the ElevenLabs agent), and the client is
 * expected to write the session's key points back to the record on close.
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

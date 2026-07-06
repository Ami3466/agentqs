import { NextResponse } from "next/server";
import { hashPassword } from "@/lib/auth";
import {
  effectiveProviders,
  publicConfig,
  readConfig,
  sanitizeProviders,
  sessionSecretFor,
  writeConfig,
  type ChannelReplyPrefs,
} from "@/lib/config";
import { recordInAppRepoEnabled, setRecordInAppRepoEnabled } from "@/lib/record-git";
import { getCurrentUser, setSessionCookie } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public config for the client — the providers list (masked) + the selected model,
 *  so the chat model chip can list what's available. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const cfg = readConfig();
  if (!cfg) return NextResponse.json({ error: "No config." }, { status: 400 });
  return NextResponse.json(publicConfig(cfg));
}

/** Blank incoming secret = keep the stored one (the client only ever holds a mask). */
function keepOrSet(incoming: unknown, prev: string | undefined): string | undefined {
  if (typeof incoming === "string" && incoming.trim()) return incoming;
  return prev;
}

/** Coerce untrusted per-channel reply prefs (mode / skill / model override).
 *  Merges over the stored map: a channel present in the payload is replaced whole
 *  (so the form can clear a skill), a channel absent keeps its stored prefs — a
 *  partial API/CLI update can't silently flip a log-only channel back to AI. */
function sanitizeChannelReplies(
  input: unknown,
  prev: Record<string, ChannelReplyPrefs> | undefined,
): Record<string, ChannelReplyPrefs> | undefined {
  if (!input || typeof input !== "object") return prev;
  const out: Record<string, ChannelReplyPrefs> = { ...(prev ?? {}) };
  for (const [channel, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || !/^[a-z0-9-]{1,30}$/.test(channel)) continue;
    const v = raw as Record<string, unknown>;
    out[channel] = {
      ai: v.ai !== false,
      skill: typeof v.skill === "string" ? v.skill.slice(0, 60) : undefined,
      providerId: typeof v.providerId === "string" ? v.providerId.slice(0, 60) : undefined,
      model: typeof v.model === "string" ? v.model.slice(0, 100) : undefined,
    };
  }
  return out;
}

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
      return NextResponse.json({ error: "Username too short." }, { status: 400 });
    }
    cfg.username = username;
  }
  if (typeof body.password === "string" && body.password) {
    if (body.password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }
    cfg.passwordHash = hashPassword(body.password);
  }

  // AI providers LIST. The client sends the whole list; a blank apiKey on a row
  // means "keep the stored key" (it never held the raw one). Saving a list retires
  // the legacy single-provider fields.
  if (Array.isArray(body.providers)) {
    const incoming = sanitizeProviders(body.providers);
    // effectiveProviders, not cfg.providers: a legacy single-key config shows up in
    // the form as a row too, and its stored key must survive a blank-key save.
    const prevById = new Map(effectiveProviders(cfg).map((p) => [p.id, p]));
    cfg.providers = incoming.map((p) => ({
      ...p,
      apiKey: p.apiKey || prevById.get(p.id)?.apiKey || "",
    }));
    cfg.llmProvider = "";
    cfg.llmKey = "";
    cfg.model = "";
  }

  // Selected chat model (provider account + live model id). null clears it.
  if ("selectedModel" in body) {
    const s = body.selectedModel;
    if (s && typeof s === "object" && typeof s.providerId === "string" && typeof s.model === "string") {
      cfg.selectedModel = { providerId: s.providerId, model: s.model };
    } else {
      cfg.selectedModel = undefined;
    }
  }

  // Embedding model + the semantic-search switches (absent booleans keep the stored value)
  if (body.embedding && typeof body.embedding === "object") {
    const e = body.embedding;
    cfg.embedding = {
      mode: e.mode === "api" ? "api" : "local",
      enabled: typeof e.enabled === "boolean" ? e.enabled : cfg.embedding?.enabled,
      autoIndex: typeof e.autoIndex === "boolean" ? e.autoIndex : cfg.embedding?.autoIndex,
      model: typeof e.model === "string" ? e.model.trim() : cfg.embedding?.model,
      providerId: typeof e.providerId === "string" ? e.providerId : cfg.embedding?.providerId,
      apiKey: keepOrSet(e.apiKey, cfg.embedding?.apiKey),
    };
  }

  // Auto-structure: new captures skip the pending inbox and merge straight into daily
  if (typeof body.autoStructure === "boolean") {
    cfg.autoStructure = body.autoStructure;
  }

  // Voice model. whisperModel is managed by /api/voice/whisper (install/remove),
  // so a form save preserves it; the language rides along with the form.
  if (body.voice && typeof body.voice === "object") {
    const v = body.voice;
    const provider = v.provider === "elevenlabs" || v.provider === "google-live" ? v.provider : "";
    cfg.voice = {
      provider,
      providerId: typeof v.providerId === "string" ? v.providerId : cfg.voice?.providerId,
      apiKey: keepOrSet(v.apiKey, cfg.voice?.apiKey),
      agentId: typeof v.agentId === "string" ? v.agentId.trim() : cfg.voice?.agentId,
      whisperModel: cfg.voice?.whisperModel,
      whisperLang:
        typeof v.whisperLang === "string" && /^[a-z]{2,3}$/.test(v.whisperLang)
          ? v.whisperLang
          : cfg.voice?.whisperLang,
    };
  }

  // Channels (Telegram + Slack) — tokens + per-channel reply behaviour
  if (body.channels && typeof body.channels === "object") {
    const c = body.channels;
    cfg.channels = {
      telegramBotToken: keepOrSet(c.telegramBotToken, cfg.channels?.telegramBotToken),
      telegramWebhookSecret: keepOrSet(c.telegramWebhookSecret, cfg.channels?.telegramWebhookSecret),
      slackBotToken: keepOrSet(c.slackBotToken, cfg.channels?.slackBotToken),
      slackSigningSecret: keepOrSet(c.slackSigningSecret, cfg.channels?.slackSigningSecret),
      replies: sanitizeChannelReplies(c.replies, cfg.channels?.replies),
    };
  }

  // Appearance (persisted server-side too; client localStorage drives paint)
  if (body.theme === "light" || body.theme === "dark" || body.theme === "system") {
    cfg.theme = body.theme;
  }

  // Git tracking for data/record. Default is ignored. Enabling is dangerous for
  // public forks, so the client must send an explicit confirmation bit.
  if (typeof body.recordInAppRepo === "boolean") {
    if (body.recordInAppRepo && body.recordInAppRepoPrivateConfirmed !== true) {
      return NextResponse.json(
        { error: "Confirm that this repository is private before tracking data/record." },
        { status: 400 },
      );
    }
    if (recordInAppRepoEnabled() !== body.recordInAppRepo) {
      try {
        setRecordInAppRepoEnabled(body.recordInAppRepo);
      } catch {
        return NextResponse.json({ error: "Could not update .gitignore." }, { status: 500 });
      }
    }
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

import type { AppConfig } from "../config";
import { netFetch, type ImporterContext, type ImporterPlugin, type ImporterResult } from "./plugin";

/** The plugin id — also the key of its OAuth grant and its own app-key slot. */
export const GMAIL_SEND_ID = "gmail_send";

/** Send mail as the user. Cannot read a single message. */
export const SCOPE_GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
/** Read access — asked for ONLY when "capture replies" is ticked (same scope and
 *  same reasoning as SCOPE_GMAIL in google.ts: `gmail.metadata` forbids `q`). */
export const SCOPE_GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";

/** The scope is a function of config, in two opt-in steps: send-only by default,
 *  plus read when the user asked for replies. Unticking drops it on the next authorize. */
export function gmailSendScopes(cfg: AppConfig | null): string {
  return cfg?.email?.captureReplies ? `${SCOPE_GMAIL_SEND} ${SCOPE_GMAIL_READ}` : SCOPE_GMAIL_SEND;
}

/**
 * Gmail as a MAIL TRANSPORT — data going OUT, not a data source. Like
 * `gdrive_backup`, it rides the importer-plugin contract for one thing only: the
 * credential machinery (the OAuth dance, token refresh, `source authorize`,
 * `source test`). It never appears in the Pipeline, never lands a row in the
 * record and has no sync cadence (`mailTransport` keeps it out of SOURCE_PLUGINS).
 *
 * The send lives in src/lib/mail.ts (`sendMail`), its face is Settings →
 * Channels → Email / `agentqs mail`. It is its OWN grant and deliberately NOT a
 * checkbox on the Google card: that tree (google.ts) is what Google brings IN, and
 * the Gmail importer there only ever counts messages. Sending as you is a
 * different permission with a different blast radius, so it asks separately.
 */
export const gmailSendPlugin: ImporterPlugin = {
  id: GMAIL_SEND_ID,
  name: "Gmail (send)",
  detail: "outbound email through your Google account",
  live: true,
  mailTransport: true,
  requiresCredential: true,
  credentialLabel: "OAuth access token",
  credentialPlaceholder: "ya29.… (OAuth access token)",
  credentialHelp: {
    url: "https://console.cloud.google.com/apis/credentials",
    steps: [
      "In Google Cloud Console, enable the Gmail API (reuse the project you made for Calendar or Drive).",
      "On the OAuth consent screen, add the `.../auth/gmail.send` scope (and `.../auth/gmail.readonly` if you want replies captured) and your own account as a test user.",
      "Credentials → OAuth client ID → Web application, with the Redirect URI shown here (the same client works for every Google connection).",
      "In Settings → Channels → Email pick Google and press Authorize — an existing Google key is reused, nothing is pasted twice.",
    ],
  },
  oauth: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: SCOPE_GMAIL_SEND,
    scopeFor: gmailSendScopes,
    tokenAuth: "body",
    // offline + consent → Google actually returns a refresh token, every time.
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  /** `gmail.send` can call nothing but send, so the only side-effect-free proof is
   *  asking Google what the token is good for. */
  async probe(ctx: ImporterContext): Promise<string> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const res = await netFetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(ctx.credential ?? "")}`,
      {},
      fetchImpl,
    );
    if (!res.ok) throw new Error(`Google tokeninfo → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const info = (await res.json()) as { scope?: string };
    const scopes = (info.scope ?? "").split(/\s+/);
    if (!scopes.includes(SCOPE_GMAIL_SEND)) throw new Error("The token is valid but was not granted gmail.send — authorize again.");
    return scopes.includes(SCOPE_GMAIL_READ) ? "Gmail can send and read replies" : "Gmail can send (send-only)";
  },
  /** A mail transport is never synced as a source — `sendMail()` runs it. The throw
   *  is the guard rail: no path may quietly treat outbound mail as captured data. */
  async fetch(): Promise<ImporterResult> {
    throw new Error(
      "Gmail (send) is a mail transport, not a data source — send with `agentqs mail test --to <address>` " +
        '(API: POST /api/mail {"action":"test","to":"…"}).',
    );
  },
};

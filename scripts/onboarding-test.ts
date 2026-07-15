#!/usr/bin/env tsx
/**
 * Onboarding-structure proof — the checklist is DERIVED from live state, and
 * every step carries the exact call for at least one face:
 *
 *   fresh store → setup undone, nextStep=setup; config lands → setup done,
 *   nextStep=api_key; key + capture + source + schedule + backups land → each
 *   flips in turn; every step names a cli or api call (an agent can always
 *   act); the CLI OAuth authorize face builds a real provider URL and stashes
 *   the state nonce like the web form does.
 *
 * Deterministic, no network. Run: npm run onboarding:test
 */
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-onboard-"));
process.env.AGENTQS_DATA_DIR = root;

import { onboardingGuide } from "../src/lib/onboarding";
import { backupStatus, sourceAuthorize } from "../src/lib/cli-core";
import { readConfig, writeConfig, type AppConfig } from "../src/lib/config";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

async function main() {
  console.log("\nfresh store:");
  let g = onboardingGuide();
  check("setup is the next step", g.nextStep === "setup" && g.steps[0].done === false);
  check(
    "every step names a cli or api call",
    g.steps.every((s) => Boolean(s.cli || s.api)),
    g.steps.filter((s) => !s.cli && !s.api).map((s) => s.id).join(","),
  );
  check("migrate is optional (done: null), never blocks", g.steps.find((s) => s.id === "migrate")?.done === null);

  console.log("\nsteps flip as real state lands:");
  writeConfig({
    username: "t",
    passwordHash: "x",
    sessionSecret: "s",
    theme: "system",
    createdAt: new Date().toISOString(),
  } as AppConfig);
  g = onboardingGuide();
  check("config lands → setup done, next is api_key", g.steps[0].done === true && g.nextStep === "api_key");

  const cfg = readConfig()!;
  cfg.apiKey = "aqs_test";
  cfg.sourceCreds = { rescuetime: "key" };
  cfg.sourceIntervals = { rescuetime: "daily" };
  cfg.backup = { passphrase: "pass-123", github: { remote: "https://github.com/t/r.git" } };
  writeConfig(cfg);
  fs.mkdirSync(path.join(root, "record"), { recursive: true });
  fs.writeFileSync(path.join(root, "record", "inbox.jsonl"), `{"id":"a","text":"hi"}\n`);
  g = onboardingGuide();
  const done = Object.fromEntries(g.steps.map((s) => [s.id, s.done]));
  check("api_key / capture / sources / schedule / github flip to done",
    done.api_key === true && done.capture === true && done.connect_sources === true &&
      done.schedule === true && done.backup_github === true);
  check("drive still undone (no grant) → nextStep=backup_drive", g.nextStep === "backup_drive");

  const c2 = readConfig()!;
  c2.sourceOAuth = { gdrive_backup: { clientId: "c", clientSecret: "s", refreshToken: "r" } };
  c2.channels = { slackBotToken: "xoxb-1" };
  writeConfig(c2);
  g = onboardingGuide();
  check("grant + passphrase → drive done; channels done; all set", g.nextStep === null);

  // A BACKUP credential is not a connected DATA source — in EITHER storage
  // flavor. Asserting it while rescuetime is also connected proves nothing (the
  // step is true either way), so strip the store down to the backup credential
  // alone: connect_sources must go UNDONE.
  console.log("\na backup credential never counts as a connected data source:");
  for (const flavor of ["pasted token", "oauth grant"] as const) {
    const c3 = readConfig()!;
    c3.sourceCreds = flavor === "pasted token" ? { gdrive_backup: "ya29.pasted" } : {};
    c3.sourceOAuth = flavor === "oauth grant" ? { gdrive_backup: { clientId: "c", clientSecret: "s", refreshToken: "r" } } : {};
    writeConfig(c3);
    g = onboardingGuide();
    const step = (id: string) => g.steps.find((s) => s.id === id)?.done;
    check(`Drive (${flavor}) is the ONLY credential → connect_sources UNDONE`, step("connect_sources") === false);
    check(`…and it still counts as the BACKUP being connected (${flavor})`, step("backup_drive") === true);
    check(
      `…agreeing with backupStatus().drive.connected (${flavor})`,
      backupStatus().drive.connected === true,
    );
  }
  // Put the real source back so the rest of the run sees a normal store.
  const c4 = readConfig()!;
  c4.sourceCreds = { rescuetime: "key" };
  c4.sourceOAuth = { gdrive_backup: { clientId: "c", clientSecret: "s", refreshToken: "r" } };
  writeConfig(c4);
  g = onboardingGuide();
  check("a real source alongside the backup → connect_sources done again",
    g.steps.find((s) => s.id === "connect_sources")?.done === true);

  console.log("\nCLI OAuth authorize face:");
  const auth = sourceAuthorize("gdrive_backup", "cid", "csec", "http://127.0.0.1:3106/");
  check(
    "builds the provider URL with the right scope",
    auth.authorizeUrl.startsWith("https://accounts.google.com") && decodeURIComponent(auth.authorizeUrl).includes("drive.file"),
  );
  check("redirect URI is the app callback (trailing slash trimmed)", auth.redirectUri === "http://127.0.0.1:3106/api/oauth/callback");
  check("state stashed like the web form", Boolean(readConfig()?.oauthPending?.state));
  // A key was saved above, so signing in again needs NO re-entry — empty creds reuse it.
  const reAuth = sourceAuthorize("gdrive_backup", "", "");
  check("re-login reuses the saved app key (no client id/secret re-entry)", reAuth.authorizeUrl.startsWith("https://accounts.google.com"));
  // But a source that never had a key saved refuses with a clear message.
  let rejected = false;
  try {
    sourceAuthorize("strava", "", "");
  } catch {
    rejected = true;
  }
  check("a source with no saved key refuses loudly", rejected);

  fs.rmSync(root, { recursive: true, force: true });
  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("\n✓ onboarding: live-derived checklist, every step actionable on some face, CLI authorize = the web dance.\n");
}

void main();

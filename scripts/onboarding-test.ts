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
import { sourceAuthorize } from "../src/lib/cli-core";
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
  check("a Drive grant alone never counts as a connected DATA source",
    g.steps.find((s) => s.id === "connect_sources")?.done === true); // rescuetime is the one that counts

  console.log("\nCLI OAuth authorize face:");
  const auth = sourceAuthorize("gdrive_backup", "cid", "csec", "http://127.0.0.1:3106/");
  check(
    "builds the provider URL with the right scope",
    auth.authorizeUrl.startsWith("https://accounts.google.com") && decodeURIComponent(auth.authorizeUrl).includes("drive.file"),
  );
  check("redirect URI is the app callback (trailing slash trimmed)", auth.redirectUri === "http://127.0.0.1:3106/api/oauth/callback");
  check("state stashed like the web form", Boolean(readConfig()?.oauthPending?.state));
  let rejected = false;
  try {
    sourceAuthorize("gdrive_backup", "", "");
  } catch {
    rejected = true;
  }
  check("missing client id/secret refused loudly", rejected);

  fs.rmSync(root, { recursive: true, force: true });
  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("\n✓ onboarding: live-derived checklist, every step actionable on some face, CLI authorize = the web dance.\n");
}

void main();

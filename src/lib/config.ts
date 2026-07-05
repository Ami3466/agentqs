import fs from "fs";
import { configPath, dataDir } from "./paths";

/**
 * On-disk config, the first thing agentqs writes. Its presence is the "has this
 * instance been set up?" signal that drives the first-run redirect.
 */
export interface AppConfig {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  llmProvider: string; // "" | anthropic | openai | google
  llmKey: string;
  model: string;
  theme: string; // light | dark | system
  createdAt: string;
}

export function configExists(): boolean {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

export function readConfig(): AppConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as AppConfig;
  } catch {
    return null;
  }
}

export function writeConfig(cfg: AppConfig): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** Secret used to sign sessions — env override wins, else the per-instance one. */
export function sessionSecretFor(cfg: AppConfig): string {
  return process.env.SESSION_SECRET || cfg.sessionSecret;
}

/** Safe projection for the client — no password hash, no raw key. */
export interface PublicConfig {
  username: string;
  llmProvider: string;
  hasLlmKey: string; // masked tail, or ""
  model: string;
  theme: string;
  dataDir: string;
  createdAt: string;
}

export function publicConfig(cfg: AppConfig): PublicConfig {
  const key = cfg.llmKey || "";
  return {
    username: cfg.username,
    llmProvider: cfg.llmProvider,
    hasLlmKey: key ? `••••••••${key.slice(-4)}` : "",
    model: cfg.model,
    theme: cfg.theme,
    dataDir: dataDir(),
    createdAt: cfg.createdAt,
  };
}

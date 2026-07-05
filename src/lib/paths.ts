import path from "path";

/**
 * Resolved data directory where agentqs writes config, the git record, and the
 * SQLite cache. Local default: ./data · Docker default: /data (set in the image).
 */
export function dataDir(): string {
  const dir = process.env.AGENTQS_DATA_DIR || path.join(process.cwd(), "data");
  return path.resolve(dir);
}

export function configPath(): string {
  return path.join(dataDir(), "config.json");
}

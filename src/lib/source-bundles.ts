import fs from "fs";
import path from "path";
import { GOOGLE_PRESET_DAILY_SOURCES } from "./google-web-scraper";

export interface SourceBundle {
  id: string;
  name: string;
  detail: string;
  sourceIds(dir: string): string[];
}

function dailyCsvIds(dir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dir, "daily"))
      .filter((f) => f.toLowerCase().endsWith(".csv"))
      .map((f) => f.slice(0, -4))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

export const SOURCE_BUNDLES: SourceBundle[] = [
  {
    // Google archive imports (Takeout / Timeline export / lifetime scripts).
    // The Chrome-extension scrape sources (GOOGLE_PRESET_DAILY_SOURCES) are NOT
    // part of this bundle — the Data tab's Google card manages those per preset.
    id: "google_takeout",
    name: "Google archive",
    detail: "Google Takeout / archive imports",
    sourceIds: (dir) =>
      dailyCsvIds(dir).filter(
        (id) => id.startsWith("google_") && !GOOGLE_PRESET_DAILY_SOURCES.has(id),
      ),
  },
];

export function sourceBundleById(id: string): SourceBundle | undefined {
  return SOURCE_BUNDLES.find((bundle) => bundle.id === id);
}

#!/usr/bin/env tsx
/**
 * Ships-when proof for the Settings switches: embedding on/off, auto-index on/off,
 * and auto-structure. Drives the SAME modules the app's routes import (no mocks):
 *
 *   1. Defaults — embeddings + auto-index on, auto-structure off (today's behaviour).
 *   2. Embedding off  → semanticSearch returns [] (recall/search fall back to keywords).
 *   3. Auto-index off → a stale record is NOT rebuilt by ensureIndex/search; the
 *      explicit buildIndex (the "Reindex now" button) still refreshes it.
 *   4. Auto-structure off → a new capture stays pending. On → the same capture merges
 *      straight into the daily table, skipping the pending inbox. With no AI key a
 *      prose capture degrades gracefully: it just stays pending.
 *
 * Run: npm run flags:test
 */
import fs from "fs";
import os from "os";
import path from "path";

// Isolated data dir + the deterministic hash embedder (offline, same code path).
process.env.AGENTQS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-flags-"));
process.env.AGENTQS_EMBED_BACKEND = "hash";

import {
  autoIndexEnabled,
  autoStructureEnabled,
  embeddingEnabled,
  readConfig,
  writeConfig,
  type AppConfig,
} from "../src/lib/config";
import { recordDir } from "../src/lib/paths";
import { appendInboxItem, readRecord, rebuild } from "../src/lib/record";
import { buildIndex, ensureIndex, indexStatus, semanticSearch } from "../src/lib/embeddings";
import { autoStructureNewItem } from "../src/lib/structure-run";
import { importRaw } from "../src/lib/cli-core";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const base: AppConfig = {
  username: "flags-test",
  passwordHash: "x",
  sessionSecret: "s",
  theme: "dark",
  createdAt: new Date().toISOString(),
};

function status(id: string): string {
  return readRecord(recordDir()).inbox.find((i) => i.id === id)?.status ?? "missing";
}

async function main() {
  writeConfig(base);
  appendInboxItem({ text: "Felt anxious and stressed before the deadline", source: "memo" });
  appendInboxItem({ text: "Calm morning, slept well", source: "memo" });
  rebuild();

  console.log("1. Defaults match today's behaviour");
  check("embeddings default on", embeddingEnabled(readConfig()));
  check("auto-index defaults on", autoIndexEnabled(readConfig()));
  check("auto-structure defaults off", !autoStructureEnabled(readConfig()));
  const hits = await semanticSearch("wired, couldn't switch off", { limit: 3 });
  check("search auto-builds the index and matches", hits.length > 0);
  check("index reports built", (await indexStatus()).built);

  console.log("2. Embedding checkbox off → no vectors");
  writeConfig({ ...base, embedding: { mode: "local", enabled: false } });
  check("semanticSearch returns [] when embeddings are off", (await semanticSearch("anxious", { limit: 3 })).length === 0);
  check("ensureIndex is a no-op when embeddings are off", (await ensureIndex()) === null);

  console.log("3. Auto-index off → stale index stays until an explicit reindex");
  writeConfig({ ...base, embedding: { mode: "local", enabled: true, autoIndex: false } });
  appendInboxItem({ text: "New memo that makes the index stale", source: "memo" });
  rebuild();
  check("record change marks the index stale", (await indexStatus()).stale);
  check("ensureIndex skips the rebuild", (await ensureIndex()) === null);
  const staleHits = await semanticSearch("anxious and stressed", { limit: 3 });
  check("search still answers from the existing index", staleHits.length > 0);
  check("…without rebuilding it", (await indexStatus()).stale);
  const rebuilt = await buildIndex();
  check("explicit Reindex still rebuilds", rebuilt.count === 3 && !(await indexStatus()).stale);

  console.log("4. Auto-structure: off = pending, on = straight to daily");
  const csv = "date,mood\n2026-07-01,7\n2026-07-02,6";
  const kept = appendInboxItem({ text: csv, source: "memo", kind: "text" });
  rebuild();
  check("toggle off → helper is a no-op", (await autoStructureNewItem(kept.id)) === null);
  check("capture stays pending", status(kept.id) === "pending");

  writeConfig({ ...base, autoStructure: true });
  const auto = appendInboxItem({ text: csv, source: "memo", kind: "text" });
  rebuild();
  const run = await autoStructureNewItem(auto.id);
  check("toggle on → capture is structured immediately", run?.structured === 1);
  check("capture skipped the pending inbox", status(auto.id) === "structured");
  check("daily rows landed", (run?.dailyRows ?? 0) > 0);

  const prose = await importRaw({ text: "Slept badly, felt foggy all day.", name: "note.txt" });
  check("prose with no AI key degrades to pending (no crash)", !prose.structured && status(prose.inboxId) === "pending");

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  fs.rmSync(process.env.AGENTQS_DATA_DIR!, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

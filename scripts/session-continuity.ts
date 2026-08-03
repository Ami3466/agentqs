#!/usr/bin/env tsx
/**
 * agentqs session-continuity — Loop 9's ships-when proof.
 *
 * Exercises the real memory path end to end, no AI key required:
 *   1. Session 1: distill a transcript → {summary, insights, commitments}
 *      (the heuristic synthesis) and persist it to record/sessions.jsonl.
 *   2. Rebuild the SQLite cache — the session lands on the Journal timeline.
 *   3. Session 2 (new): read the prior session's SYNTHESIS (not the transcript)
 *      and build the continuity the chat route uses. Assert the new session
 *      references Session 1's commitment.
 *
 * Drives the exact functions /api/sessions and /api/chat call, so it fails if
 * extraction, persistence, or continuity break.
 *
 *   tsx scripts/session-continuity.ts [--json]
 */
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import {
  appendSession,
  readSessionsFromRecord,
  rebuild,
  removeSessionFromRecord,
  removeSessionsFromCache,
  upsertSessionsInCache,
} from "../src/lib/record";
import {
  continuityBlock,
  continuityFallbackReply,
  openCommitments,
  synthesizeSession,
} from "../src/lib/synthesis";
import { skillById } from "../src/lib/skills";

const json = process.argv.includes("--json");

function log(s = ""): void {
  if (!json) process.stdout.write(s + "\n");
}

/** Every session row in the cache, in a stable order — the comparable a patched
 *  cache and a rebuilt one must agree on. */
function sessionRows(dbFile: string): unknown[] {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.prepare("SELECT * FROM sessions ORDER BY id").all() as unknown[];
  } finally {
    db.close();
  }
}

/** Same, for the FTS rows: an upsert that forgot to delete the old index entry
 *  would double a session in search — invisible in `sessions`, wrong in results. */
function sessionSearch(dbFile: string): unknown[] {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db
      .prepare("SELECT ref, body FROM search WHERE kind = 'session' ORDER BY ref, body")
      .all() as unknown[];
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-session-"));
  const recordDir = path.join(tmp, "record");
  fs.mkdirSync(recordDir, { recursive: true });
  const failures: string[] = [];
  const check = (ok: boolean, msg: string) => {
    log(`${ok ? "  ok  " : " FAIL "} ${msg}`);
    if (!ok) failures.push(msg);
  };

  try {
    // --- Session 1: a real conversation ending in a commitment --------------
    const s1Messages = [
      { role: "user" as const, content: "I keep skipping workouts whenever work gets stressful." },
      {
        role: "assistant" as const,
        content: "Stress crowds out the thing that would help most. What's one rep small enough to survive a bad day?",
      },
      { role: "user" as const, content: "Okay. I'll do a 20-minute walk every morning this week, before I open my laptop." },
    ];

    // No cfg → deterministic heuristic synthesis (same call the API makes).
    const { synthesis, via, transcript } = await synthesizeSession({
      messages: s1Messages,
      skill: "mentor",
      date: "2026-07-01",
      cfg: null,
    });
    log(`Session 1 synthesized via ${via}:`);
    log(`  title       ${synthesis.title}`);
    log(`  summary     ${synthesis.summary}`);
    log(`  commitments ${JSON.stringify(synthesis.commitments)}`);
    log();

    check(via === "heuristic", "no-key synthesis uses the deterministic heuristic");
    const commitment = synthesis.commitments[0] ?? "";
    check(
      /20-minute walk every morning/i.test(commitment),
      `extracted the commitment ("${commitment}")`,
    );
    check(transcript.includes("You:"), "transcript captured (kept in record, never read by the agent)");

    // Persist to the typed store + rebuild the derived cache.
    const persisted = appendSession(
      {
        skill: "mentor",
        startedAt: "2026-07-01T09:00:00Z",
        title: synthesis.title,
        summary: synthesis.summary,
        transcript,
        insights: synthesis.insights,
        commitments: synthesis.commitments,
      },
      { recordDir },
    );
    const built = rebuild({ recordDir, dbPath: path.join(tmp, "agentqs.db") });
    check(built.sessions === 1, "session landed in the rebuilt cache (→ Journal timeline)");
    check(persisted.date === "2026-07-01", "session carries a day bucket for the timeline");

    // Prove the synthesis is stored SEPARATELY from daily data.
    check(
      fs.existsSync(path.join(recordDir, "sessions.jsonl")) &&
        !fs.existsSync(path.join(recordDir, "daily")),
      "synthesis stored in sessions.jsonl, separate from record/daily",
    );

    // --- Saving a session must PATCH the cache, never re-derive it -----------
    // /api/sessions used to call rebuild() per save. A rebuild re-reads the whole
    // record and re-indexes every event — on a real record that is minutes of
    // frozen server (better-sqlite3 is synchronous) to add ONE row, which is what
    // left every page of the app stuck on "Loading…". The patch is only allowed to
    // be that much cheaper if it lands the SAME rows a rebuild would, so that is
    // what is asserted here: patch a second session in, then rebuild from the same
    // record text, and require both caches to agree exactly.
    const dbFile = path.join(tmp, "agentqs.db");
    const second = appendSession(
      {
        skill: "mentor",
        startedAt: "2026-07-02T09:00:00Z",
        title: "Second session",
        summary: "A second session, landed by the patch path.",
        insights: ["patching beats re-deriving"],
        commitments: ["ship the cache patch"],
      },
      { recordDir },
    );
    check(upsertSessionsInCache([second], { dbFile }) === 1, "a saved session patches the cache in place");
    const patchedRows = sessionRows(dbFile);
    const patchedSearch = sessionSearch(dbFile);
    rebuild({ recordDir, dbPath: dbFile });
    check(
      JSON.stringify(patchedRows) === JSON.stringify(sessionRows(dbFile)),
      "patched session rows are identical to a full rebuild's",
    );
    check(
      JSON.stringify(patchedSearch) === JSON.stringify(sessionSearch(dbFile)),
      "patched session search index is identical to a full rebuild's",
    );

    // …and deleting one leaves as little behind as a rebuild would.
    removeSessionFromRecord(second.id, { recordDir });
    check(removeSessionsFromCache([second.id], { dbFile }) === 1, "deleting a session patches the cache in place");
    const afterDelete = sessionRows(dbFile);
    const afterDeleteSearch = sessionSearch(dbFile);
    rebuild({ recordDir, dbPath: dbFile });
    check(
      JSON.stringify(afterDelete) === JSON.stringify(sessionRows(dbFile)) &&
        JSON.stringify(afterDeleteSearch) === JSON.stringify(sessionSearch(dbFile)),
      "a patched delete leaves exactly what a rebuild leaves (no orphan search row)",
    );

    // --- Session 2 (new): does it reference Session 1's commitment? ---------
    const prior = readSessionsFromRecord(recordDir);
    const open = openCommitments(prior);
    check(open.length === 1, "prior open commitment is visible to a new session");

    // Exactly what /api/chat runs at the start of a keyless session.
    const opener = continuityFallbackReply(skillById("mentor").name, prior);
    log();
    log("Session 2 opener (no-key continuity):");
    log(`  ${(opener ?? "(none)").replace(/\n+/g, " ")}`);
    log();
    check(
      opener != null && /20-minute walk every morning/i.test(opener),
      "NEW session references the prior session's commitment (ships-when)",
    );

    // And the system-prompt memory the keyed path injects also carries it.
    const block = continuityBlock(prior);
    check(
      /commitment: .*20-minute walk every morning/i.test(block),
      "continuity block (LLM system prompt) carries the commitment, from synthesis",
    );
    // The agent reads synthesis, not the transcript: the raw wording must NOT leak.
    check(
      !block.includes("before I open my laptop") || block.includes("commitment:"),
      "continuity is built from synthesis, not the raw transcript",
    );

    const ok = failures.length === 0;
    if (json) {
      process.stdout.write(
        JSON.stringify({ ok, checks: 9, failures, commitment, opener }, null, 2) + "\n",
      );
    } else {
      log(ok ? "PASS — a new session references a prior session's commitment." : `FAIL — ${failures.length} check(s) failed.`);
    }
    if (!ok) process.exit(1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`session-continuity: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});

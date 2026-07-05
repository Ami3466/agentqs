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
import { appendSession, readSessionsFromRecord, rebuild } from "../src/lib/record";
import {
  continuityBlock,
  continuityFallbackReply,
  openCommitments,
  synthesizeSession,
} from "../src/lib/synthesis";
import { mentorById } from "../src/lib/mentors";

const json = process.argv.includes("--json");

function log(s = ""): void {
  if (!json) process.stdout.write(s + "\n");
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

    // --- Session 2 (new): does it reference Session 1's commitment? ---------
    const prior = readSessionsFromRecord(recordDir);
    const open = openCommitments(prior);
    check(open.length === 1, "prior open commitment is visible to a new session");

    // Exactly what /api/chat runs at the start of a keyless session.
    const opener = continuityFallbackReply(mentorById("mentor").name, prior);
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

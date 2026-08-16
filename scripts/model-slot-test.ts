#!/usr/bin/env tsx
/**
 * Ships-when proof for the idle model slot (src/lib/model-slot.ts) — the thing that
 * stops a loaded transformers.js pipeline from parking ~560MB of native memory in RSS
 * for the life of the process.
 *
 * Drives the REAL helper with an INJECTED fake loader: no weights, no network, no
 * onnxruntime, runs in under a second. What it proves:
 *
 *   1. warm  — N sequential calls load the model ONCE (no behaviour change).
 *   2. idle  — past the TTL the model is disposed EXACTLY once, and the next call
 *              reloads a fresh one and still returns the right answer.
 *   3. safe  — a model is NEVER disposed under an in-flight caller. This is the one
 *              way the change can crash production, so it is raced for real: the TTL
 *              is driven to 0 while a long call holds the slot and dozens of short
 *              calls churn the refcount around it, and release() is fired mid-call.
 *   4. exit  — the idle timer is unref'd, so a warm slot cannot keep a CLI process
 *              alive (asserted in a REAL child process, not by inspecting a handle).
 *
 * Run: npm run slot:test
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createModelSlot, modelIdleMs, DEFAULT_IDLE_MS } from "../src/lib/model-slot";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stands in for a transformers.js pipeline: expensive to make, and it publishes the
 *  same async `dispose()` the real pipelines do. `alive` is the tripwire — any call
 *  that sees alive=false was running on a model that had been freed under it. */
interface FakeModel {
  id: number;
  alive: boolean;
  disposeCalls: number;
  dispose(): Promise<void>;
}

function fakeLoader(loadMs = 0) {
  let n = 0;
  const made: FakeModel[] = [];
  const load = async (): Promise<FakeModel> => {
    if (loadMs) await sleep(loadMs);
    const m: FakeModel = {
      id: ++n,
      alive: true,
      disposeCalls: 0,
      async dispose() {
        this.disposeCalls++;
        this.alive = false;
      },
    };
    made.push(m);
    return m;
  };
  return { load, made, calls: () => n };
}

async function main() {
  console.log("\nThe idle model slot — real helper, injected fake loader (no model download)…\n");

  // ---- 0. The TTL knob ----------------------------------------------------
  delete process.env.AGENTQS_MODEL_IDLE_MS;
  check("default idle TTL is 5 minutes", modelIdleMs() === DEFAULT_IDLE_MS, `${DEFAULT_IDLE_MS}ms`);
  process.env.AGENTQS_MODEL_IDLE_MS = "1234";
  check("AGENTQS_MODEL_IDLE_MS overrides it", modelIdleMs() === 1234);
  process.env.AGENTQS_MODEL_IDLE_MS = "not-a-number";
  check("a junk TTL falls back to the default", modelIdleMs() === DEFAULT_IDLE_MS);
  delete process.env.AGENTQS_MODEL_IDLE_MS;

  // ---- 1. A warm slot is reused ------------------------------------------
  console.log("\n  Warm reuse — back-to-back calls must not reload…\n");
  const warm = fakeLoader();
  const warmSlot = createModelSlot<FakeModel>({ name: "warm", load: warm.load, idleMs: () => 60_000 });
  const ids: number[] = [];
  for (let i = 0; i < 8; i++) ids.push(await warmSlot.use(async (m) => m.id));
  check("8 sequential calls loaded the model once", warm.calls() === 1, `${warm.calls()} load(s)`);
  check("every call got the SAME instance", new Set(ids).size === 1, `ids ${[...new Set(ids)].join(",")}`);
  check("nothing was disposed while the TTL is far away", warm.made[0].disposeCalls === 0);
  check("the slot reports itself loaded and idle", warmSlot.stats().loaded && warmSlot.stats().refs === 0);
  await warmSlot.release();
  check("release() frees a warm idle slot", warm.made[0].alive === false && !warmSlot.stats().loaded);
  check("dispose ran exactly once", warm.made[0].disposeCalls === 1);
  await warmSlot.release();
  check("a second release() is a no-op (never disposes twice)", warm.made[0].disposeCalls === 1);

  // ---- 2. An idle slot past its TTL is evicted, then reloads --------------
  console.log("\n  Idle eviction — past the TTL the model is freed, the next call reloads…\n");
  const ttl = fakeLoader();
  const ttlSlot = createModelSlot<FakeModel>({ name: "ttl", load: ttl.load, idleMs: () => 25 });
  const firstAnswer = await ttlSlot.use(async (m) => `answer-from-${m.id}`);
  check("first call answered", firstAnswer === "answer-from-1", firstAnswer);
  check("still warm right after the call", ttlSlot.stats().loaded);
  await sleep(10);
  check("still warm INSIDE the TTL window", ttlSlot.stats().loaded);
  await sleep(60);
  check("evicted once the TTL elapsed", !ttlSlot.stats().loaded);
  check("the evicted model was disposed exactly once", ttl.made[0].disposeCalls === 1 && !ttl.made[0].alive);
  const secondAnswer = await ttlSlot.use(async (m) => `answer-from-${m.id}`);
  check("the next call reloaded a FRESH model", ttl.calls() === 2, `${ttl.calls()} loads`);
  check("…and still returns a correct result", secondAnswer === "answer-from-2", secondAnswer);
  check("the reloaded model is alive", ttl.made[1].alive === true);
  await ttlSlot.release();

  // ---- 3. THE CRASH CASE: never dispose under an in-flight caller ---------
  // TTL 0 means "evict the instant the refcount hits zero" — the most hostile setting
  // there is. A long caller holds the slot while short callers churn refs around it
  // and release() is fired mid-flight; the long caller must survive untouched.
  console.log("\n  The crash case — racing eviction against a live caller (TTL = 0)…\n");
  const race = fakeLoader(2);
  const raceSlot = createModelSlot<FakeModel>({ name: "race", load: race.load, idleMs: () => 0 });
  let sawDead = false; // any moment a live caller saw a freed model
  let heldModel: FakeModel | null = null;

  const long = raceSlot.use(async (m) => {
    heldModel = m;
    for (let i = 0; i < 40; i++) {
      if (!m.alive) sawDead = true; // it was freed UNDER us
      await sleep(3);
    }
    if (!m.alive) sawDead = true;
    return m.id;
  });

  await sleep(10); // let the long caller get hold of the model
  const churn: Promise<number>[] = [];
  for (let i = 0; i < 40; i++) {
    churn.push(
      raceSlot.use(async (m) => {
        if (!m.alive) sawDead = true;
        await sleep(1);
        if (!m.alive) sawDead = true;
        return m.id;
      }),
    );
    await sleep(2); // stagger so refs really does bounce 2→1→2, never 0
  }
  // Fire the explicit "drop it now" path while the long caller is still inside.
  await raceSlot.release();
  const disposedDuringFlight = race.made[0].disposeCalls;
  check("release() did NOT dispose while a caller was in flight", disposedDuringFlight === 0);
  check("the in-flight model is still alive mid-race", (heldModel as FakeModel | null)?.alive === true);

  const shortIds = await Promise.all(churn);
  const longId = await long;
  check("no caller EVER saw a disposed model", !sawDead);
  check("all 40 concurrent callers shared the one warm instance", new Set(shortIds).size === 1 && shortIds[0] === longId, `ids ${[...new Set(shortIds)].join(",")}`);
  check("only one load happened across the whole race", race.calls() === 1, `${race.calls()} load(s)`);
  await sleep(20);
  check("once the last caller left, the pending release freed it exactly once", race.made[0].disposeCalls === 1 && !race.made[0].alive);
  check("the slot is cold again", !raceSlot.stats().loaded);

  // A caller arriving right after an eviction gets a fresh, live model — the disposal
  // of the OLD generation must never touch the new one.
  const afterId = await raceSlot.use(async (m) => {
    if (!m.alive) sawDead = true;
    return m.id;
  });
  check("a call right after eviction reloads a live model", afterId === 2 && !sawDead && race.made[1].alive !== undefined);
  check("the old generation stayed disposed", race.made[0].disposeCalls === 1);
  await raceSlot.release();

  // ---- 3b. A failed load is not cached ------------------------------------
  let attempts = 0;
  const flaky = createModelSlot<FakeModel>({
    name: "flaky",
    idleMs: () => 60_000,
    load: async () => {
      attempts++;
      if (attempts === 1) throw new Error("weights missing");
      const m: FakeModel = {
        id: attempts,
        alive: true,
        disposeCalls: 0,
        async dispose() {
          m.disposeCalls++;
          m.alive = false;
        },
      };
      return m;
    },
  });
  let threw = "";
  try {
    await flaky.use(async () => "nope");
  } catch (e) {
    threw = (e as Error).message;
  }
  check("a failed load propagates to the caller", threw === "weights missing", threw);
  check("…and is not cached — the next call retries", (await flaky.use(async (m) => m.id)) === 2, `${attempts} attempts`);
  await flaky.release();

  // ---- 4. The idle timer must not keep the process alive ------------------
  // Asserted in a REAL child process: a warm slot with a 10-minute TTL. If the timer
  // is not unref'd, the child hangs for ten minutes instead of exiting.
  console.log("\n  Process exit — a warm slot must not hold the event loop open…\n");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-slot-"));
  const childFile = path.join(tmp, "child.ts");
  const slotModule = path.join(process.cwd(), "src", "lib", "model-slot.ts");
  fs.writeFileSync(
    childFile,
    `import { createModelSlot } from ${JSON.stringify(slotModule)};\n` +
      `const slot = createModelSlot<{ v: number }>({\n` +
      `  name: "child",\n` +
      `  idleMs: () => 600_000,\n` +
      `  load: async () => ({ v: 42 }),\n` +
      `});\n` +
      `void slot.use(async (m) => { console.log("used", m.v); });\n`,
  );
  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const started = Date.now();
  const exited = await new Promise<{ code: number | null; ms: number; out: string }>((resolve) => {
    const child = spawn(tsxBin, [childFile], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const kill = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("exit", (code) => {
      clearTimeout(kill);
      resolve({ code, ms: Date.now() - started, out: out.trim() });
    });
  });
  check("the child ran the slot", /used 42/.test(exited.out), exited.out.slice(0, 120));
  check(
    "a process with a warm slot exits on its own (timer is unref'd)",
    exited.code === 0 && exited.ms < 20_000,
    `exit ${exited.code} after ${exited.ms}ms`,
  );
  fs.rmSync(tmp, { recursive: true, force: true });

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log(
    "\n✓ The model slot ships: warm calls reuse one instance, an idle model is disposed once and reloads on demand, an in-flight caller is never freed under, and a warm slot never keeps the process alive.\n",
  );
}

void main();

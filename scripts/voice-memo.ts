#!/usr/bin/env tsx
/**
 * Ships-when proof for Loop 13 · Voice.
 *
 * "Recording a memo transcribes into the inbox." A voice memo is: record audio in
 * the browser → POST the bytes → the configured STT backend transcribes → the
 * transcript lands raw in the inbox, no LLM, exactly like a typed `>>` memo. This
 * proves the whole pipe end to end:
 *
 *   1. the pluggable STT contract (src/lib/voice.ts) — the SAME module the memo
 *      route imports — resolves the right backend from the environment (a
 *      WHISPER_BIN command first, then the built-in Whisper installed from
 *      Settings, then OpenAI Whisper on a key), the local backend actually runs
 *      the binary over the audio and returns its transcript, the built-in
 *      backend's WAV decoder handles real WAV (and rejects non-WAV clearly),
 *      and — on macOS — the built-in model transcribes REAL generated speech;
 *   2. over the built app's real routes: POST audio to /api/voice/memo with a
 *      local transcriber wired, and the transcript lands in the inbox as a raw
 *      `voice` memo (pending, no daily row, no LLM) with the pending count up one;
 *   3. the in-chat live voice session is config-gated: /api/voice/session reports
 *      disabled (with a setup reason) when no ElevenLabs key/agent is set.
 *
 * The transcriber itself is substituted with a tiny wrapper (like the GitHub test
 * substitutes the network) — everything else (form parsing, the STT dispatch, the
 * inbox write, the rebuild, the route) is the real production path, so this fails
 * if any of it breaks. Run: npm run voice:test  (needs `next build` first).
 */
import { spawn, spawnSync } from "child_process";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import {
  describeSession,
  describeStt,
  localWhisperBackend,
  resolveSttBackend,
} from "../src/lib/voice";
import { decodeWavToMono16k, transcribeWhisper } from "../src/lib/whisper-local";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, ms = 30000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status > 0) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > ms) throw new Error(`server did not come up at ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** A stand-in transcriber: reads the audio file it's handed and prints its bytes
 *  as UTF-8 — so if we "speak" a known phrase (send it as the audio body), a
 *  correct transcript comes back only when the full pipe delivered our bytes to
 *  the binary intact. Substitutes the acoustic model, nothing else. */
function writeStubWhisper(dir: string): string {
  const file = path.join(dir, "stub-whisper.js");
  fs.writeFileSync(
    file,
    [
      "const fs = require('fs');",
      "const p = process.argv[process.argv.length - 1];",
      "process.stdout.write(fs.readFileSync(p, 'utf8').trim());",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

/** Hand-built 16-bit PCM WAV of a 440 Hz sine — exercises the decoder's chunk
 *  parsing, stereo mixdown, and resampling without any audio tooling. */
function sineWav(rate: number, channels: number, seconds: number): Buffer {
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000);
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-voice-"));
  const stub = writeStubWhisper(root);
  const PHRASE = "remind me to call the plumber tomorrow morning";

  // ---- 1. The pluggable STT contract (pure, shared with the memo route) ----
  console.log("\nResolving the STT backend from the environment (the shared voice contract)…\n");
  check("no transcriber configured → not ready", describeStt({}).ready === false);
  check(
    "an OpenAI key → the OpenAI Whisper backend",
    resolveSttBackend({ openaiKey: "sk-test" })?.id === "openai",
  );
  const localEnv = { whisperBin: "node", whisperArgs: stub };
  const resolved = resolveSttBackend(localEnv);
  check("WHISPER_BIN wins → the local backend", resolved?.id === "local");
  check("describeStt reports ready + the local backend", describeStt(localEnv).ready && describeStt(localEnv).backend === "local");

  // The built-in Whisper (installed from Settings) sits between the two: an
  // explicit WHISPER_BIN still wins, but it beats the cloud fallback.
  check(
    "an installed built-in model → the whisper-local backend",
    resolveSttBackend({ whisperModel: "base" })?.id === "whisper-local",
  );
  check(
    "…which beats an OpenAI key",
    resolveSttBackend({ whisperModel: "base", openaiKey: "sk-test" })?.id === "whisper-local",
  );
  check(
    "…but loses to an explicit WHISPER_BIN",
    resolveSttBackend({ whisperBin: "node", whisperArgs: stub, whisperModel: "base" })?.id === "local",
  );

  // The WAV path the app mic sends: any-rate/any-channel WAV → mono 16 kHz PCM.
  const pcm = decodeWavToMono16k(sineWav(44100, 2, 0.5));
  check("WAV decode: stereo 44.1 kHz → mono 16 kHz PCM", Math.abs(pcm.length - 8000) < 20, `${pcm.length} samples`);
  let wavErr = "";
  try {
    decodeWavToMono16k(Buffer.from("not audio at all"));
  } catch (e) {
    wavErr = (e as Error).message;
  }
  check("non-WAV input → a clear setup-hint error", /WAV/.test(wavErr));

  // ---- 1b. The built-in Whisper transcribes REAL speech --------------------
  // macOS `say` generates spoken audio; the tiny model transcribes it on-device.
  // Uses the repo's data/models cache; skipped when the model isn't there unless
  // AGENTQS_WHISPER_E2E=1 opts into the one-time ~45 MB download.
  const repoModels = path.join(process.cwd(), "data", "models");
  const tinyOnDisk = fs.existsSync(path.join(repoModels, "Xenova", "whisper-tiny", "onnx"));
  if (process.platform === "darwin" && (tinyOnDisk || process.env.AGENTQS_WHISPER_E2E === "1")) {
    console.log("\nThe built-in local Whisper transcribes real speech (tiny model, on-device)…\n");
    process.env.AGENTQS_MODELS_DIR = repoModels;
    const aiff = path.join(root, "speech.aiff");
    const wavPath = path.join(root, "speech.wav");
    spawnSync("say", ["-o", aiff, "hello world, this is a local whisper test"]);
    spawnSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wavPath]);
    const spoken = (await transcribeWhisper(fs.readFileSync(wavPath), "tiny")).toLowerCase();
    check("built-in Whisper transcribed real speech", /hello world/.test(spoken), spoken.slice(0, 60));
  } else {
    console.log(
      "\n(skipped: real built-in Whisper transcription — needs macOS `say`; set AGENTQS_WHISPER_E2E=1 to allow the tiny-model download)\n",
    );
  }

  // The local backend really runs the binary over the audio and returns a transcript.
  const backend = localWhisperBackend("node", [stub]);
  const transcript = await backend.transcribe({ audio: Buffer.from(PHRASE, "utf8"), mime: "audio/webm" });
  check("local backend transcribes audio → text", transcript === PHRASE, transcript.slice(0, 40));

  // The live voice session is config-gated behind ElevenLabs env.
  console.log("\nThe in-chat live voice session is config-gated (ElevenLabs)…\n");
  check("no ElevenLabs env → session disabled", describeSession({}).enabled === false);
  check("disabled session names what to set", /ELEVENLABS_API_KEY/.test(describeSession({}).reason));
  check(
    "both ElevenLabs vars set → session enabled",
    describeSession({ elevenLabsKey: "k", elevenLabsAgentId: "a" }).enabled === true,
  );

  // ---- 2. End-to-end over the built app ------------------------------------
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nStarting the built app on ${base} (WHISPER_BIN=node ${path.basename(stub)}, data dir = ${root})…`);
  const server = spawn(process.execPath, [path.join(process.cwd(), ".next", "standalone", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      AGENTQS_DATA_DIR: root,
      // A fresh models dir — the real repo cache (set above for the say-check)
      // must not leak in, or "none installed" below would be false.
      AGENTQS_MODELS_DIR: path.join(root, "models"),
      SESSION_SECRET: "loop13-ships-when-secret",
      WHISPER_BIN: "node",
      WHISPER_ARGS: stub,
      // Ensure the OpenAI fallback isn't accidentally in play, and the session stays gated.
      OPENAI_API_KEY: "",
      ELEVENLABS_API_KEY: "",
      ELEVENLABS_AGENT_ID: "",
    },
    stdio: "ignore",
  });

  try {
    await waitFor(`${base}/login`);
    const setup = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "tester", password: "loop13pass", confirm: "loop13pass" }),
    });
    check("setup created the account (no AI key)", setup.ok);
    const cookie = ((setup.headers.get("set-cookie") || "").match(/agentqs_session=[^;]+/) || [""])[0];
    check("session cookie issued", Boolean(cookie));

    // Capability probe: a local transcriber is wired.
    const cap = await (await fetch(`${base}/api/voice/memo`, { headers: { cookie } })).json();
    check("/api/voice/memo reports STT ready (local)", cap.ready === true && cap.backend === "local", cap.label);

    // The Settings install surface: the built-in Whisper catalog, none active in
    // this fresh instance (its data dir has no models).
    const wst = await (await fetch(`${base}/api/voice/whisper`, { headers: { cookie } })).json();
    check(
      "/api/voice/whisper lists the installable models (none active)",
      Array.isArray(wst.models) && wst.models.length === 3 && wst.active === "" && wst.models.every((m: any) => !m.installed),
      wst.models?.map((m: any) => m.id).join(","),
    );
    const badInstall = await fetch(`${base}/api/voice/whisper`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ model: "gigantic" }),
    });
    check("installing an unknown model is rejected", badInstall.status === 400);

    // Record → transcribe → inbox. Send the phrase as the "audio" the mic would POST.
    console.log(`\n  recording a memo:  “${PHRASE}”\n`);
    const before = await (await fetch(`${base}/api/inbox`, { headers: { cookie } })).json();
    const form = new FormData();
    form.append("audio", new Blob([Buffer.from(PHRASE, "utf8")], { type: "audio/webm" }), "memo.webm");
    const post = await fetch(`${base}/api/voice/memo`, { method: "POST", headers: { cookie }, body: form });
    const posted = await post.json();
    check("POST /api/voice/memo transcribed the recording", post.ok && posted.text === PHRASE, posted.text || posted.error);
    check("it was transcribed by the local backend", posted.backend === "local");
    check("pending count went up by one", posted.pending === (before.pending ?? 0) + 1);

    // The transcript is in the inbox as a raw `voice` memo.
    const inbox = await (await fetch(`${base}/api/inbox`, { headers: { cookie } })).json();
    const landed = (inbox.items || []).find((i: any) => i.source === "voice" && i.text === PHRASE);
    check("the transcript landed in the inbox as a raw `voice` memo", Boolean(landed), landed?.kind);

    // No LLM ran: the memo stayed raw and never became a daily row.
    const daily = await (await fetch(`${base}/api/daily`, { headers: { cookie } })).json();
    const voiceSource = (daily.sources || []).some((s: any) => s.source === "voice");
    check("no LLM ran — the voice memo produced no daily row", !voiceSource);

    // The in-chat session route is config-gated in this (unconfigured) instance.
    const session = await (await fetch(`${base}/api/voice/session`, { headers: { cookie } })).json();
    check("/api/voice/session is config-gated (disabled)", session.enabled === false, session.reason);
  } finally {
    server.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log(
    "\n✓ Voice ships: recording a memo transcribes through the pluggable STT backend and lands raw in the inbox (no LLM), and the in-chat ElevenLabs voice session is config-gated.\n",
  );
}

void main();

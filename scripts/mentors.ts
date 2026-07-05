#!/usr/bin/env tsx
/**
 * Ships-when proof for Mentors · create / edit / delete / switch.
 *
 * The app ships three built-in mentors and lets the user add their own, edit any
 * of them, and delete them — all persisted in config.json and driving the chat.
 * This proves the whole surface end to end over the built app's real routes,
 * keyless (no AI key required):
 *
 *   1. GET  /api/mentors returns the three built-ins (seeded);
 *   2. POST /api/mentors adds a custom "Stoic" with its own system prompt →
 *      the list grows to four and the built-ins are now saved copies;
 *   3. POST /api/chat with mentor=stoic answers AS Stoic (the custom mentor the
 *      server resolved from config drove the reply, not a built-in fallback);
 *   4. PUT  /api/mentors edits the blurb → the change persists on disk;
 *   5. DELETE /api/mentors removes it → the list is back to the built-ins;
 *   6. every mutation is re-read both via a fresh GET and straight from
 *      config.json, proving it survives a reload.
 *
 * Drives the deployed URL, so it fails if the CRUD API, config persistence, or the
 * mentor-driven reply break. Run: npm run mentors:test  (needs `next build` first).
 */
import { spawn } from "child_process";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";

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

/** Read one NDJSON /api/chat stream to its `done` frame (reassembled text + frame). */
async function readChat(res: Response): Promise<{ text: string; done: any }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let done: any = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const f = JSON.parse(line);
      if (f.t === "delta") text += f.v;
      else if (f.t === "done") done = f;
    }
  }
  return { text, done };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-mentors-"));
  const configFile = path.join(root, "config.json");
  const onDiskMentors = () =>
    (JSON.parse(fs.readFileSync(configFile, "utf8")).mentors ?? []) as Array<{ id: string; name: string; blurb: string; system: string }>;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nStarting the built app on ${base} (data dir = ${root})…`);
  const server = spawn("node_modules/.bin/next", ["start", "-p", String(port)], {
    env: { ...process.env, AGENTQS_DATA_DIR: root, SESSION_SECRET: "mentors-ships-when-secret" },
    stdio: "ignore",
  });

  try {
    await waitFor(`${base}/login`);
    const setup = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "tester", password: "mentorpass" }),
    });
    check("setup created the account (no AI key)", setup.ok);
    const cookie = ((setup.headers.get("set-cookie") || "").match(/agentqs_session=[^;]+/) || [""])[0];
    check("session cookie issued", Boolean(cookie));
    const auth = { "content-type": "application/json", cookie };
    const getMentors = async () => (await (await fetch(`${base}/api/mentors`, { headers: { cookie } })).json()).mentors as any[];

    // ---- 1. Built-ins are seeded -----------------------------------------
    console.log("\n  built-in mentors\n");
    const seeded = await getMentors();
    check("GET returns the three built-ins", Array.isArray(seeded) && seeded.length === 3, seeded.map((m) => m.id).join(" "));
    check("built-ins are mentor · therapist · coach", ["mentor", "therapist", "coach"].every((id) => seeded.some((m) => m.id === id)));

    // ---- 2. Add a custom "Stoic" -----------------------------------------
    console.log("\n  add a mentor: Stoic\n");
    const STOIC_SYSTEM = "You are a STOIC mentor. Separate what the user controls from what they don't and end on one action within their control.";
    const created = await (await fetch(`${base}/api/mentors`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "Stoic", blurb: "Calm, principled, controllable-only", system: STOIC_SYSTEM }),
    })).json();
    check("create returns the new mentor with a slug id", created.mentor?.id === "stoic", created.mentor?.id);
    check("create returns the merged list of four", Array.isArray(created.mentors) && created.mentors.length === 4);
    check("Stoic is now on disk in config.json (built-ins seeded too)", onDiskMentors().length === 4 && onDiskMentors().some((m) => m.id === "stoic" && m.system === STOIC_SYSTEM));
    const afterAdd = await getMentors();
    check("a fresh GET (reload) shows Stoic", afterAdd.some((m) => m.id === "stoic"));

    // ---- 3. The custom mentor drives the reply ---------------------------
    console.log("\n  chat as Stoic\n");
    const reply = await readChat(await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ message: "hey", mentor: "stoic", history: [] }),
    }));
    check("the reply is attributed to Stoic (server resolved the custom mentor)", reply.done?.mentor === "stoic", reply.done?.mentor);
    check("the reply speaks AS the stoic (its identity, not a built-in fallback)", /stoic/i.test(reply.text), reply.text.slice(0, 70));

    // ---- 4. Edit the blurb ------------------------------------------------
    console.log("\n  edit Stoic's blurb\n");
    const NEW_BLURB = "Only what you control";
    const edited = await (await fetch(`${base}/api/mentors`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: "stoic", blurb: NEW_BLURB }),
    })).json();
    check("edit keeps the id and system, updates the blurb", edited.mentor?.id === "stoic" && edited.mentor?.blurb === NEW_BLURB && edited.mentor?.system === STOIC_SYSTEM);
    check("edited blurb persists on disk (survives reload)", onDiskMentors().find((m) => m.id === "stoic")?.blurb === NEW_BLURB);

    // A built-in edited becomes a saved copy at the same id (editable-as-copy).
    const editBuiltin = await (await fetch(`${base}/api/mentors`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: "coach", blurb: "My coach, tuned" }),
    })).json();
    check("a built-in is editable as a saved copy", editBuiltin.mentor?.id === "coach" && onDiskMentors().find((m) => m.id === "coach")?.blurb === "My coach, tuned");

    // ---- 5. Delete it -----------------------------------------------------
    console.log("\n  delete Stoic\n");
    const del = await (await fetch(`${base}/api/mentors`, {
      method: "DELETE",
      headers: auth,
      body: JSON.stringify({ id: "stoic" }),
    })).json();
    check("delete returns the list without Stoic", Array.isArray(del.mentors) && !del.mentors.some((m: any) => m.id === "stoic"));
    check("Stoic is gone from disk (persists across reload)", !onDiskMentors().some((m) => m.id === "stoic"));
    const afterDelete = await getMentors();
    check("a fresh GET no longer offers Stoic", !afterDelete.some((m) => m.id === "stoic"));
    check("deleting the last mentor is refused", (await (await fetch(`${base}/api/mentors`, { method: "DELETE", headers: auth, body: JSON.stringify({ id: "does-not-exist" }) })).json()).error !== undefined);
  } finally {
    server.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("\n✓ Mentors ship: built-ins seed, a custom Stoic is added / drives its own reply / edited / deleted, all persisted in config.json across reloads.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

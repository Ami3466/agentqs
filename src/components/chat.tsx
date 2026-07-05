"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Inbox, Send, Sparkles, Spinner, Terminal } from "@/components/icons";
import { Card, cn } from "@/components/ui";
import { DEFAULT_SKILL, SKILLS, skillById } from "@/lib/skills";

// ---- Smart-input model ----------------------------------------------------

type Mode = "chat" | "memo" | "command";

function modeOf(text: string): Mode {
  if (text.startsWith(">>")) return "memo";
  if (text.startsWith("/")) return "command";
  return "chat";
}

interface Command {
  cmd: string;
  desc: string;
}
const COMMANDS: Command[] = [
  { cmd: "/sync", desc: "Pull the latest from your connected sources" },
  { cmd: "/structure", desc: "Turn pending inbox items into daily data" },
  { cmd: "/new", desc: "Start a fresh session" },
  { cmd: "/skill", desc: "Switch persona — /skill mentor · therapist · coach" },
];

// ---- Messages -------------------------------------------------------------

type Role = "user" | "assistant" | "memo" | "note" | "recap";
interface Msg {
  id: string;
  role: Role;
  text: string;
  skill?: string; // persona that produced an assistant reply
  pending?: number; // memo: inbox count after saving
  tone?: "ok" | "error";
  session?: SavedSession; // recap: the synthesized session being viewed
  grounded?: boolean; // assistant reply cited the daily record
  sources?: string[]; // sources the grounded reply drew on
}

/** A persisted session's synthesis (from /api/sessions) — no raw transcript. */
interface SavedSession {
  id: string;
  date: string;
  startedAt: string;
  skill: string;
  title: string | null;
  summary: string | null;
  insights: string[];
  commitments: string[];
}

let seq = 0;
const nid = () => `m${Date.now().toString(36)}_${(seq++).toString(36)}`;

const SKILL_KEY = "agentqs.skill";

export function Chat() {
  const router = useRouter();
  const [skill, setSkill] = useState(DEFAULT_SKILL);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SavedSession[]>([]);
  const [saving, setSaving] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [skillOpen, setSkillOpen] = useState(false);
  const [hi, setHi] = useState(0); // highlighted command in the palette

  const skillRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const mode = modeOf(input);
  const activeSkill = skillById(skill);

  const filtered = useMemo(() => {
    if (mode !== "command") return [];
    const token = input.split(/\s+/)[0].toLowerCase();
    return COMMANDS.filter((c) => c.cmd.startsWith(token));
  }, [input, mode]);

  // Restore the last-used persona.
  useEffect(() => {
    const savedSkill = typeof window !== "undefined" ? window.localStorage.getItem(SKILL_KEY) : null;
    if (savedSkill && SKILLS.some((s) => s.id === savedSkill)) setSkill(savedSkill);
  }, []);

  // Load persisted sessions (the synthesis store) for the sidebar + memory hint.
  useEffect(() => {
    let alive = true;
    fetch("/api/sessions")
      .then((r) => (r.ok ? r.json() : { sessions: [] }))
      .then((d) => {
        if (alive && Array.isArray(d.sessions)) setSaved(d.sessions as SavedSession[]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Close the skill dropdown on outside click / Escape.
  useEffect(() => {
    if (!skillOpen) return;
    const onClick = (e: MouseEvent) => {
      if (skillRef.current && !skillRef.current.contains(e.target as Node)) setSkillOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setSkillOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [skillOpen]);

  // Keep the palette highlight in range as the filter narrows.
  useEffect(() => {
    setHi((h) => (filtered.length ? Math.min(h, filtered.length - 1) : 0));
  }, [filtered.length]);

  // Auto-scroll to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  function push(m: Omit<Msg, "id">) {
    setMessages((prev) => [...prev, { ...m, id: nid() }]);
  }

  function chooseSkill(id: string) {
    setSkill(id);
    setSkillOpen(false);
    if (typeof window !== "undefined") window.localStorage.setItem(SKILL_KEY, id);
    inputRef.current?.focus();
  }

  /** Distill + persist the current conversation to the session store, then land
   * it in the sidebar. No-op (returns false) when there's nothing to save. */
  async function persistCurrent(): Promise<boolean> {
    const convo = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.text }));
    if (!convo.some((m) => m.role === "user")) return false;
    setSaving(true);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: convo, skill }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.session) {
        setSaved((ss) => [data.session as SavedSession, ...ss]);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function newSession() {
    if (saving) return;
    await persistCurrent();
    setMessages([]);
    setViewingId(null);
    setInput("");
    inputRef.current?.focus();
  }

  /** Show a persisted session's synthesis (what the agent remembers) — a recap,
   * not the raw transcript. Continuing from here starts a fresh conversation. */
  function openSaved(s: SavedSession) {
    setViewingId(s.id);
    setSkill(SKILLS.some((k) => k.id === s.skill) ? s.skill : skill);
    setMessages([{ id: nid(), role: "recap", text: "", session: s }]);
  }

  // ---- Submit paths -------------------------------------------------------

  async function sendMemo(raw: string) {
    const text = raw.replace(/^>>\s*/, "").trim();
    if (!text) {
      push({ role: "note", tone: "error", text: "A memo needs some text after >>." });
      return;
    }
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, source: "memo" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        push({ role: "note", tone: "error", text: data.error || "Could not save that memo." });
      } else {
        push({ role: "memo", text, pending: data.pending });
      }
    } catch {
      push({ role: "note", tone: "error", text: "Could not reach the inbox." });
    } finally {
      setBusy(false);
    }
  }

  async function runCommand(raw: string) {
    const parts = raw.slice(1).trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    setInput("");

    if (cmd === "new") {
      void newSession();
      return;
    }
    if (cmd === "skill") {
      const target = args[0]?.toLowerCase();
      if (target && SKILLS.some((s) => s.id === target)) {
        chooseSkill(target);
        push({ role: "note", tone: "ok", text: `Switched to ${skillById(target).name}.` });
      } else {
        push({ role: "note", text: `Pick a persona: ${SKILLS.map((s) => s.id).join(" · ")}` });
      }
      return;
    }
    if (cmd === "structure") {
      push({ role: "note", text: "Structuring runs from the Data tab inbox — opening it." });
      router.push("/data");
      return;
    }
    if (cmd === "sync") {
      push({ role: "note", text: "Syncing GitHub…" });
      setBusy(true);
      try {
        const res = await fetch("/api/import/github", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args[0] ? { login: args[0] } : {}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          push({ role: "note", tone: "error", text: data.error || "Sync failed." });
        } else {
          push({
            role: "note",
            tone: "ok",
            text: `Synced @${data.login}: ${data.commits} commits → ${data.dailyRows} daily rows.`,
          });
        }
      } catch {
        push({ role: "note", tone: "error", text: "Could not reach the sync endpoint." });
      } finally {
        setBusy(false);
      }
      return;
    }
    push({ role: "note", tone: "error", text: `Unknown command "/${cmd}". Try ${COMMANDS.map((c) => c.cmd).join(" · ")}.` });
  }

  async function sendChat(raw: string) {
    const text = raw.trim();
    const history = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.text }));
    push({ role: "user", text });
    setViewingId(null);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, skill, history }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        push({ role: "note", tone: "error", text: data.error || "The model didn't answer." });
      } else {
        push({
          role: "assistant",
          text: data.reply,
          skill: data.skill,
          grounded: Boolean(data.grounded),
          sources: Array.isArray(data.sources) ? data.sources : undefined,
        });
      }
    } catch {
      push({ role: "note", tone: "error", text: "Could not reach the mentor." });
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    const raw = input;
    if (!raw.trim() || busy) return;
    const m = modeOf(raw);
    if (m === "memo") void sendMemo(raw);
    else if (m === "command") void runCommand(raw);
    else void sendChat(raw);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    // Command palette navigation.
    if (mode === "command" && filtered.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHi((h) => (h + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHi((h) => (h - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        setInput(`${filtered[hi].cmd} `);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // In command mode, if the typed token isn't a full command yet, run the highlighted one.
      if (mode === "command") {
        const token = input.split(/\s+/)[0].toLowerCase();
        const exact = COMMANDS.some((c) => c.cmd === token);
        if (!exact && filtered.length) {
          void runCommand(filtered[hi].cmd);
          return;
        }
      }
      submit();
    }
  }

  const placeholder =
    mode === "memo"
      ? "Memo — saved to your inbox, no reply"
      : mode === "command"
        ? "Command — /sync · /structure · /new · /skill"
        : `Message your ${activeSkill.name.toLowerCase()}…  ( >> memo · / commands )`;

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      {/* sessions sidebar */}
      <Card className="hidden p-3 lg:block">
        <div className="flex items-center justify-between px-1 pb-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">Sessions</p>
          {saved.length ? (
            <span className="text-[11px] text-muted-fg">{saved.length}</span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void newSession()}
          disabled={saving}
          className="flex w-full items-center gap-2 rounded-lg bg-muted px-3 py-2 text-left text-sm font-medium text-fg transition-colors hover:bg-border/60 disabled:opacity-50"
        >
          {saving ? <Spinner width={14} height={14} /> : null}
          {saving ? "Saving session…" : "+ New session"}
        </button>
        <div className="mt-2 space-y-1">
          {saved.length === 0 ? (
            <p className="px-1 pt-2 text-xs text-muted-fg">
              Each conversation is distilled to a summary + commitments here, and the mentor reads
              it next time. <code className="font-mono">/new</code> ends one.
            </p>
          ) : (
            saved.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => openSaved(s)}
                className={cn(
                  "block w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted",
                  viewingId === s.id ? "bg-muted" : "",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium text-fg">{s.title || "Session"}</span>
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-fg">
                  <span>{s.date}</span>
                  <span>· {skillById(s.skill).name}</span>
                  {s.commitments.length ? (
                    <span className="inline-flex items-center gap-0.5 text-accent">
                      · <Check width={10} height={10} /> {s.commitments.length}
                    </span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      </Card>

      {/* conversation + input */}
      <Card className="flex min-h-[440px] flex-col">
        <div ref={scrollRef} className="scrollbar-thin flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-muted text-accent">
                <Sparkles width={20} height={20} />
              </span>
              <p className="text-lg font-medium text-fg">Ask your life anything.</p>
              <p className="max-w-md text-sm text-muted-fg">
                &ldquo;Why have I felt off this week?&rdquo; — grounded in your real sleep, heart
                rate, calendar and messages. Plain text talks · <code className="font-mono">&gt;&gt;</code>{" "}
                logs a memo · <code className="font-mono">/</code> runs a command.
              </p>
              {saved.length ? (
                <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-[12px] text-muted-fg">
                  <Sparkles width={12} height={12} className="text-accent" />
                  Remembers {saved.length} past session{saved.length === 1 ? "" : "s"} — it may pick up an open commitment.
                </p>
              ) : null}
            </div>
          ) : (
            messages.map((m) => <Bubble key={m.id} m={m} />)
          )}
          {busy ? (
            <div className="flex items-center gap-2 text-xs text-muted-fg">
              <Spinner width={14} height={14} /> working…
            </div>
          ) : null}
        </div>

        {/* smart input */}
        <div className="relative border-t border-border p-3">
          {/* command palette */}
          {mode === "command" && filtered.length ? (
            <div className="absolute bottom-full left-3 right-3 mb-2 overflow-hidden rounded-xl border border-border bg-card shadow-xl">
              <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
                <Terminal width={12} height={12} /> Commands
              </div>
              {filtered.map((c, i) => (
                <button
                  key={c.cmd}
                  type="button"
                  onMouseEnter={() => setHi(i)}
                  onClick={() => {
                    if (c.cmd === "/skill") setInput("/skill ");
                    else void runCommand(c.cmd);
                    inputRef.current?.focus();
                  }}
                  className={cn(
                    "flex w-full items-baseline gap-3 px-3 py-2 text-left",
                    i === hi ? "bg-muted" : "hover:bg-muted",
                  )}
                >
                  <span className="font-mono text-[13px] font-medium text-fg">{c.cmd}</span>
                  <span className="truncate text-xs text-muted-fg">{c.desc}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div
            className={cn(
              "flex items-end gap-2 rounded-xl border bg-bg px-2 py-2 transition-colors",
              mode === "memo"
                ? "border-accent/60"
                : mode === "command"
                  ? "border-ring/60"
                  : "border-input focus-within:border-ring/60",
            )}
          >
            {/* skill chip */}
            <div className="relative" ref={skillRef}>
              <button
                type="button"
                onClick={() => setSkillOpen((v) => !v)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-muted"
                title="Switch persona"
              >
                <Sparkles width={14} height={14} className="text-accent" />
                {activeSkill.name}
                <ChevronDown width={13} height={13} className={cn("transition-transform", skillOpen && "rotate-180")} />
              </button>
              {skillOpen ? (
                <div className="absolute bottom-full left-0 z-50 mb-2 w-64 overflow-hidden rounded-xl border border-border bg-card shadow-xl">
                  <p className="border-b border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
                    Persona
                  </p>
                  {SKILLS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => chooseSkill(s.id)}
                      className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-muted"
                    >
                      <span className="mt-0.5 w-4 shrink-0 text-accent">
                        {s.id === skill ? <Check width={14} height={14} /> : null}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-fg">{s.name}</span>
                        <span className="block truncate text-xs text-muted-fg">{s.blurb}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              className="max-h-40 min-h-[2rem] flex-1 resize-none bg-transparent px-1 py-1.5 text-sm text-fg outline-none placeholder:text-muted-fg/70"
            />

            <button
              type="button"
              onClick={submit}
              disabled={!input.trim() || busy}
              aria-label={mode === "memo" ? "Save memo" : mode === "command" ? "Run command" : "Send"}
              className={cn(
                "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                "disabled:opacity-40",
                mode === "memo"
                  ? "bg-muted text-accent hover:bg-border/60"
                  : "bg-accent text-accent-fg hover:opacity-90",
              )}
            >
              {mode === "memo" ? <Inbox width={15} height={15} /> : <Send width={15} height={15} />}
            </button>
          </div>

          <p className="mt-1.5 px-1 text-[11px] text-muted-fg">
            {mode === "memo" ? (
              <span className="text-accent">Memo — lands in your inbox, no reply, no tokens spent.</span>
            ) : mode === "command" ? (
              <span>Command mode — ↑↓ to pick, Enter to run, Tab to complete.</span>
            ) : (
              <>
                <b className="font-medium text-fg">Enter</b> to send · <code className="font-mono">&gt;&gt;</code>{" "}
                memo · <code className="font-mono">/</code> commands · persona:{" "}
                <b className="font-medium text-fg">{activeSkill.name}</b>
              </>
            )}
          </p>
        </div>
      </Card>
    </div>
  );
}

// ---- One message ----------------------------------------------------------

function Bubble({ m }: { m: Msg }) {
  if (m.role === "recap" && m.session) {
    const s = m.session;
    return (
      <div className="space-y-2">
        <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-fg">
          <Sparkles width={11} height={11} className="text-accent" />
          What the mentor remembers from this session — the synthesis, not the transcript.
        </p>
        <div className="rounded-xl border border-border bg-muted/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">{s.title ?? "Session"}</span>
            <span className="rounded-full border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-fg">
              {skillById(s.skill).name}
            </span>
            <span className="text-[11px] text-muted-fg">{s.date}</span>
          </div>
          {s.summary ? <p className="mt-2 text-sm text-muted-fg">{s.summary}</p> : null}
          {s.insights.length ? (
            <ul className="mt-2.5 space-y-1">
              {s.insights.map((it, i) => (
                <li key={i} className="flex gap-1.5 text-[13px] text-fg">
                  <span className="text-accent">→</span>
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {s.commitments.length ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {s.commitments.map((c, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] text-accent"
                >
                  <Check width={11} height={11} /> {c}
                </span>
              ))}
            </div>
          ) : null}
          {!s.summary && !s.insights.length && !s.commitments.length ? (
            <p className="mt-2 text-sm text-muted-fg">No commitments or insights were captured.</p>
          ) : null}
        </div>
      </div>
    );
  }

  if (m.role === "memo") {
    return (
      <div className="flex justify-center">
        <div className="max-w-[85%] rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-fg">
          <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-accent">
            <Check width={12} height={12} /> memo saved to inbox · no reply
            {typeof m.pending === "number" ? <span className="text-muted-fg">· {m.pending} pending</span> : null}
          </div>
          {m.text}
        </div>
      </div>
    );
  }

  if (m.role === "note") {
    return (
      <div className="flex justify-center">
        <p className={cn("max-w-[90%] text-center text-xs", m.tone === "error" ? "text-destructive" : "text-muted-fg")}>
          {m.text}
        </p>
      </div>
    );
  }

  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm text-accent-fg">
          {m.text}
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
        {m.skill ? (
          <p className="mb-1 flex items-center gap-1 pl-1 text-[11px] font-medium text-muted-fg">
            <Sparkles width={11} height={11} className="text-accent" /> {skillById(m.skill).name}
          </p>
        ) : null}
        <div className="whitespace-pre-wrap rounded-2xl rounded-bl-md border border-border bg-muted px-3.5 py-2 text-sm text-fg">
          {m.text}
        </div>
        {m.grounded ? (
          <p className="mt-1 flex items-center gap-1 pl-1 text-[11px] font-medium text-accent">
            <Check width={11} height={11} /> grounded in your record
            {m.sources?.length ? (
              <span className="font-normal text-muted-fg">· {m.sources.join(", ")}</span>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

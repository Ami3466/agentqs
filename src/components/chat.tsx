"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Inbox, MessageSquare, Plus, Send, Sparkles, Spinner, Terminal, Trash } from "@/components/icons";
import { Sparkline } from "@/components/sparkline";
import { VoiceSession } from "@/components/voice-session";
import { Card, cn } from "@/components/ui";
import type { SparkPayload } from "@/lib/grounding";
import type { JournalData } from "@/lib/journal";
import { DEFAULT_SKILL, SKILLS, type Skill } from "@/lib/skills";
import { COMMANDS, DRAFT_KEY, filterCommands, memoText, modeOf, parseCommand } from "@/lib/smart-input";

// ---- Messages -------------------------------------------------------------

type Role = "user" | "assistant" | "memo" | "note" | "recap";
interface Msg {
  id: string;
  role: Role;
  text: string;
  skill?: string; // skill that produced an assistant reply
  pending?: number; // memo: inbox count after saving
  structured?: boolean; // memo: auto-structure (Settings) merged it straight into daily
  tone?: "ok" | "error";
  session?: SavedSession; // recap: the synthesized session being viewed
  grounded?: boolean; // assistant reply cited the daily record
  sources?: string[]; // sources the grounded reply drew on
  spark?: SparkPayload; // inline sparkline of a cited metric
  streaming?: boolean; // assistant reply is still arriving token-by-token
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

/** A provider account as the model chip sees it. */
interface ProviderLite {
  id: string;
  type: string;
  label: string;
  hasKey: string;
}

interface ScopeToken {
  start: number;
  end: number;
  raw: string;
  query: string;
}

interface ScopeSuggestion {
  kind: "date" | "column";
  label: string;
  detail: string;
  insert: string;
}

let seq = 0;
const nid = () => `m${Date.now().toString(36)}_${(seq++).toString(36)}`;

const SKILL_KEY = "agentqs.skill";
const MODEL_KEY = "agentqs.model";

function toIsoDate(mmddyyyy: string): string | null {
  if (!/^\d{8}$/.test(mmddyyyy)) return null;
  const mm = Number(mmddyyyy.slice(0, 2));
  const dd = Number(mmddyyyy.slice(2, 4));
  const yyyy = Number(mmddyyyy.slice(4, 8));
  if (!Number.isFinite(mm) || !Number.isFinite(dd) || !Number.isFinite(yyyy)) return null;
  const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (dt.getUTCFullYear() !== yyyy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
  return `${yyyy.toString().padStart(4, "0")}-${mmddyyyy.slice(0, 2)}-${mmddyyyy.slice(2, 4)}`;
}

function scopeTokenAtEnd(text: string): ScopeToken | null {
  const match = text.match(/(^|\s)(@[^\s]*)$/);
  if (!match || match.index == null) return null;
  const raw = match[2];
  return {
    start: match.index + match[1].length,
    end: text.length,
    raw,
    query: raw.slice(1),
  };
}

function parseScope(raw: string, metricKeys: Set<string>): { text: string; dateRange: string | null; columns: string[] } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const keep: string[] = [];
  const columns: string[] = [];
  let dateRange: string | null = null;

  for (const token of tokens) {
    const date = token.match(/^@(\d{8})-(\d{8})$/);
    if (date) {
      const start = toIsoDate(date[1]);
      const end = toIsoDate(date[2]);
      if (start && end && start <= end) {
        dateRange = `${start}..${end}`;
        continue;
      }
    }

    const column = token.match(/^@([A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+)*)$/);
    if (column) {
      const requested = column[1].split(",").filter(Boolean);
      if (requested.length && requested.every((c) => metricKeys.has(c))) {
        columns.push(...requested);
        continue;
      }
    }

    keep.push(token);
  }

  return { text: keep.join(" "), dateRange, columns };
}

function buildScopePrefix(scope: { dateRange: string | null; columns: string[] }): string {
  const lines: string[] = [];
  if (scope.dateRange) lines.push(`Date range: ${scope.dateRange}`);
  if (scope.columns.length) lines.push(`Columns: ${scope.columns.join(", ")}`);
  return lines.length ? `Scope:\n- ${lines.join("\n- ")}\n\n` : "";
}

function replaceRange(text: string, start: number, end: number, insert: string): string {
  return `${text.slice(0, start)}${insert}${text.slice(end)}`;
}

function scopeSuggestions(token: ScopeToken | null, metrics: JournalData["metrics"]): ScopeSuggestion[] {
  if (!token) return [];
  const query = token.query.toLowerCase();
  const suggestions: ScopeSuggestion[] = [];
  const range = token.query.match(/^(\d{8})-(\d{8})$/);
  if (range) {
    const start = toIsoDate(range[1]);
    const end = toIsoDate(range[2]);
    if (start && end && start <= end) {
      suggestions.push({
        kind: "date",
        label: `${start} to ${end}`,
        detail: "Date range",
        insert: token.raw,
      });
    }
  }

  const columns = metrics
    .filter((m) => {
      if (!query) return true;
      const hay = `${m.source}.${m.metric}`.toLowerCase();
      return hay.includes(query) || m.source.toLowerCase().includes(query) || m.metric.toLowerCase().includes(query);
    })
    .slice(0, 7)
    .map<ScopeSuggestion>((m) => ({
      kind: "column",
      label: `${m.source}.${m.metric}`,
      detail: m.numeric ? "Numeric column" : "Column",
      insert: `@${m.key}`,
    }));

  return [...suggestions, ...columns];
}

function insertScopeToken(input: string, token: ScopeToken | null, insert: string): string {
  if (!token) return input;
  const suffix = insert.startsWith("@") ? insert : `@${insert}`;
  return replaceRange(input, token.start, token.end, `${suffix} `);
}

export function Chat() {
  const router = useRouter();
  const [skill, setSkill] = useState(""); // no skill chosen by default
  const [skills, setSkills] = useState<Skill[]>(SKILLS);
  const [journal, setJournal] = useState<JournalData | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedSession[]>([]);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [skillOpen, setSkillOpen] = useState(false);
  const [hi, setHi] = useState(0); // highlighted command in the palette
  const [sessionsOpen, setSessionsOpen] = useState(false); // mobile sessions modal

  // Model chip: providers + the chosen (provider, model), switchable mid-chat.
  const [providers, setProviders] = useState<ProviderLite[]>([]);
  const [modelSel, setModelSel] = useState<{ providerId: string; model: string } | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [provModels, setProvModels] = useState<Record<string, string[]>>({});
  const [loadingProv, setLoadingProv] = useState<string | null>(null);
  const [openProv, setOpenProv] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeHi, setScopeHi] = useState(0);

  const skillRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const mode = modeOf(input);
  const resolve = (id: string): Skill => skills.find((s) => s.id === id) ?? skills[0] ?? SKILLS[0];
  const chosen = skill !== "" && skills.some((s) => s.id === skill);
  const activeSkill = resolve(skill);

  const filtered = useMemo(() => filterCommands(input), [input]);
  const scopeToken = useMemo(() => scopeTokenAtEnd(input), [input]);
  const scopeItems = useMemo(() => scopeSuggestions(scopeToken, journal?.metrics ?? []), [journal, scopeToken]);
  const metricKeySet = useMemo(() => new Set((journal?.metrics ?? []).map((m) => m.key)), [journal]);

  // Restore the last-used skill + model choice.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedSkill = window.localStorage.getItem(SKILL_KEY);
    if (savedSkill) setSkill(savedSkill);
    try {
      const m = window.localStorage.getItem(MODEL_KEY);
      if (m) setModelSel(JSON.parse(m));
    } catch {
      /* ignore */
    }
  }, []);

  // Pick up a one-shot draft handed over from another tab (Data Log → Ask AI).
  useEffect(() => {
    try {
      const draft = sessionStorage.getItem(DRAFT_KEY);
      if (!draft) return;
      sessionStorage.removeItem(DRAFT_KEY);
      setInput(draft);
      inputRef.current?.focus();
    } catch {
      /* ignore */
    }
  }, []);

  // Load custom skills so the chip + /skill offer everything the record knows.
  useEffect(() => {
    let alive = true;
    fetch("/api/skills")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && Array.isArray(d.skills)) setSkills(d.skills as Skill[]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Load the journal so @ can suggest real columns from the user's record.
  useEffect(() => {
    let alive = true;
    fetch("/api/journal")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && Array.isArray(d.metrics)) setJournal(d as JournalData);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Load the providers list + default model for the model chip.
  useEffect(() => {
    let alive = true;
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        const provs = Array.isArray(d.providers) ? (d.providers as ProviderLite[]).filter((p) => p.hasKey) : [];
        setProviders(provs);
        setModelSel((cur) => {
          if (cur && provs.some((p) => p.id === cur.providerId)) return cur;
          return d.selectedModel ?? null;
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
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

  // Close the skill / model dropdowns on outside click / Escape.
  useEffect(() => {
    if (!skillOpen && !modelOpen && !scopeOpen && !sessionsOpen) return;
    const onClick = (e: MouseEvent) => {
      if (skillOpen && skillRef.current && !skillRef.current.contains(e.target as Node)) setSkillOpen(false);
      if (modelOpen && modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
      if (scopeOpen && scopeRef.current && !scopeRef.current.contains(e.target as Node)) setScopeOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setSkillOpen(false);
        setModelOpen(false);
        setScopeOpen(false);
        setSessionsOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [skillOpen, modelOpen, scopeOpen, sessionsOpen]);

  useEffect(() => {
    if (scopeToken && scopeItems.length) {
      setScopeOpen(true);
      setScopeHi((h) => Math.min(h, scopeItems.length - 1));
    } else {
      setScopeOpen(false);
      setScopeHi(0);
    }
  }, [scopeToken, scopeItems.length]);

  useEffect(() => {
    setHi((h) => (filtered.length ? Math.min(h, filtered.length - 1) : 0));
  }, [filtered.length]);

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

  async function loadProviderModels(id: string) {
    if (provModels[id]) {
      setOpenProv((p) => (p === id ? null : id));
      return;
    }
    setLoadingProv(id);
    setOpenProv(id);
    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: id }),
      });
      const d = await res.json().catch(() => ({}));
      setProvModels((m) => ({ ...m, [id]: Array.isArray(d.models) ? d.models : [] }));
    } finally {
      setLoadingProv(null);
    }
  }

  function chooseModel(providerId: string, model: string) {
    const sel = { providerId, model };
    setModelSel(sel);
    setModelOpen(false);
    if (typeof window !== "undefined") window.localStorage.setItem(MODEL_KEY, JSON.stringify(sel));
    inputRef.current?.focus();
  }

  /** Distill + persist the current conversation, then land it in the sidebar. */
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

  async function deleteSession(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/sessions?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) {
        setSaved((ss) => ss.filter((s) => s.id !== id));
        if (viewingId === id) {
          setViewingId(null);
          setMessages([]);
        }
      }
    } finally {
      setDeletingId(null);
    }
  }

  function openSaved(s: SavedSession) {
    setViewingId(s.id);
    setSkill(skills.some((k) => k.id === s.skill) ? s.skill : skill);
    setMessages([{ id: nid(), role: "recap", text: "", session: s }]);
  }

  // ---- Submit paths -------------------------------------------------------

  async function sendMemo(raw: string) {
    const text = memoText(raw);
    if (!text) {
      push({ role: "note", tone: "error", text: "A memo needs some text after //." });
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
        push({ role: "memo", text, pending: data.pending, structured: Boolean(data.structured) });
      }
    } catch {
      push({ role: "note", tone: "error", text: "Could not reach the inbox." });
    } finally {
      setBusy(false);
    }
  }

  async function runCommand(raw: string) {
    const { cmd, args } = parseCommand(raw);
    setInput("");

    if (cmd === "new") {
      void newSession();
      return;
    }
    if (cmd === "skill") {
      const target = args[0]?.toLowerCase();
      if (target && skills.some((s) => s.id === target)) {
        chooseSkill(target);
        push({ role: "note", tone: "ok", text: `Switched to ${resolve(target).name}.` });
      } else {
        push({ role: "note", text: `Pick a skill: ${skills.map((s) => s.id).join(" · ")}` });
      }
      return;
    }
    if (cmd === "structure") {
      push({ role: "note", text: "Structuring runs from the Data inbox — opening it." });
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

  function patch(id: string, up: (m: Msg) => Msg) {
    setMessages((prev) => prev.map((m) => (m.id === id ? up(m) : m)));
  }
  function drop(id: string) {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }

  async function sendChat(raw: string) {
    const scoped = parseScope(raw, metricKeySet);
    const text = (scoped.text || raw).trim();
    const message = `${buildScopePrefix(scoped)}${text}`.trim();
    const useSkill = chosen ? skill : skills[0]?.id ?? DEFAULT_SKILL;
    if (!chosen) chooseSkill(useSkill);
    const history = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.text }));
    push({ role: "user", text });
    setViewingId(null);
    setInput("");
    setBusy(true);

    const aid = nid();
    setMessages((prev) => [...prev, { id: aid, role: "assistant", text: "", skill: useSkill, streaming: true }]);
    setStreamingId(aid);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          skill: useSkill,
          history,
          ...(modelSel ? { providerId: modelSel.providerId, model: modelSel.model } : {}),
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        drop(aid);
        push({ role: "note", tone: "error", text: data.error || "The model didn't answer." });
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let failed = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let f: {
            t?: string;
            v?: string;
            error?: string;
            skill?: string;
            grounded?: boolean;
            sources?: string[];
            spark?: SparkPayload | null;
          };
          try {
            f = JSON.parse(line);
          } catch {
            continue;
          }
          if (f.t === "delta") {
            patch(aid, (m) => ({ ...m, text: m.text + (f.v ?? "") }));
          } else if (f.t === "done") {
            patch(aid, (m) => ({
              ...m,
              streaming: false,
              text: m.text.trim() ? m.text : "(no reply)",
              skill: f.skill || m.skill,
              grounded: Boolean(f.grounded),
              sources: Array.isArray(f.sources) && f.sources.length ? f.sources : undefined,
              spark: f.spark ?? undefined,
            }));
          } else if (f.t === "error") {
            failed = true;
            drop(aid);
            push({ role: "note", tone: "error", text: f.error || "The model errored mid-reply." });
          }
        }
      }
      if (!failed) patch(aid, (m) => (m.streaming ? { ...m, streaming: false } : m));
    } catch {
      drop(aid);
      push({ role: "note", tone: "error", text: "Could not reach the model." });
    } finally {
      setBusy(false);
      setStreamingId(null);
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
    if (scopeOpen && scopeItems.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setScopeHi((h) => (h + 1) % scopeItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setScopeHi((h) => (h - 1 + scopeItems.length) % scopeItems.length);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const option = scopeItems[scopeHi] ?? scopeItems[0];
        setInput((cur) => insertScopeToken(cur, scopeToken, option.insert));
        setScopeOpen(false);
        return;
      }
    }
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
      ? "Memo — saved to the inbox, no reply"
      : mode === "command"
        ? "Command — /sync · /structure · /new · /skill"
        : `Message${chosen ? ` the ${activeSkill.name.toLowerCase()}` : ""}…  ( @ scope · // memo · / commands )`;

  const modelLabel = modelSel?.model || "Model";

  return (
    <>
      <div className="grid h-[calc(100dvh-9.75rem)] min-h-[320px] gap-2 sm:h-[calc(100dvh-11rem)] sm:min-h-[460px] sm:gap-4 lg:grid-cols-[220px_1fr]">
        {/* sessions sidebar — desktop only */}
        <Card className="hidden flex-col overflow-hidden p-3 lg:flex">
          <div className="flex items-center justify-between px-1 pb-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">Sessions</p>
            {saved.length ? <span className="text-[11px] text-muted-fg">{saved.length}</span> : null}
          </div>
          <button
            type="button"
            onClick={() => void newSession()}
            disabled={saving}
            className="flex w-full items-center gap-2 rounded-lg bg-muted px-3 py-2 text-left text-sm font-medium text-fg transition-colors hover:bg-border/60 disabled:opacity-50"
          >
            {saving ? <Spinner width={14} height={14} /> : null}
            {saving ? "Saving…" : "+ New session"}
          </button>
          <div className="scrollbar-thin mt-2 flex-1 space-y-1 overflow-y-auto">
            {saved.length === 0 ? (
              <p className="px-1 pt-2 text-xs text-muted-fg">
                Each conversation is distilled to a summary + commitments here, read back next time.
              </p>
            ) : (
              saved.map((s) => (
                <div
                  key={s.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-muted",
                    viewingId === s.id ? "bg-muted" : "",
                  )}
                >
                  <button type="button" onClick={() => openSaved(s)} className="min-w-0 flex-1 px-3 py-2 text-left">
                    <span className="block truncate text-[13px] font-medium text-fg">{s.title || "Session"}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-fg">
                      <span>{s.date}</span>
                      <span>· {resolve(s.skill).name}</span>
                      {s.commitments.length ? (
                        <span className="inline-flex items-center gap-0.5 text-accent">
                          · <Check width={10} height={10} /> {s.commitments.length}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteSession(s.id)}
                    disabled={deletingId === s.id}
                    aria-label="Delete session"
                    className="shrink-0 rounded p-1 text-muted-fg opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  >
                    {deletingId === s.id ? <Spinner width={13} height={13} /> : <Trash width={13} height={13} />}
                  </button>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* conversation + input */}
        <Card className="flex min-h-0 min-w-0 flex-col">
          <div ref={scrollRef} className="scrollbar-thin flex-1 space-y-4 overflow-y-auto p-3 sm:p-4 md:p-5">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-muted text-accent">
                  <Sparkles width={20} height={20} />
                </span>
                <p className="text-lg font-medium text-fg">Ask the record anything.</p>
                <p className="max-w-md text-xs sm:text-sm text-muted-fg">
                  Grounded in sleep, heart rate, calendar and messages. Plain text talks ·{" "}
                  <code className="font-mono">//</code> logs a memo · <code className="font-mono">/</code> runs a command.
                </p>
              </div>
            ) : (
              messages.map((m) => <Bubble key={m.id} m={m} skills={skills} />)
            )}
          {busy && !streamingId ? (
            <div className="flex items-center gap-2 text-xs text-muted-fg">
              <Spinner width={14} height={14} /> working…
            </div>
          ) : null}
        </div>

        {/* smart input */}
        <div ref={scopeRef} className="relative border-t border-border p-2 sm:p-3">
          {scopeOpen && scopeItems.length ? (
            <div className="absolute bottom-full left-2 right-2 mb-2 overflow-hidden rounded-xl border border-border bg-card shadow-xl sm:left-3 sm:right-3">
              <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
                <ChevronDown width={12} height={12} className="rotate-90" /> Scope
              </div>
              {scopeItems.map((item, i) => (
                <button
                  key={`${item.kind}:${item.label}`}
                  type="button"
                  onMouseEnter={() => setScopeHi(i)}
                  onClick={() => {
                    setInput((cur) => insertScopeToken(cur, scopeToken, item.insert));
                    setScopeOpen(false);
                    inputRef.current?.focus();
                  }}
                  className={cn("flex w-full items-baseline gap-3 px-3 py-2 text-left", i === scopeHi ? "bg-muted" : "hover:bg-muted")}
                >
                  <span className="font-mono text-[13px] font-medium text-fg">
                    {item.kind === "date" ? "@date" : "@column"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-fg">{item.label}</span>
                    <span className="block truncate text-[11px] text-muted-fg">{item.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {/* command palette */}
          {mode === "command" && filtered.length ? (
            <div className="absolute bottom-full left-2 right-2 mb-2 overflow-hidden rounded-xl border border-border bg-card shadow-xl sm:left-3 sm:right-3">
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
              "flex flex-col gap-2 rounded-xl border bg-bg p-2 transition-colors sm:flex-row sm:items-end",
              mode === "memo"
                ? "border-accent/60"
                : mode === "command"
                  ? "border-ring/60"
                  : "border-input focus-within:border-ring/60",
            )}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              className="max-h-40 min-h-[2rem] w-full resize-none bg-transparent px-1 py-1.5 text-base text-fg outline-none placeholder:text-muted-fg/70 sm:order-2 sm:w-auto sm:flex-1 sm:text-sm"
            />

            {/* chips row on mobile; flattened into the main row on sm+ */}
            <div className="flex min-w-0 items-center gap-2 sm:contents">

            {/* mobile/tablet sessions button */}
            <button
              type="button"
              onClick={() => setSessionsOpen((v) => !v)}
              className="lg:hidden inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg border border-border bg-card px-2 text-[12px] font-medium text-muted-fg transition-colors hover:bg-muted hover:text-fg sm:order-1"
              title="Open sessions"
              aria-label="Sessions"
            >
              <MessageSquare width={14} height={14} />
              {saved.length > 0 ? <span className="text-xs font-semibold">{saved.length}</span> : null}
            </button>

            {/* skill chip */}
            <div className="static shrink-0 sm:relative sm:order-1" ref={skillRef} id="tour-mentor">
              <button
                type="button"
                onClick={() => setSkillOpen((v) => !v)}
                className="inline-flex h-8 max-w-[7rem] items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-muted sm:max-w-[9rem]"
                title="Choose a skill"
              >
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", chosen ? "bg-fg" : "bg-muted-fg/40")} />
                <span className="truncate">{chosen ? activeSkill.name : "Skill"}</span>
                <ChevronDown width={13} height={13} className={cn("shrink-0 transition-transform", skillOpen && "rotate-180")} />
              </button>
              {skillOpen ? (
                <div className="absolute bottom-full left-2 right-2 z-50 mb-2 overflow-hidden rounded-xl border border-border bg-card shadow-xl sm:left-0 sm:right-auto sm:w-64">
                  <p className="border-b border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
                    Skill
                  </p>
                  {skills.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => chooseSkill(s.id)}
                      className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-muted"
                    >
                      <span className="mt-0.5 w-4 shrink-0 text-fg">
                        {s.id === skill ? <Check width={14} height={14} /> : null}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-fg">{s.name}</span>
                        <span className="block truncate text-xs text-muted-fg">{s.blurb}</span>
                      </span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setSkillOpen(false);
                      router.push("/settings#skills");
                    }}
                    className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm text-muted-fg transition-colors hover:bg-muted hover:text-fg"
                  >
                    <Plus width={14} height={14} /> Manage skills · Settings
                  </button>
                </div>
              ) : null}
            </div>

            {/* model chip */}
            <div className="static min-w-0 sm:relative sm:order-1 sm:shrink-0" ref={modelRef}>
              <button
                type="button"
                onClick={() => setModelOpen((v) => !v)}
                className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-muted sm:max-w-[9rem]"
                title="Choose a model"
              >
                <span className="truncate">{modelLabel}</span>
                <ChevronDown width={13} height={13} className={cn("shrink-0 transition-transform", modelOpen && "rotate-180")} />
              </button>
              {modelOpen ? (
                <div className="absolute bottom-full left-2 right-2 z-50 mb-2 max-h-80 overflow-y-auto rounded-xl border border-border bg-card shadow-xl sm:left-0 sm:right-auto sm:w-72">
                  <p className="border-b border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
                    Model
                  </p>
                  {providers.length === 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        setModelOpen(false);
                        router.push("/settings");
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-fg hover:bg-muted hover:text-fg"
                    >
                      <Plus width={14} height={14} /> Add a provider · Settings
                    </button>
                  ) : (
                    providers.map((p) => (
                      <div key={p.id}>
                        <button
                          type="button"
                          onClick={() => void loadProviderModels(p.id)}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] font-medium text-fg hover:bg-muted"
                        >
                          <span className="truncate">{p.label || p.type}</span>
                          {loadingProv === p.id ? (
                            <Spinner width={13} height={13} />
                          ) : (
                            <ChevronDown
                              width={13}
                              height={13}
                              className={cn("shrink-0 text-muted-fg transition-transform", openProv === p.id && "rotate-180")}
                            />
                          )}
                        </button>
                        {openProv === p.id
                          ? (provModels[p.id] ?? []).map((m) => (
                              <button
                                key={m}
                                type="button"
                                onClick={() => chooseModel(p.id, m)}
                                className="flex w-full items-center gap-2 py-1.5 pl-6 pr-3 text-left text-[13px] text-muted-fg hover:bg-muted hover:text-fg"
                              >
                                <span className="w-4 shrink-0 text-fg">
                                  {modelSel?.providerId === p.id && modelSel.model === m ? (
                                    <Check width={13} height={13} />
                                  ) : null}
                                </span>
                                <span className="truncate font-mono text-[12px]">{m}</span>
                              </button>
                            ))
                          : null}
                        {openProv === p.id && (provModels[p.id]?.length ?? 0) === 0 && loadingProv !== p.id ? (
                          <p className="py-1.5 pl-6 pr-3 text-[11px] text-muted-fg">No models returned.</p>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>

            {/* in-chat live voice session (ElevenLabs) — separate from the global mic */}
            <div className="shrink-0 sm:order-1">
              <VoiceSession />
            </div>

            <button
              type="button"
              onClick={submit}
              disabled={!input.trim() || busy}
              aria-label={mode === "memo" ? "Save memo" : mode === "command" ? "Run command" : "Send"}
              className={cn(
                "ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40 sm:order-3",
                mode === "memo" ? "bg-muted text-accent hover:bg-border/60" : "bg-accent text-accent-fg hover:opacity-90",
              )}
            >
              {mode === "memo" ? <Inbox width={15} height={15} /> : <Send width={15} height={15} />}
            </button>
            </div>
          </div>

          <p className="mt-1 px-1 text-[10px] sm:text-[11px] text-muted-fg">
            {mode === "memo" ? (
              <span className="text-accent">Memo — lands in the inbox, no reply, no tokens spent.</span>
            ) : mode === "command" ? (
              <span>Command mode — ↑↓ to pick, Enter to run, Tab to complete.</span>
            ) : scopeOpen && scopeItems.length ? (
              <span>
                <b className="font-medium text-fg">@</b> scope by date range or column. Enter or Tab to insert.
              </span>
            ) : (
              <>
                <b className="font-medium text-fg">Enter</b> to send · <code className="font-mono">//</code> memo ·{" "}
                <code className="font-mono">/</code> commands · <code className="font-mono">@</code> scope dates/columns
              </>
            )}
          </p>
        </div>
      </Card>
    </div>

    {/* mobile sessions modal */}
    {sessionsOpen && (
      <div className="fixed inset-0 z-50 flex items-end bg-black/50 lg:hidden" onClick={() => setSessionsOpen(false)}>
        <div
          className="flex max-h-[80dvh] w-full flex-col rounded-t-2xl border-t border-border bg-card pb-[env(safe-area-inset-bottom)] shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold text-fg">Sessions</p>
            <button
              type="button"
              onClick={() => setSessionsOpen(false)}
              className="text-muted-fg hover:text-fg"
              aria-label="Close sessions"
            >
              ✕
            </button>
          </div>
          <div className="scrollbar-thin flex-1 space-y-1 overflow-y-auto p-3">
            <button
              type="button"
              onClick={() => {
                void newSession();
                setSessionsOpen(false);
              }}
              disabled={saving}
              className="flex w-full items-center gap-2 rounded-lg bg-muted px-3 py-2 text-left text-sm font-medium text-fg transition-colors hover:bg-border/60 disabled:opacity-50"
            >
              {saving ? <Spinner width={14} height={14} /> : null}
              {saving ? "Saving…" : "+ New session"}
            </button>
            {saved.length === 0 ? (
              <p className="px-1 pt-2 text-xs text-muted-fg">
                Each conversation is distilled to a summary + commitments here, read back next time.
              </p>
            ) : (
              saved.map((s) => (
                <div
                  key={s.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-muted",
                    viewingId === s.id ? "bg-muted" : "",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      openSaved(s);
                      setSessionsOpen(false);
                    }}
                    className="min-w-0 flex-1 px-3 py-2 text-left"
                  >
                    <span className="block truncate text-[13px] font-medium text-fg">{s.title || "Session"}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-fg">
                      <span>{s.date}</span>
                      <span>· {resolve(s.skill).name}</span>
                      {s.commitments.length ? (
                        <span className="inline-flex items-center gap-0.5 text-accent">
                          · <Check width={10} height={10} /> {s.commitments.length}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteSession(s.id)}
                    disabled={deletingId === s.id}
                    aria-label="Delete session"
                    className="shrink-0 rounded p-1 text-muted-fg opacity-100 transition-opacity hover:text-destructive group-hover:opacity-100"
                  >
                    {deletingId === s.id ? <Spinner width={13} height={13} /> : <Trash width={13} height={13} />}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// ---- One message ----------------------------------------------------------

function Bubble({ m, skills }: { m: Msg; skills: Skill[] }) {
  const resolve = (id: string): Skill => skills.find((s) => s.id === id) ?? skills[0] ?? SKILLS[0];
  if (m.role === "recap" && m.session) {
    const s = m.session;
    return (
      <div className="space-y-2">
        <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-fg">
          <Sparkles width={11} height={11} className="text-accent" />
          The synthesis kept from this session — not the transcript.
        </p>
        <div className="rounded-xl border border-border bg-muted/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">{s.title ?? "Session"}</span>
            <span className="rounded-full border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-fg">
              {resolve(s.skill).name}
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
        <div className="max-w-[85%] rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs sm:text-sm text-fg">
          <div className="mb-0.5 flex items-center gap-1.5 text-[10px] sm:text-[11px] font-medium text-accent">
            <Check width={12} height={12} />{" "}
            {m.structured ? "memo structured into daily" : "memo saved to inbox"} · no reply
            {typeof m.pending === "number" ? <span className="text-muted-fg">· {m.pending} pending</span> : null}
          </div>
          {m.text}
        </div>
      </div>
    );
  }

  if (m.role === "note") {
    return (
      <div className="flex justify-center px-2">
        <p className={cn("max-w-full text-center text-xs sm:text-sm", m.tone === "error" ? "text-destructive" : "text-muted-fg")}>
          {m.text}
        </p>
      </div>
    );
  }

  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3 sm:px-3.5 py-2 text-xs sm:text-sm text-accent-fg">
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
          <p className="mb-1 flex items-center gap-1 pl-1 text-[10px] sm:text-[11px] font-medium text-muted-fg">
            <Sparkles width={11} height={11} className="text-accent" /> {resolve(m.skill).name}
          </p>
        ) : null}
        <div className="whitespace-pre-wrap rounded-2xl rounded-bl-md border border-border bg-muted px-3 sm:px-3.5 py-2 text-xs sm:text-sm text-fg">
          {m.text}
          {m.streaming ? (
            m.text ? (
              <span
                className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] animate-pulse rounded-sm bg-accent align-middle"
                aria-hidden
              />
            ) : (
              <TypingDots />
            )
          ) : null}
        </div>
        {m.grounded ? (
          <p className="mt-1 flex flex-wrap items-center gap-1 pl-1 text-[10px] sm:text-[11px] font-medium text-accent">
            <Check width={11} height={11} /> grounded in the record
            {m.sources?.length ? <span className="font-normal text-muted-fg break-words">· {m.sources.join(", ")}</span> : null}
          </p>
        ) : null}
        {m.grounded && m.spark ? <ReplySpark spark={m.spark} /> : null}
      </div>
    </div>
  );
}

/** "Thinking…" pips shown in the assistant bubble before the first token lands. */
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-0.5 align-middle" aria-label="thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-fg/60"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

/** The inline sparkline under a grounded reply. */
function ReplySpark({ spark }: { spark: SparkPayload }) {
  return (
    <div className="mt-2 max-w-xs rounded-xl border border-border bg-card/60 px-2 sm:px-3 py-2">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-[10px] sm:text-[11px] font-medium text-fg">
          {spark.source} · {spark.metric}
        </span>
        <span className="shrink-0 text-[9px] sm:text-[10px] text-muted-fg">{spark.points.length}d</span>
      </div>
      <Sparkline
        points={spark.points}
        variant="line"
        title={(p) => `${p.date}: ${p.value}`}
        ariaLabel={`${spark.source} ${spark.metric} over ${spark.points.length} days`}
      />
      <div className="mt-1.5 flex flex-wrap gap-x-2 sm:gap-x-3 gap-y-0.5 text-[9px] sm:text-[10px] text-muted-fg">
        <span>
          latest <b className="font-medium text-fg">{spark.latest}</b>
        </span>
        <span>
          avg <b className="font-medium text-fg">{spark.avg}</b>
        </span>
        <span>
          range{" "}
          <b className="font-medium text-fg">
            {spark.min}–{spark.max}
          </b>
        </span>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Check, Eye, EyeOff, Plus, RefreshCw, Spinner, Trash, X } from "@/components/icons";
import { IntervalSelect } from "@/components/interval-select";
import { Button, Field, Input, Select, cn } from "@/components/ui";
import type { Interval } from "@/lib/sources";
import {
  templateSteps,
  type AutomationCredType,
  type AutomationStep,
  type AutomationStepType,
} from "@/lib/automation-types";

/**
 * The automation setup flow (Task 5) — the four-step wizard for wiring up a source
 * that has NO ready API:
 *   1 Source      · name + start URL
 *   2 Credentials · the login it should use (kept in your data dir, never in steps)
 *   3 Record      · the click-path to your data + a real Playwright trial run that
 *                   scrapes it once, so you see the rows before scheduling
 *   4 Schedule    · how often it replays (the cron interval)
 * On finish the recipe lives under "Automated imports" as an editable feed. Every
 * call hits the same core the CLI/MCP use (/api/automations + /api/automations/run).
 */

const STEP_TYPES: AutomationStepType[] = ["goto", "fill", "click", "waitForSelector", "press", "extractTable"];

interface RunResult {
  landed: "daily" | "inbox";
  rows: number;
  dailyRows: number;
  metrics: string[];
  headers: string[];
}

export function AutomationSetup({
  onDone,
  onCancel,
  initialName = "",
  initialUrl = "",
}: {
  onDone: () => void;
  onCancel: () => void;
  /** Seed name/URL when the wizard is opened from a specific roster source
   *  (e.g. "Garmin" → its login page), so the user isn't typing from scratch. */
  initialName?: string;
  initialUrl?: string;
}) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState(initialName);
  const [url, setUrl] = useState(initialUrl);
  const [credType, setCredType] = useState<AutomationCredType>("userpass");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [steps, setSteps] = useState<AutomationStep[]>(templateSteps("userpass"));
  const [interval, setInterval] = useState<Interval>("daily");

  const [savedId, setSavedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [run, setRun] = useState<RunResult | null>(null);

  function pickCredType(t: AutomationCredType) {
    setCredType(t);
    // Reseed the template only if the user hasn't diverged from the previous one.
    setSteps((prev) => (JSON.stringify(prev) === JSON.stringify(templateSteps(credType)) ? templateSteps(t) : prev));
  }

  function setStepField(i: number, patch: Partial<AutomationStep>) {
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }
  function addStep() {
    setSteps((prev) => [...prev, { type: "click", selector: "" }]);
  }
  function removeStep(i: number) {
    setSteps((prev) => prev.filter((_, j) => j !== i));
  }
  function moveStep(i: number, dir: -1 | 1) {
    setSteps((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function save(): Promise<string | null> {
    const res = await fetch("/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: savedId ?? undefined,
        name,
        url,
        credType,
        steps,
        username: credType === "userpass" ? username : undefined,
        password: credType === "userpass" ? password : undefined,
        token: credType === "token" ? token : undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Could not save the automation.");
      return null;
    }
    const id = data.automation?.id as string;
    setSavedId(id);
    return id;
  }

  /** Step 3 — save the recipe, then run it once for real (Playwright headless). */
  async function record() {
    setBusy(true);
    setError("");
    setRun(null);
    const id = await save();
    if (!id) {
      setBusy(false);
      return;
    }
    const res = await fetch(`/api/automations/run?id=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error || "Trial run failed — check the steps + selectors.");
      return;
    }
    setRun(data.result as RunResult);
  }

  /** Step 4 — persist the schedule, then hand back to the sources list. */
  async function finish() {
    setBusy(true);
    setError("");
    const id = savedId ?? (await save());
    if (!id) {
      setBusy(false);
      return;
    }
    await fetch("/api/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, interval }),
    });
    setBusy(false);
    onDone();
  }

  const canNext1 = name.trim().length >= 2 && /^https?:\/\//i.test(url.trim());

  return (
    <div className="border-t border-border bg-muted/30 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <RefreshCw width={15} height={15} className="text-muted-fg" />
          <p className="text-sm font-semibold text-fg">Custom scraping</p>
        </div>
        <button type="button" onClick={onCancel} className="rounded p-1 text-muted-fg hover:text-fg" aria-label="Cancel">
          <X width={16} height={16} />
        </button>
      </div>

      <Stepper step={step} />

      <div className="mt-4 space-y-3">
        {step === 1 ? (
          <>
            <Field label="Name" hint="Becomes the source name in the Log.">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Power bill" />
            </Field>
            <Field label="Start URL" hint="Where the browser opens — usually the login or dashboard page.">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/login" className="font-mono text-[13px]" />
            </Field>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <Field label="How it logs in">
              <Select value={credType} onChange={(e) => pickCredType(e.target.value as AutomationCredType)}>
                <option value="userpass">Username + password</option>
                <option value="token">Token / cookie</option>
                <option value="none">No login (public page)</option>
              </Select>
            </Field>
            {credType === "userpass" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Username / email">
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
                </Field>
                <Field label="Password">
                  <div className="relative">
                    <Input
                      type={showSecret ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="off"
                      className="pr-10"
                    />
                    <SecretToggle on={showSecret} onClick={() => setShowSecret((v) => !v)} />
                  </div>
                </Field>
              </div>
            ) : credType === "token" ? (
              <Field label="Token" hint="Bearer token or session cookie the steps reference as {{token}}.">
                <div className="relative">
                  <Input
                    type={showSecret ? "text" : "password"}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    autoComplete="off"
                    className="pr-10 font-mono"
                  />
                  <SecretToggle on={showSecret} onClick={() => setShowSecret((v) => !v)} />
                </div>
              </Field>
            ) : (
              <p className="text-xs text-muted-fg">No credentials — the browser just opens the page and scrapes it.</p>
            )}
            <p className="text-[11px] text-muted-fg">
              Stored locally, only used to log in. Reference them in a step&apos;s value as{" "}
              <code className="rounded bg-muted px-1">{"{{username}}"}</code> /{" "}
              <code className="rounded bg-muted px-1">{"{{password}}"}</code> /{" "}
              <code className="rounded bg-muted px-1">{"{{token}}"}</code>.
            </p>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <p className="text-xs text-muted-fg">
              The click-path to the data. It runs top to bottom in a real browser; the last{" "}
              <code className="rounded bg-muted px-1">extractTable</code> scrapes a{" "}
              <code className="rounded bg-muted px-1">&lt;table&gt;</code> into daily rows (a date column merges into
              the timeline). Hit <b>Record trial run</b> to prove it once.
            </p>
            <div className="space-y-2">
              {steps.map((s, i) => (
                <div key={i} className="flex items-start gap-2 rounded-lg border border-border bg-bg p-2">
                  <span className="mt-1 w-4 shrink-0 text-center text-[11px] tabular-nums text-muted-fg">{i + 1}</span>
                  <Select
                    value={s.type}
                    onChange={(e) => setStepField(i, { type: e.target.value as AutomationStepType })}
                    className="h-9 w-40 shrink-0 text-[13px]"
                  >
                    {STEP_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    {s.type !== "goto" ? (
                      <Input
                        value={s.selector ?? ""}
                        onChange={(e) => setStepField(i, { selector: e.target.value })}
                        placeholder="CSS selector"
                        className="h-9 font-mono text-[13px]"
                      />
                    ) : null}
                    {s.type !== "click" && s.type !== "waitForSelector" && s.type !== "extractTable" ? (
                      <Input
                        value={s.value ?? ""}
                        onChange={(e) => setStepField(i, { value: e.target.value })}
                        placeholder={s.type === "goto" ? "https://…" : s.type === "press" ? "Enter" : "value ({{username}})"}
                        className="h-9 font-mono text-[13px]"
                      />
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col gap-0.5">
                    <button type="button" onClick={() => moveStep(i, -1)} className="rounded px-1 text-muted-fg hover:text-fg" aria-label="Move up">↑</button>
                    <button type="button" onClick={() => moveStep(i, 1)} className="rounded px-1 text-muted-fg hover:text-fg" aria-label="Move down">↓</button>
                  </div>
                  <button type="button" onClick={() => removeStep(i)} className="mt-1 rounded p-1 text-muted-fg hover:text-fg" aria-label="Remove step">
                    <Trash width={14} height={14} />
                  </button>
                </div>
              ))}
              <Button size="sm" variant="secondary" onClick={addStep}>
                <Plus width={14} height={14} /> Add step
              </Button>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button variant="primary" onClick={record} disabled={busy}>
                {busy ? <Spinner width={15} height={15} /> : <RefreshCw width={15} height={15} />}
                {busy ? "Recording…" : run ? "Re-run" : "Record trial run"}
              </Button>
              {run ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-accent">
                  <Check width={13} height={13} />
                  {run.landed === "daily"
                    ? `${run.rows} cells captured → ${run.metrics.join(", ") || "daily rows"}`
                    : `${run.rows} rows captured → inbox (structure later)`}
                </span>
              ) : null}
            </div>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <Field label="How often it runs" hint="agentqs replays this headless on the schedule and on Pipeline-tab open.">
              <IntervalSelect value={interval} onChange={setInterval} />
            </Field>
            <div className="rounded-lg border border-border bg-bg p-3 text-xs text-muted-fg">
              <b className="text-fg">{name || "This automation"}</b> · {url}
              <br />
              {run
                ? `Trial run captured ${run.rows} ${run.landed === "daily" ? "cells" : "rows"}.`
                : "No trial run yet — you can still save and run it later."}
            </div>
          </>
        ) : null}

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <div className="flex items-center justify-between pt-1">
          <Button variant="ghost" size="sm" onClick={step === 1 ? onCancel : () => setStep((s) => s - 1)} disabled={busy}>
            {step === 1 ? "Cancel" : "Back"}
          </Button>
          {step < 4 ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setStep((s) => s + 1)}
              disabled={busy || (step === 1 && !canNext1)}
            >
              Next
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={finish} disabled={busy}>
              {busy ? <Spinner width={14} height={14} /> : <Check width={14} height={14} />}
              Save automation
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  const labels = ["Source", "Credentials", "Record", "Schedule"];
  return (
    <div className="flex items-center gap-1.5">
      {labels.map((label, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <div key={label} className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
                active ? "bg-fg text-bg" : done ? "text-fg" : "text-muted-fg",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px]",
                  active ? "bg-bg text-fg" : done ? "bg-fg text-bg" : "border border-border",
                )}
              >
                {done ? <Check width={10} height={10} /> : n}
              </span>
              {label}
            </span>
            {i < labels.length - 1 ? <span className="h-px w-3 bg-border" /> : null}
          </div>
        );
      })}
    </div>
  );
}

function SecretToggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-fg hover:text-fg"
      aria-label={on ? "Hide" : "Show"}
    >
      {on ? <EyeOff width={16} height={16} /> : <Eye width={16} height={16} />}
    </button>
  );
}

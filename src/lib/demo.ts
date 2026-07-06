import fs from "fs";
import path from "path";
import { readConfig, writeConfig } from "./config";
import { recordDir } from "./paths";
import { appendInboxItem, appendSession, mergeDailyCsv, rebuild, updateInboxItems } from "./record";

/**
 * Generic demo data — a throwaway sample record so a brand-new instance has
 * something to explore before any real source is connected. It is deliberately
 * NObody's data, but it has to look LIVED-IN so the AI demo lands: ~100 days over
 * eight everyday metrics with a weekly rhythm (weekend step spikes, weekday focus)
 * and real correlations (a bad night drags mood, focus and resting HR the next
 * day; workouts lift mood), plus dated memos, raw not-yet-structured captures
 * (calendar export, browser history) and a lived-in Log (structured + rejected
 * drops) and sessions. The moment a real import runs, `wipeDemoOnImport` clears
 * every trace of it so it can never mingle with the user's own record.
 */

const DEMO_SOURCES = ["steps", "sleep", "focus", "mood", "heart", "screen", "workouts", "commits"] as const;
const DEMO_INBOX_SOURCE = "demo";
const DEMO_SESSION_PREFIX = "demo-";
const DEMO_DAYS = 100;

/** Deterministic pseudo-random in [0,1) from an integer seed — no real randomness,
 *  so the demo record is byte-identical every time it's seeded. */
function rnd(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const tenth = (n: number) => Math.round(n * 10) / 10;

export function isDemoSeeded(): boolean {
  return readConfig()?.demoSeeded === true;
}

/** Seed the generic demo record and rebuild the cache. Idempotent — one pass per
 *  day computes every metric from the same seeds, so the correlations the mentor
 *  points at (sleep → mood/focus/HR, workouts → mood) actually hold in the data. */
export function seedDemo(): { days: number } {
  const dir = recordDir();
  const days = DEMO_DAYS;

  const tables: Record<(typeof DEMO_SOURCES)[number], string[][]> = {
    steps: [], sleep: [], focus: [], mood: [], heart: [], screen: [], workouts: [], commits: [],
  };

  for (let i = days - 1; i >= 0; i--) {
    const date = isoDaysAgo(i);
    const t = (days - 1 - i) / (days - 1); // 0 → oldest, 1 → today (gentle upward trends)
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6;

    const badNight = rnd(i * 7 + 1) < 0.12; // ~once a week the wheels come off
    const sleep = badNight
      ? tenth(4.7 + rnd(i * 3 + 2) * 1.1)
      : tenth(clamp(6.4 + rnd(i * 3 + 2) * 1.8 + (weekend ? 0.4 : 0), 5.9, 9.2));
    const sleepQ = sleep - 6.9; // signed "how rested" proxy the other metrics lean on

    const restDay = rnd(i * 5 + 3) < (weekend ? 0.25 : 0.45);
    const workout = restDay ? 0 : Math.round(20 + rnd(i * 5 + 4) * (weekend ? 55 : 40));

    const steps = Math.round(
      5800 + rnd(i * 11 + 5) * 3000 + (weekend ? 2600 : 0) + workout * 28 + t * 900,
    );
    const heart = Math.round(clamp(56 + (badNight ? 4 : 0) + rnd(i * 13 + 6) * 4 - sleepQ * 1.5 - (workout ? 1 : 0), 49, 66));
    const focus = Math.round(
      weekend
        ? clamp(30 + rnd(i * 17 + 7) * 90, 15, 150)
        : clamp(170 + rnd(i * 17 + 7) * 130 + sleepQ * 35 - (badNight ? 50 : 0) + t * 25, 40, 360),
    );
    const screen = Math.round(clamp(210 + rnd(i * 19 + 8) * 150 + (weekend ? 55 : 0) - workout * 0.8 - focus * 0.15, 90, 430));
    const away = rnd(i * 23 + 9) < 0.06; // the odd day fully offline
    const commits = away
      ? 0
      : weekend
        ? Math.round(rnd(i * 23 + 10) * 3)
        : Math.round(clamp(3 + rnd(i * 23 + 10) * 9 + sleepQ * 2, 0, 16));
    const mood = tenth(
      clamp(3.1 + sleepQ * 0.4 + (workout ? 0.35 : 0) + (steps > 9500 ? 0.2 : 0) - (badNight ? 0.5 : 0) + (rnd(i * 29 + 11) - 0.5) * 1.5, 1, 5),
    );

    tables.steps.push([date, String(steps)]);
    tables.sleep.push([date, String(sleep)]);
    tables.focus.push([date, String(focus)]);
    tables.mood.push([date, String(mood)]);
    tables.heart.push([date, String(heart)]);
    tables.screen.push([date, String(screen)]);
    tables.workouts.push([date, String(workout)]);
    tables.commits.push([date, String(commits)]);
  }

  const metricNames: Record<(typeof DEMO_SOURCES)[number], string> = {
    steps: "steps", sleep: "hours", focus: "minutes", mood: "score",
    heart: "resting_hr", screen: "minutes", workouts: "minutes", commits: "count",
  };
  for (const src of DEMO_SOURCES) {
    mergeDailyCsv(dir, src, { header: ["date", metricNames[src]], rows: tables[src] });
  }

  // Memos spread across the record (not all stamped "today"), so the Journal
  // timeline and the Log both read as a lived-in history.
  const at = (daysAgo: number, hhmm: string) => `${isoDaysAgo(daysAgo)}T${hhmm}:00.000Z`;
  const memos: Array<[number, string, string]> = [
    [21, "07:40", "Sample memo: slept badly, big deploy today - watch the focus dip."],
    [14, "12:15", "Sample memo: long walk cleared my head after the standup."],
    [9, "20:05", "Sample memo: skipped the gym twice this week, mood's been flat since."],
    [5, "17:30", "Sample memo: best focus day in a month - phone stayed in the drawer."],
    [2, "08:10", "Sample memo: resting HR crept up again after the late nights."],
  ];
  for (const [daysAgo, hhmm, text] of memos) {
    appendInboxItem({ source: DEMO_INBOX_SOURCE, text, ts: at(daysAgo, hhmm) });
  }

  // Raw, NOT-yet-structured captures (a calendar export + browser history), so the
  // inbox and the Log show real pending material to try Structure on.
  const icsDay = (n: number) => isoDaysAgo(n).replace(/-/g, "");
  appendInboxItem({
    source: "drop",
    kind: "file",
    ts: at(3, "18:45"),
    meta: { filename: "calendar.ics", demo: true },
    text: [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//sample//calendar//EN",
      ...[
        [6, "090000", "093000", "Standup"],
        [6, "140000", "153000", "Quarterly planning"],
        [4, "070000", "080000", "Gym — legs"],
        [3, "120000", "124500", "Lunch with Dana"],
        [2, "100000", "113000", "Deep work block"],
      ].flatMap(([d, start, end, summary]) => [
        "BEGIN:VEVENT",
        `DTSTART:${icsDay(d as number)}T${start}Z`,
        `DTEND:${icsDay(d as number)}T${end}Z`,
        `SUMMARY:${summary}`,
        "END:VEVENT",
      ]),
      "END:VCALENDAR",
    ].join("\n"),
  });
  appendInboxItem({
    source: "drop",
    kind: "csv",
    ts: at(2, "21:10"),
    meta: { filename: "history.csv", demo: true },
    text: [
      "visited_at,url,title",
      `${isoDaysAgo(4)} 09:12,https://news.ycombinator.com,Hacker News`,
      `${isoDaysAgo(4)} 09:31,https://github.com/notifications,GitHub notifications`,
      `${isoDaysAgo(3)} 11:02,https://docs.python.org/3/library/sqlite3.html,sqlite3 docs`,
      `${isoDaysAgo(3)} 15:44,https://www.youtube.com/watch?v=sample,How to sleep better`,
      `${isoDaysAgo(2)} 08:05,https://mail.google.com,Inbox`,
      `${isoDaysAgo(2)} 22:37,https://en.wikipedia.org/wiki/Circadian_rhythm,Circadian rhythm`,
    ].join("\n"),
  });

  // Already-processed Log entries: two structured drops (what fed the daily table)
  // and one rejected one, so the Data-tab Log demos its whole lifecycle.
  const structuredDrop = (
    daysAgo: number,
    filename: string,
    source: (typeof DEMO_SOURCES)[number],
    metric: string,
    rows: Array<[number, string]>,
  ) => {
    const item = appendInboxItem({
      source: "drop",
      kind: "csv",
      ts: at(daysAgo, "10:00"),
      meta: { filename, demo: true },
      text: ["date," + metric, ...rows.map(([d, v]) => `${isoDaysAgo(d)},${v}`)].join("\n"),
    });
    updateInboxItems([
      {
        id: item.id,
        status: "structured",
        meta: {
          filename,
          demo: true,
          structuredAt: at(daysAgo, "10:01"),
          via: "csv",
          source,
          cells: rows.length,
          metrics: [metric],
        },
      },
    ]);
  };
  structuredDrop(8, "steps-export.csv", "steps", "steps", [
    [11, "7215"], [10, "9480"], [9, "11250"], [8, "6390"],
  ]);
  structuredDrop(6, "sleep-export.csv", "sleep", "hours", [
    [9, "7.4"], [8, "6.1"], [7, "8.0"], [6, "7.2"],
  ]);
  const rejected = appendInboxItem({
    source: "drop",
    kind: "csv",
    ts: at(16, "13:20"),
    meta: { filename: "old-tracker.csv", demo: true },
    text: "date,weight\nnot,a\nvalid,export",
  });
  updateInboxItems([
    {
      id: rejected.id,
      status: "discarded",
      meta: { filename: "old-tracker.csv", demo: true, rejectedAt: at(16, "13:24") },
    },
  ]);

  const sessionDay = (n: number) => `${isoDaysAgo(n)}T09:00:00.000Z`;
  appendSession({
    id: `${DEMO_SESSION_PREFIX}sleep-focus`,
    skill: "mentor",
    date: isoDaysAgo(34),
    startedAt: sessionDay(34),
    title: "Bad nights are eating the mornings",
    summary: "Looked at the last month: every sub-6h night is followed by a focus drop of about an hour and a mood dip. The lever is the bedtime, not the morning routine.",
    insights: ["Focus tracks sleep closely in this sample.", "Resting HR runs ~4 bpm higher after short nights."],
    commitments: ["Screens off by 23:00 on weeknights."],
  });
  appendSession({
    id: `${DEMO_SESSION_PREFIX}movement`,
    skill: "coach",
    date: isoDaysAgo(12),
    startedAt: sessionDay(12),
    title: "Movement is the mood lever",
    summary: "Workout days score about half a point higher on mood, and weekend step spikes carry into Monday. Rest days are fine — zero-movement days are the problem.",
    insights: ["Mood lifts on higher-step days.", "Two workouts a week is the current baseline."],
    commitments: ["One 30-minute walk on every rest day."],
  });
  appendSession({
    id: `${DEMO_SESSION_PREFIX}welcome`,
    skill: "mentor",
    title: "Sample session",
    summary: "A demo mentor session so the Journal timeline isn't empty. Connect a real source to replace all of this.",
    insights: ["This whole record is sample data — it vanishes on your first real import."],
    commitments: ["Connect one real source to see your own patterns."],
  });

  const cfg = readConfig();
  if (cfg) {
    cfg.demoSeeded = true;
    writeConfig(cfg);
  }
  rebuild({ recordDir: dir });
  return { days };
}

/** Remove every trace of the demo record and rebuild. Safe to call when none exists. */
export function clearDemo(): void {
  const dir = recordDir();
  for (const src of DEMO_SOURCES) {
    const file = path.join(dir, "daily", `${src}.csv`);
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  dropJsonlLines(
    path.join(dir, "inbox.jsonl"),
    (o) =>
      o.source === DEMO_INBOX_SOURCE ||
      Boolean((o.meta as { demo?: unknown } | null | undefined)?.demo),
  );
  dropJsonlLines(path.join(dir, "sessions.jsonl"), (o) => String(o.id ?? "").startsWith(DEMO_SESSION_PREFIX));

  const cfg = readConfig();
  if (cfg?.demoSeeded) {
    cfg.demoSeeded = false;
    writeConfig(cfg);
  }
  rebuild({ recordDir: dir });
}

/**
 * Call at the top of any real import: if demo data is present, wipe it first so a
 * real source never lands next to the sample rows. No-op once wiped.
 */
export function wipeDemoOnImport(): void {
  if (isDemoSeeded()) clearDemo();
}

/** Rewrite a .jsonl file dropping lines whose parsed object matches `drop`. */
function dropJsonlLines(file: string, drop: (o: Record<string, unknown>) => boolean): void {
  if (!fs.existsSync(file)) return;
  const kept: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (t === "") continue;
    try {
      if (drop(JSON.parse(t) as Record<string, unknown>)) continue;
    } catch {
      /* keep unparseable lines */
    }
    kept.push(t);
  }
  fs.writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "", "utf8");
}

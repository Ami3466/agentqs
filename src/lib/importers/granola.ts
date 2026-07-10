import {
  attendeeNames,
  countWords,
  discoverGranolaRefreshToken,
  getGranolaPanels,
  getGranolaTranscript,
  granolaAccessToken,
  isMeeting,
  listGranolaDocuments,
  meetingMinutes,
  meetingNotes,
  meetingTitle,
  transcriptToText,
  type GranolaDoc,
} from "../granola";
import {
  inWindow,
  type DailyTable,
  type ImporterContext,
  type ImporterEvent,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Granola — meetings, AI notes and transcripts.
 *
 * Auth is the desktop client's refresh token, picked up off this machine
 * automatically (`discoverCredential`) so the source connects with nothing to
 * paste. Each meeting lands three ways, because each is read differently:
 *
 *   record/daily/granola.csv        meetings · minutes · words   (graphs, sparkline)
 *   record/daily/granola_texts.csv  the day's notes as prose     (search + embeddings)
 *   record/events.jsonl             one event per meeting        (journal timeline)
 *
 * Events carry the verbatim transcript in `meta.transcript` — the full-resolution
 * copy — while the journal text stays the readable AI summary.
 */

/** Journal text stays readable; the transcript in `meta` keeps full resolution. */
const MAX_EVENT_TEXT = 4000;

/** A Granola document the importer has fully resolved (notes + transcript fetched).
 *  `meeting` separates something that actually happened from a note Granola keeps
 *  alongside it — both are indexed, only one counts as a meeting. */
interface Doc {
  doc: GranolaDoc;
  date: string;
  ts: string;
  title: string;
  notes: string;
  transcript: string;
  meeting: boolean;
  minutes: number;
  words: number;
  attendees: string[];
  url: string | null;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/** Wide daily table: one row per day Granola holds anything for. `notes` is its own
 *  column so a notes-only day still shows up rather than vanishing from the graphs. */
export function granolaDailyTable(docs: Doc[]): DailyTable {
  const byDate = new Map<string, { meetings: number; notes: number; minutes: number; words: number }>();
  for (const d of docs) {
    const agg = byDate.get(d.date) ?? { meetings: 0, notes: 0, minutes: 0, words: 0 };
    if (d.meeting) {
      agg.meetings += 1;
      agg.minutes += d.minutes;
    } else {
      agg.notes += 1;
    }
    agg.words += d.words;
    byDate.set(d.date, agg);
  }
  const rows = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, a]) => [date, String(a.meetings), String(a.notes), String(a.minutes), String(a.words)]);
  return { header: ["date", "meetings", "notes", "minutes", "words"], rows };
}

/** `date,chars,text` — the searchable prose column the journal importers all use.
 *  One cell per day, every document that day stacked under its own heading. */
export function granolaTextsTable(docs: Doc[]): DailyTable {
  const byDate = new Map<string, string[]>();
  for (const d of docs) {
    const body = d.notes || d.transcript;
    if (!body) continue;
    const time = d.ts.slice(11, 16);
    const who = d.attendees.length ? ` · with ${d.attendees.join(", ")}` : "";
    const head = `# ${d.title} (${time}${d.minutes ? `, ${d.minutes} min` : ""}${who})`;
    byDate.set(d.date, [...(byDate.get(d.date) ?? []), `${head}\n${body}`]);
  }
  const rows = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, parts]) => {
      const text = parts.join("\n\n");
      return [date, String(text.length), text];
    });
  return { header: ["date", "chars", "text"], rows };
}

/** One event per document. The Granola document id makes it idempotent: re-syncing
 *  a renamed or re-summarized meeting updates nothing and duplicates nothing. */
export function granolaEvents(docs: Doc[]): ImporterEvent[] {
  return docs.map((d) => ({
    id: `granola:${d.doc.id}`,
    date: d.date,
    ts: d.ts,
    title: d.title,
    text: clip(d.notes || d.transcript || d.title, MAX_EVENT_TEXT),
    url: d.url,
    meta: {
      doc_id: d.doc.id,
      kind: d.meeting ? "meeting" : "note",
      minutes: d.minutes,
      words: d.words,
      attendees: d.attendees,
      ...(d.transcript ? { transcript: d.transcript } : {}),
    },
  }));
}

export const granolaPlugin: ImporterPlugin = {
  id: "granola",
  name: "Granola",
  detail: "meetings, notes & transcripts",
  live: true,
  // The desktop app's login is discovered off this machine, so a signed-in user
  // connects with nothing to paste — but a pasted refresh token works everywhere.
  requiresCredential: false,
  credentialLabel: "Granola refresh token",
  credentialPlaceholder: "auto-detected from the Granola desktop app",
  credentialHelp: {
    url: "https://granola.ai",
    steps: [
      "Install the Granola desktop app on this machine and sign in.",
      "agentqs detects the login — press \"Connect (use detected app)\" to import it as a saved credential.",
    ],
  },
  envKey: "GRANOLA_REFRESH_TOKEN",
  primaryMetric: "meetings",
  unit: "meetings",
  // A meeting's AI notes/summary are regenerated after it ends, so a re-sync must
  // refresh its events rather than keep the first (maybe empty) copy.
  mutableEvents: true,
  discoverCredential: discoverGranolaRefreshToken,

  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const refreshToken = ctx.credential;
    if (!refreshToken) {
      throw new Error(
        "Granola isn't signed in on this machine — open the desktop app, or paste a refresh token.",
      );
    }

    let token: string;
    try {
      token = await granolaAccessToken(refreshToken, fetchImpl);
    } catch (e) {
      throw new Error(`Granola sign-in → ${(e as Error).message}`);
    }

    let docs: GranolaDoc[];
    try {
      docs = await listGranolaDocuments(token, fetchImpl);
    } catch (e) {
      throw new Error(`Granola get-documents → ${(e as Error).message}`);
    }

    const windowed = docs.filter((d) => {
      const created = (d.created_at ?? "").slice(0, 10);
      return created && inWindow(created, ctx.from, ctx.to);
    });

    const resolved: Doc[] = [];
    for (const doc of windowed) {
      // Notes and transcript are per-document endpoints; a missing one is normal
      // (a note with no recording) and must not fail the whole sync.
      const [panels, segments] = await Promise.all([
        getGranolaPanels(doc.id, token, fetchImpl).catch(() => []),
        getGranolaTranscript(doc.id, token, fetchImpl).catch(() => []),
      ]);
      const transcript = transcriptToText(segments);
      const notes = meetingNotes(doc, panels);
      if (!transcript && !notes) continue; // an empty stub — nothing to index
      const ts = doc.created_at ?? `${ctx.to}T00:00:00.000Z`;
      resolved.push({
        doc,
        date: ts.slice(0, 10),
        ts,
        title: meetingTitle(doc),
        notes,
        transcript,
        meeting: isMeeting(doc, segments),
        minutes: meetingMinutes(doc, segments),
        words: countWords(transcript),
        attendees: attendeeNames(doc),
        url: doc.google_calendar_event?.htmlLink ?? null,
      });
    }

    const meetings = resolved.filter((d) => d.meeting).length;
    return {
      table: granolaDailyTable(resolved),
      extraTables: { texts: granolaTextsTable(resolved) },
      events: granolaEvents(resolved),
      meta: { documents: docs.length, meetings, notes: resolved.length - meetings },
    };
  },
};

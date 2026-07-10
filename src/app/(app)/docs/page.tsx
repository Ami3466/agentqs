import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui";
import type { ReactNode } from "react";

/**
 * The in-app data-structure explainer — the target of the "?" next to page
 * titles. Static on purpose: this describes the storage CONTRACT (record →
 * derived indexes → hi-res sidecar), not live state; the Pipeline tab is the
 * live view.
 */

function Row({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <code className="w-44 shrink-0 font-mono text-[12px] text-fg">{name}</code>
      <span className="min-w-0 text-muted-fg">{children}</span>
    </div>
  );
}

function Section({ id, title, intro, children }: { id: string; title: string; intro: string; children?: ReactNode }) {
  return (
    <Card id={id} className="p-5">
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      <p className="mt-1 text-sm text-muted-fg">{intro}</p>
      {children ? <div className="mt-3 space-y-2">{children}</div> : null}
    </Card>
  );
}

export default function DocsPage() {
  return (
    <div>
      <PageHeader
        title="How your data is stored"
        subtitle="Three layers: a plain-text record you own, indexes derived from it, and heavy streams by reference."
      />
      <div className="space-y-4">
        <Section
          id="record"
          title="The record — source of truth"
          intro="Plain text files in record/ inside your data directory. Human-readable, git-friendly, and every change is revertible from the Log."
        >
          <Row name="daily/&lt;source&gt;.csv">
            One row per day, one column per metric, numbers whenever possible. What Graphs and the Journal table read.
          </Row>
          <Row name="events.jsonl">
            One line per item — a meeting, a page visit, a track, a message — with timestamp, title, text and link. The Journal timeline.
          </Row>
          <Row name="inbox.jsonl">Captures and memos, with their structure / reject history.</Row>
          <Row name="sessions.jsonl">AI sessions: summary, insights, commitments.</Row>
          <Row name="whoop/hr/&lt;day&gt;.csv">
            Per-minute streams, one small file per day; the day&apos;s rollup (avg, max) goes into daily columns.
          </Row>
        </Section>

        <Section
          id="indexes"
          title="Derived indexes — rebuildable"
          intro="Built from the record, never edited directly. agentqs rebuild recreates all of them, byte-identical."
        >
          <Row name="SQLite cache">The daily / events / sessions tables chat runs SQL on.</Row>
          <Row name="Full-text index">Keyword search over memos, sessions, events and journal text.</Row>
          <Row name="Vector index">On-device embeddings — recall searches by meaning, no API key.</Row>
          <Row name="Photo index">Thumbnails, captions and vision embeddings; your originals stay where they are.</Row>
        </Section>

        <Section
          id="detail"
          title="The detail store — detail.db"
          intro="Every point behind the daily rollups. A stream too dense for one row per day — per-minute heart rate, every browser visit — lands here as normal SQL tables, numbers indexed as numbers. Chat and agentqs query correlate them at full grain (detail.heart_rate, detail.chrome_visits); rebuild re-derives heart_rate from the record. daily keeps one value per day for day-to-day graphs; detail keeps the whole stream for within-day questions."
        />

        <Section
          id="new-sources"
          title="Where a new source lands"
          intro="Every integration follows the same rule, so nothing bloats the daily table."
        >
          <Row name="Numbers">Daily columns — sleep, steps, commits, messages per day.</Row>
          <Row name="Items with text">
            Meetings, emails, messages → events, searchable by keyword and meaning, plus a daily rollup.
          </Row>
          <Row name="Dense streams">Per-minute / per-visit data → per-day files in the record, indexed into the detail store, plus a daily rollup.</Row>
          <Row name="Photos">The photo index, embedded on-device.</Row>
        </Section>
      </div>
    </div>
  );
}

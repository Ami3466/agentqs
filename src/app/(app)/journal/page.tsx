import { PageHeader } from "@/components/page-header";
import { Badge, Card } from "@/components/ui";

export default function JournalPage() {
  return (
    <div>
      <PageHeader
        title="Journal"
        subtitle="Your life on one timeline — metrics, memos and mentor sessions, side by side."
        action={
          <div className="flex rounded-lg border border-border bg-card p-0.5 text-sm">
            <span className="rounded-md bg-muted px-3 py-1.5 font-medium text-fg">
              Timeline
            </span>
            <span className="px-3 py-1.5 text-muted-fg">Table</span>
          </div>
        }
      />

      <div className="space-y-3">
        {[
          { d: "Today", body: "Days will appear here once a source is connected." },
          { d: "Yesterday", body: "Metrics + memos + the session you had that day." },
        ].map((row) => (
          <Card key={row.d} className="flex gap-4 p-4">
            <div className="w-24 shrink-0 pt-0.5 text-sm font-medium text-muted-fg">
              {row.d}
            </div>
            <div className="flex-1">
              <div className="mb-2 flex flex-wrap gap-1.5">
                <Badge>sleep</Badge>
                <Badge>hr</Badge>
                <Badge>calendar</Badge>
              </div>
              <p className="text-sm text-muted-fg">{row.body}</p>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

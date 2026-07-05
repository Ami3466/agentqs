import { PageHeader } from "@/components/page-header";
import { GithubConnect } from "@/components/github-connect";
import { DataWorkspace } from "@/components/data-workspace";
import { Badge, Card } from "@/components/ui";

// Stub sources — wired one by one in later loops. GitHub is live (Loop 3).
const SOURCES = [
  { name: "WHOOP", kind: "api", detail: "per-minute heart rate, sleep, strain" },
  { name: "Google Calendar", kind: "api", detail: "meetings" },
  { name: "Apple Health", kind: "file", detail: "steps, HR, sleep, workouts" },
  { name: "Chrome history", kind: "file", detail: "what you read" },
];

export default function DataPage() {
  return (
    <div>
      <PageHeader
        title="Data"
        subtitle="One pipe, all your sources. Set a sync interval; drop files into the inbox."
      />

      <DataWorkspace>
        <Card className="divide-y divide-border">
          <GithubConnect />
          {SOURCES.map((s) => (
            <div key={s.name} className="flex items-center gap-3 p-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted text-sm font-semibold text-muted-fg">
                {s.name.charAt(0)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-fg">{s.name}</p>
                  <Badge>{s.kind}</Badge>
                </div>
                <p className="truncate text-xs text-muted-fg">{s.detail}</p>
              </div>
              <span className="text-xs text-muted-fg">not connected</span>
            </div>
          ))}
        </Card>
      </DataWorkspace>
    </div>
  );
}

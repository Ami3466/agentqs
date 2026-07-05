import { PageHeader } from "@/components/page-header";
import { Badge, Card } from "@/components/ui";

const SOURCES = [
  { name: "GitHub", kind: "api", detail: "commits per day" },
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

      <div className="grid gap-4 md:grid-cols-[1fr_260px]">
        <Card className="divide-y divide-border">
          {SOURCES.map((s) => (
            <div key={s.name} className="flex items-center gap-3 p-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted text-sm font-semibold text-muted-fg">
                {s.name.charAt(0)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-fg">
                    {s.name}
                  </p>
                  <Badge>{s.kind}</Badge>
                </div>
                <p className="truncate text-xs text-muted-fg">{s.detail}</p>
              </div>
              <span className="text-xs text-muted-fg">not connected</span>
            </div>
          ))}
        </Card>

        <Card className="p-4">
          <p className="text-sm font-semibold text-fg">Pending inbox</p>
          <p className="mt-1 text-xs text-muted-fg">
            Everything lands here raw and free. Hit <b>Structure</b> to turn it
            into clean daily data — you only spend tokens on the button.
          </p>
          <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-fg">
            Drop a CSV, export, or screenshot
          </div>
        </Card>
      </div>
    </div>
  );
}

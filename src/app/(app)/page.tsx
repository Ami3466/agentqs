import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui";

/** Chat tab — Loop 1 renders the 3-zone skeleton; the live mentor lands in Loop 5. */
export default function ChatPage() {
  return (
    <div>
      <PageHeader
        title="Chat"
        subtitle="Talk to your mentor. Plain text asks · >> logs a memo · / runs a command."
      />

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        {/* sessions sidebar */}
        <Card className="hidden p-3 lg:block">
          <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
            Sessions
          </p>
          <div className="rounded-lg bg-muted px-3 py-2 text-sm font-medium text-fg">
            New session
          </div>
          <p className="px-1 pt-3 text-xs text-muted-fg">
            Past sessions appear here once the mentor is live.
          </p>
        </Card>

        {/* conversation + input */}
        <Card className="flex min-h-[440px] flex-col">
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-lg font-medium text-fg">
              Ask your life anything.
            </p>
            <p className="max-w-md text-sm text-muted-fg">
              &ldquo;Why have I felt off this week?&rdquo; — grounded in your real
              sleep, heart rate, calendar and messages. The grounded mentor
              arrives in Loop 5.
            </p>
          </div>
          <div className="border-t border-border p-3">
            <div className="flex items-center gap-2 rounded-lg border border-input bg-bg px-3 py-2.5 text-sm text-muted-fg">
              Message your mentor…
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

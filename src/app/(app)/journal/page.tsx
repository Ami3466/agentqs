import { PageHeader } from "@/components/page-header";
import { JournalWorkspace } from "@/components/journal-workspace";

export default function JournalPage() {
  return (
    <div>
      <PageHeader title="Journal" helpHref="/docs#record" />
      <JournalWorkspace />
    </div>
  );
}

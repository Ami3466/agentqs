import { PageHeader } from "@/components/page-header";
import { JournalWorkspace } from "@/components/journal-workspace";

export default function JournalPage() {
  return (
    <div>
      <PageHeader
        title="Journal"
        subtitle="Your life on one timeline — metrics, memos and mentor sessions, side by side. Flip to a table to build and save your own column views."
      />
      <JournalWorkspace />
    </div>
  );
}

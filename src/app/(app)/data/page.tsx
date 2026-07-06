import { PageHeader } from "@/components/page-header";
import { DataWorkspace } from "@/components/data-workspace";

export default function DataPage() {
  return (
    <div>
      <PageHeader
        title="Data"
        subtitle="Drop any file to feed your record, or connect a live source that syncs on its own."
      />
      <DataWorkspace />
    </div>
  );
}

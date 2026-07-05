import { PageHeader } from "@/components/page-header";
import { DataWorkspace } from "@/components/data-workspace";

export default function DataPage() {
  return (
    <div>
      <PageHeader
        title="Data"
        subtitle="One pipe, all your sources. Set a sync interval per source; drop files into the inbox."
      />
      <DataWorkspace />
    </div>
  );
}

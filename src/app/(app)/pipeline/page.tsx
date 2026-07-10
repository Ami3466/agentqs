import { PageHeader } from "@/components/page-header";
import { DataWorkspace } from "@/components/data-workspace";

export default function PipelinePage() {
  return (
    <div>
      <PageHeader title="Pipeline" helpHref="/docs#new-sources" />
      <DataWorkspace />
    </div>
  );
}

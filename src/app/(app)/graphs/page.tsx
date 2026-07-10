import { PageHeader } from "@/components/page-header";
import { GraphsWorkspace } from "@/components/graphs-workspace";

export default function GraphsPage() {
  return (
    <div>
      <PageHeader title="Graphs" subtitle="Compare data points, counts, and timelines." helpHref="/docs#record" />
      <GraphsWorkspace />
    </div>
  );
}

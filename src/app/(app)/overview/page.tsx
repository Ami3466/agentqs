import { PageHeader } from "@/components/page-header";
import { CoverageGrid } from "@/components/coverage-grid";

export default function OverviewPage() {
  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="Every source, how far back it goes, and where the holes are. Click any cell to open it in the Journal."
        helpHref="/docs#record"
      />
      <CoverageGrid />
    </div>
  );
}

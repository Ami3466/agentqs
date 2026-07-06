import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { publicConfig, readConfig } from "@/lib/config";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const cfg = readConfig();
  if (!cfg) redirect("/setup");
  const pub = publicConfig(cfg);

  return (
    <div>
      <PageHeader title="Settings" />
      <SettingsForm config={pub} />
    </div>
  );
}

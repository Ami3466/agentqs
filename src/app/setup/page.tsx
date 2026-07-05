import { redirect } from "next/navigation";
import { configExists } from "@/lib/config";
import { AuthShell } from "@/components/auth-shell";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  // Already set up → nothing to create; go sign in.
  if (configExists()) redirect("/login");

  return (
    <AuthShell
      title="Create your agentqs"
      subtitle="One private instance, yours alone. Set a login and you're in."
    >
      <SetupForm />
    </AuthShell>
  );
}

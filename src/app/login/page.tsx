import { redirect } from "next/navigation";
import { configExists } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  // No instance yet → create one first.
  if (!configExists()) redirect("/setup");
  // Already signed in → straight to the app.
  if (getCurrentUser()) redirect("/");

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your agentqs.">
      <LoginForm />
    </AuthShell>
  );
}

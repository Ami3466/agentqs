import { redirect } from "next/navigation";
import { configExists } from "@/lib/config";
import { AuthShell } from "@/components/auth-shell";
import { ResetForm } from "./reset-form";

export const dynamic = "force-dynamic";

export default function ResetPage({ searchParams }: { searchParams: { token?: string | string[] } }) {
  // No instance yet → create one first.
  if (!configExists()) redirect("/setup");
  // No signed-in redirect here: the emailed link must work in a browser that
  // still holds an old session — that session is exactly what a reset kills.
  const raw = searchParams.token;
  const token = (Array.isArray(raw) ? raw[0] : raw) ?? "";

  return (
    <AuthShell title={token ? "Set a new password" : "Reset password"}>
      <ResetForm token={token} />
    </AuthShell>
  );
}

import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { configExists } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";

// This layout reads cookies + the config file on disk, so it must render per-request.
export const dynamic = "force-dynamic";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // First run: no config yet → send to signup.
  if (!configExists()) redirect("/setup");
  // Configured but no valid session → send to login.
  const user = getCurrentUser();
  if (!user) redirect("/login");

  return <AppShell username={user.username}>{children}</AppShell>;
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/icons";
import { Button, Field, Input } from "@/components/ui";

/** No token → ask for the link. Token (from the emailed link) → set the new password. */
export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentTo, setSentTo] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (token && password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    const res = await fetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(token ? { token, password } : { username: username.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(data.error || "Could not reset the password.");
    if (token) {
      // Every old session died with the reset — sign in with the new password.
      router.push("/login");
      router.refresh();
      return;
    }
    setSentTo(data.sentTo || "your inbox");
  }

  const back = (
    <Link href="/login" className="block text-center text-sm text-muted-fg hover:text-fg">
      Back to sign in
    </Link>
  );

  if (sentTo) {
    return (
      <div className="space-y-4">
        <p className="text-center text-sm text-fg" title="The link works once and expires in 30 minutes.">
          Link sent to {sentTo}.
        </p>
        {back}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {token ? (
        <>
          <Field label="New password" htmlFor="password">
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
            />
          </Field>
          <Field label="Confirm" htmlFor="confirm">
            <Input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </>
      ) : (
        <Field label="Email or username" htmlFor="username">
          <Input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="you@example.com or a username"
            autoComplete="username"
            autoFocus
          />
        </Field>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Button
        type="submit"
        variant="primary"
        disabled={busy}
        className="w-full"
        title={token ? "Signs out every existing session" : "Emails a single-use link, valid for 30 minutes"}
      >
        {busy ? <Spinner width={16} height={16} /> : null}
        {token ? (busy ? "Saving…" : "Set password") : busy ? "Sending…" : "Email me a link"}
      </Button>
      {back}
    </form>
  );
}

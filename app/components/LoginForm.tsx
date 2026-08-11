"use client";

import Image from "next/image";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Login fehlgeschlagen.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Netzwerkfehler. Bitte erneut versuchen.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="gate">
      <div className="gate-card">
        <div className="brand">
          <Image
            className="brand-logo"
            src="/logo.png"
            alt="industrial plants Logo"
            width={32}
            height={32}
            priority
          />
          <span className="brand-name">industrial plants</span>
        </div>
        <h1>Outreach Dashboard</h1>
        <p className="gate-text">
          Bitte melde dich mit deinen Zugangsdaten an, die du von deinem
          industrial-plants-Team erhalten hast.
        </p>

        <form className="login-form" onSubmit={submit}>
          <label className="field">
            <span>Benutzername</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </label>
          <label className="field">
            <span>Passwort</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>

          {error && <p className="form-error">{error}</p>}

          <button className="btn approve" type="submit" disabled={submitting}>
            {submitting ? "Melde an…" : "Anmelden"}
          </button>
        </form>
      </div>
    </main>
  );
}

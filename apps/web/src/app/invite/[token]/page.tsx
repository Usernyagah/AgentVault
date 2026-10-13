"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export default function InvitePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params.token;
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadInvite() {
      try {
        const response = await fetch(`${API_BASE}/api/onboarding/invites/${encodeURIComponent(token)}`);
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error(body.error || "This invite is no longer valid.");
        setEmail(body.data.email);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    void loadInvite();
  }, [token]);

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `${API_BASE}/api/onboarding/invites/${encodeURIComponent(token)}/accept`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email }),
        }
      );
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || "Unable to accept this invitation.");
      window.localStorage.setItem("agentvault.activityToken", body.data.activityToken);
      window.localStorage.setItem("agentvault.activityUser", JSON.stringify(body.data.user));
      router.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="invite-shell">
      <section className="card invite-card">
        <div className="eyebrow">AGENTVAULT · TEAM INVITATION</div>
        <h1 className="page-title">Join your team</h1>
        <p className="page-subtitle">
          Register to participate in this business treasury workspace. Activity
          metrics track page visits only—not wallet data or chat contents.
        </p>
        {email ? (
          <form className="invite-form" onSubmit={(event) => void accept(event)}>
            <label className="onboarding-field">
              Your name
              <input required autoComplete="name" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="onboarding-field">
              Invited email
              <input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label className="invite-consent">
              <input type="checkbox" required />
              <span>I understand that my profile, last-active time, and aggregate page activity are recorded for workspace participation metrics.</span>
            </label>
            <button className="btn btn-primary" disabled={busy}>{busy ? "Joining…" : "Accept invitation"}</button>
          </form>
        ) : (
          <div className="dashboard-empty">{error ? "This invite cannot be used." : "Checking invitation…"}</div>
        )}
        {error && <div className="ledger-error onboarding-flash" role="alert">{error}</div>}
      </section>
    </div>
  );
}

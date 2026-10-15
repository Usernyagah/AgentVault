"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";

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
        const result = await apiFetch<{ email: string }>(
          `/api/onboarding/invites/${encodeURIComponent(token)}`
        );
        setEmail(result.data.email);
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
      const result = await apiFetch<{
        activityToken: string;
        user: { id: string; name: string; email: string };
      }>(
        `/api/onboarding/invites/${encodeURIComponent(token)}/accept`,
        {
          method: "POST",
          body: JSON.stringify({ name, email }),
        }
      );
      window.localStorage.setItem("agentvault.activityToken", result.data.activityToken);
      window.localStorage.setItem("agentvault.activityUser", JSON.stringify(result.data.user));
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

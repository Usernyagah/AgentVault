"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

type WalletPurpose = "treasury" | "operations" | "reserves";

interface OnboardingStatus {
  complete: boolean;
  rules: { payrollDay: number; reservePercent: number; maxBorrowAmount: number };
  wallets: Partial<Record<WalletPurpose, { id: string }>>;
  invites: Array<{ email: string; createdAt: string; expiresAt: string; acceptedAt?: string }>;
  users: Array<{
    id: string;
    name: string;
    email: string;
    joinedAt: string;
    lastActiveAt: string;
    activityCounts: Record<string, number>;
  }>;
}

const purposes: Array<{ id: WalletPurpose; label: string; description: string }> = [
  { id: "treasury", label: "Treasury", description: "Primary business funds" },
  { id: "operations", label: "Operations", description: "Day-to-day payments" },
  { id: "reserves", label: "Reserves", description: "Protected liquidity" },
];

async function onboardingRequest<T>(
  path: string,
  adminToken: string,
  options?: RequestInit
): Promise<T> {
  const result = await apiFetch<T>(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...options?.headers,
    },
  });
  return result.data;
}

export default function OnboardingPage() {
  const [adminToken, setAdminToken] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [walletIds, setWalletIds] = useState<Record<WalletPurpose, string>>({
    treasury: "",
    operations: "",
    reserves: "",
  });
  const [payrollDay, setPayrollDay] = useState(1);
  const [reservePercent, setReservePercent] = useState(15);
  const [maxBorrowAmount, setMaxBorrowAmount] = useState(2000);
  const [inviteEmail, setInviteEmail] = useState("");
  const [createdInvite, setCreatedInvite] = useState<{ email: string; url: string; expiresAt: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = window.sessionStorage.getItem("agentvault.onboardingAdminToken");
    if (token) {
      setAdminToken(token);
      void unlock(token);
    }
  }, []);

  async function unlock(token = adminToken) {
    setBusy(true);
    setError(null);
    try {
      const result = await onboardingRequest<OnboardingStatus>("/api/onboarding", token);
      setStatus(result);
      setPayrollDay(result.rules.payrollDay);
      setReservePercent(result.rules.reservePercent);
      setMaxBorrowAmount(result.rules.maxBorrowAmount);
      setWalletIds({
        treasury: result.wallets.treasury?.id ?? "",
        operations: result.wallets.operations?.id ?? "",
        reserves: result.wallets.reserves?.id ?? "",
      });
      window.sessionStorage.setItem("agentvault.onboardingAdminToken", token);
      setUnlocked(true);
    } catch (cause) {
      setUnlocked(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function updateWallet(purpose: WalletPurpose, mode: "connect" | "create") {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await onboardingRequest<{ id: string }>("/api/onboarding/wallet", adminToken, {
        method: "POST",
        body: JSON.stringify({
          purpose,
          mode,
          walletId: walletIds[purpose],
        }),
      });
      setWalletIds((current) => ({ ...current, [purpose]: result.id }));
      setMessage(`${purpose} wallet ${mode === "create" ? "created" : "connected"} successfully.`);
      await refreshStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveRules(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await onboardingRequest("/api/onboarding/rules", adminToken, {
        method: "PUT",
        body: JSON.stringify({ payrollDay, reservePercent, maxBorrowAmount }),
      });
      setMessage("Treasury rules saved and applied to the agent.");
      await refreshStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const invite = await onboardingRequest<{ email: string; token: string; expiresAt: string }>(
        "/api/onboarding/invites",
        adminToken,
        { method: "POST", body: JSON.stringify({ email: inviteEmail }) }
      );
      setCreatedInvite({
        email: invite.email,
        url: `${window.location.origin}/invite/${encodeURIComponent(invite.token)}`,
        expiresAt: invite.expiresAt,
      });
      setInviteEmail("");
      setMessage("One-use invite link created. Copy and share it with the invitee.");
      await refreshStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus() {
    const result = await onboardingRequest<OnboardingStatus>("/api/onboarding", adminToken);
    setStatus(result);
  }

  async function copyInvite() {
    if (!createdInvite) return;
    try {
      await navigator.clipboard.writeText(createdInvite.url);
      setMessage("Invite link copied.");
    } catch {
      setError("Clipboard access was denied. Select and copy the invite link manually.");
    }
  }

  function lock() {
    window.sessionStorage.removeItem("agentvault.onboardingAdminToken");
    setAdminToken("");
    setUnlocked(false);
    setStatus(null);
  }

  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">GET STARTED</div>
          <h1 className="page-title">Quick setup</h1>
          <p className="page-subtitle">Connect your treasury, set guardrails, and bring your team in.</p>
        </div>
        {unlocked && <button className="btn btn-ghost" onClick={lock}>Lock setup</button>}
      </header>

      {!unlocked ? (
        <section className="card onboarding-lock">
          <h2 className="card-title">Administrator access</h2>
          <p className="onboarding-help">
            Set <code>ONBOARDING_ADMIN_TOKEN</code> in the API environment to a
            random value of at least 32 characters. Enter it here to manage
            wallets, rules, and invitations. It is held only for this browser tab.
          </p>
          <form className="onboarding-token-form" onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
            <input
              aria-label="Onboarding administrator token"
              autoComplete="off"
              type="password"
              value={adminToken}
              onChange={(event) => setAdminToken(event.target.value)}
              placeholder="Administrator token"
              required
            />
            <button className="btn btn-primary" disabled={busy}>{busy ? "Checking…" : "Unlock setup"}</button>
          </form>
        </section>
      ) : (
        <>
          {status && (
            <div className={`onboarding-progress ${status.complete ? "complete" : ""}`}>
              <span className="progress-mark">{status.complete ? "✓" : "1"}</span>
              <div>
                <strong>{status.complete ? "Treasury connected" : "Connect all three Circle wallets"}</strong>
                <p>{status.complete ? "Wallet IDs are configured for the agent." : "Use existing Arc testnet wallet IDs or create wallets in your configured Circle wallet set."}</p>
              </div>
              <span className="progress-count">
                {Object.values(status.wallets).filter(Boolean).length}/3
              </span>
            </div>
          )}

          <section className="onboarding-section">
            <div className="onboarding-section-heading">
              <span className="step-number">01</span>
              <div><h2>Connect Circle wallets</h2><p>Wallet IDs are verified with Circle and must be on Arc testnet.</p></div>
            </div>
            <div className="onboarding-wallet-grid">
              {purposes.map((wallet) => (
                <article className="card onboarding-wallet-card" key={wallet.id}>
                  <div className="wallet-role-head">
                    <div><h3>{wallet.label}</h3><p>{wallet.description}</p></div>
                    {status?.wallets[wallet.id] && <span className="connected-label">Connected</span>}
                  </div>
                  {status?.wallets[wallet.id] && (
                    <div className="connected-wallet-id">ID · {status.wallets[wallet.id]!.id}</div>
                  )}
                  <label className="onboarding-field">
                    Circle wallet ID
                    <input
                      value={walletIds[wallet.id]}
                      onChange={(event) => setWalletIds((current) => ({ ...current, [wallet.id]: event.target.value }))}
                      placeholder="Paste an existing Circle wallet ID"
                    />
                  </label>
                  <div className="onboarding-button-row">
                    <button className="btn btn-primary" disabled={busy || !walletIds[wallet.id].trim()} onClick={() => void updateWallet(wallet.id, "connect")}>
                      Connect existing
                    </button>
                    <button className="btn btn-ghost" disabled={busy} onClick={() => void updateWallet(wallet.id, "create")}>
                      Create in Circle
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="onboarding-section">
            <div className="onboarding-section-heading">
              <span className="step-number">02</span>
              <div><h2>Set business rules</h2><p>Payroll day prompts the forecast and the reserve percentage is enforced. Borrowing is disabled; its adapter is not verified.</p></div>
            </div>
            <form className="card onboarding-rules-form" onSubmit={(event) => void saveRules(event)}>
              <label className="onboarding-field">
                Payroll day of month
                <input type="number" min={1} max={31} required value={payrollDay} onChange={(event) => setPayrollDay(Number(event.target.value))} />
                <span>On this day, the forecast reminds the agent to preserve liquid payroll funds.</span>
              </label>
              <label className="onboarding-field">
                Reserve target (% of liquid balances)
                <input type="number" min={0} max={90} step={1} required value={reservePercent} onChange={(event) => setReservePercent(Number(event.target.value))} />
                <span>Payments and investments are blocked if the reserve wallet falls below this target or the configured minimum floor.</span>
              </label>
              <label className="onboarding-field">
                Maximum single borrow (USDC) · inactive
                <input type="number" min={0} step="0.01" value={maxBorrowAmount} disabled readOnly />
                <span>Coming soon – adapter only. This saved value does not enable borrowing or protect an active borrow flow.</span>
              </label>
              <button className="btn btn-primary" disabled={busy}>Save business rules</button>
            </form>
          </section>

          <section className="onboarding-section">
            <div className="onboarding-section-heading">
              <span className="step-number">03</span>
              <div><h2>Invite your team</h2><p>Create one-use links that expire in seven days. Share each link directly with its intended recipient.</p></div>
            </div>
            <div className="card onboarding-invite-card">
              <form className="onboarding-token-form" onSubmit={(event) => void createInvite(event)}>
                <input type="email" required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="teammate@business.com" aria-label="Invitee email address" />
                <button className="btn btn-primary" disabled={busy}>Create invite link</button>
              </form>
              <p className="onboarding-help">
                Invitees register using the invited email. Their profile, last-active
                time, and aggregate dashboard/chat/ledger/approval page counts are
                recorded for your traction metric. Financial amounts and chat contents
                are not included. This invite registers activity tracking; it is not
                a wallet-signing credential or secure app login.
              </p>
              {createdInvite && (
                <div className="created-invite">
                  <div><strong>Invite for {createdInvite.email}</strong><span>Expires {new Date(createdInvite.expiresAt).toLocaleString()}</span></div>
                  <input aria-label="One-time invite link" readOnly value={createdInvite.url} onFocus={(event) => event.currentTarget.select()} />
                  <button className="btn btn-ghost" onClick={() => void copyInvite()}>Copy link</button>
                </div>
              )}
              {status?.users.length ? (
                <div className="onboarding-users">
                  <h3>
                    Traction snapshot · {status.users.length} registered ·{" "}
                    {status.users.reduce(
                      (total, user) =>
                        total +
                        Object.values(user.activityCounts).reduce(
                          (sum, count) => sum + count,
                          0
                        ),
                      0
                    )}{" "}
                    tracked page views
                  </h3>
                  {status.users.map((user) => (
                    <div className="onboarding-user-row" key={user.id}>
                      <div><strong>{user.name}</strong><span>{user.email}</span></div>
                      <span>{Object.values(user.activityCounts).reduce((sum, count) => sum + count, 0)} views</span>
                      <time>Active {new Date(user.lastActiveAt).toLocaleString()}</time>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="onboarding-help">No teammates have accepted an invitation yet.</p>
              )}
              {status?.invites.length ? (
                <div className="onboarding-users">
                  <h3>Invitations</h3>
                  {status.invites.map((invite) => (
                    <div className="onboarding-user-row" key={`${invite.email}-${invite.createdAt}`}>
                      <div><strong>{invite.email}</strong></div>
                      <span>{invite.acceptedAt ? "Accepted" : new Date(invite.expiresAt) > new Date() ? "Pending" : "Expired"}</span>
                      <time>Expires {new Date(invite.expiresAt).toLocaleDateString()}</time>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        </>
      )}

      {error && <div className="ledger-error onboarding-flash" role="alert">{error}</div>}
      {message && <div className="onboarding-success onboarding-flash" role="status">{message}</div>}
    </>
  );
}

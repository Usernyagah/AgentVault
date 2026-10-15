"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { DashboardSummary, DecisionRecord } from "@agentvault/shared";
import { apiFetch, type ApplicationMode } from "@/lib/api";

interface LedgerRecord extends DecisionRecord {
  recordType: "decision" | "execution" | "verified_transaction";
  sequenceNumber: number;
  hash: string;
  previousHash: string;
}

interface Approval extends DecisionRecord {}

interface LedgerResponse {
  entries: LedgerRecord[];
  total: number;
  demoMode: boolean;
}

interface TractionTransaction {
  timestamp: string;
  action: string;
  amount: string;
  asset: "USDC" | "USYC";
  transactionHash: string;
  explorerUrl: string;
  verification: string;
  from?: string;
  to?: string;
}

interface TractionResponse {
  transactions: TractionTransaction[];
  demoMode: boolean;
  withheldInDemoMode: boolean;
}

interface TractionSummary {
  generatedAt: string;
  network: string;
  chainId: number;
  totalTransactions: number;
  totalUSDC: string;
  transactions: TractionTransaction[];
  demoMode: boolean;
}

function currency(value: string | undefined) {
  if (value === undefined) return "—";
  return `$${Number(value ?? "0").toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [auditEntries, setAuditEntries] = useState<LedgerRecord[]>([]);
  const [traction, setTraction] = useState<TractionTransaction[]>([]);
  const [tractionAction, setTractionAction] = useState<"send" | "receive">("send");
  const [tractionHash, setTractionHash] = useState("");
  const [tractionAmount, setTractionAmount] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [tractionBusy, setTractionBusy] = useState(false);
  const [tractionMessage, setTractionMessage] = useState<string | null>(null);
  const [tractionError, setTractionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [summaryResult, approvalsResult, ledgerResult, tractionResult] = await Promise.all([
        apiFetch<DashboardSummary>("/api/dashboard"),
        apiFetch<Approval[]>("/api/approvals"),
        apiFetch<LedgerResponse>("/api/ledger?limit=5"),
        apiFetch<TractionResponse>("/api/traction"),
      ]);
      const { data: nextSummary, mode } = summaryResult;
      if (
        approvalsResult.mode !== mode ||
        ledgerResult.mode !== mode ||
        tractionResult.mode !== mode ||
        nextSummary.demoMode !== (mode === "demo") ||
        ledgerResult.data.demoMode !== (mode === "demo") ||
        tractionResult.data.demoMode !== (mode === "demo") ||
        tractionResult.data.withheldInDemoMode !== (mode === "demo")
      ) {
        throw new Error("API mode changed while loading dashboard data. Refresh to avoid mixing Demo and Live records.");
      }
      setSummary(nextSummary);
      setApprovals(approvalsResult.data);
      setAuditEntries(ledgerResult.data.entries ?? []);
      setTraction(tractionResult.data.transactions ?? []);
      setError(null);
    } catch (cause) {
      setSummary(null);
      setApprovals([]);
      setAuditEntries([]);
      setTraction([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function toggleDemo() {
    setBusy(true);
    try {
      const enabled = !summary?.demoMode;
      const result = await apiFetch<{ enabled: boolean; mode: ApplicationMode }>("/api/demo", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
      if (result.data.mode !== result.mode || result.data.enabled !== (result.mode === "demo")) {
        throw new Error("The API returned inconsistent Demo/Live mode status.");
      }
      setSummary(null);
      setApprovals([]);
      setAuditEntries([]);
      setTraction([]);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function evaluate() {
    setBusy(true);
    try {
      const result = await apiFetch("/api/agent/evaluate", { method: "POST" });
      if (result.mode !== (summary?.demoMode ? "demo" : "live")) {
        throw new Error("Application mode changed; refusing to display potentially mixed evaluation results.");
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function decideApproval(id: string, action: "approve" | "reject") {
    setBusy(true);
    try {
      const result = await apiFetch(`/api/approvals/${id}/${action}`, { method: "POST" });
      if (result.mode !== (summary?.demoMode ? "demo" : "live")) {
        throw new Error("Application mode changed; refusing to display potentially mixed approval results.");
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function verifyTractionTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTractionBusy(true);
    setTractionError(null);
    setTractionMessage(null);
    try {
      const result = await apiFetch<{ entry: LedgerRecord; explorerUrl: string }>("/api/traction/verify", {
        method: "POST",
        headers: { Authorization: `Bearer ${verificationToken}` },
        body: JSON.stringify({
          transactionHash: tractionHash.trim(),
          amountUSDC: tractionAmount.trim(),
          action: tractionAction,
        }),
      });
      if (result.mode !== "live") {
        throw new Error("Transaction verification is only available in Live Mode.");
      }
      setTractionHash("");
      setTractionAmount("");
      setTractionMessage(`Verified and recorded ${result.data.entry.transactionHash}.`);
      await refresh();
    } catch (cause) {
      setTractionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTractionBusy(false);
    }
  }

  async function copyTractionSummary() {
    setTractionError(null);
    setTractionMessage(null);
    try {
      const response = await fetch("/api/traction/summary?format=markdown", { cache: "no-store" });
      if (response.headers.get("X-AgentVault-Mode") !== "live") {
        throw new Error("Switch to Live Mode to export real Arc transaction activity.");
      }
      const markdown = await response.text();
      if (!response.ok) throw new Error(markdown || `Summary request failed (${response.status}).`);
      await navigator.clipboard.writeText(markdown);
      setTractionMessage("Verified-activity Markdown copied to the clipboard.");
    } catch (cause) {
      setTractionError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function downloadTractionJson() {
    setTractionError(null);
    setTractionMessage(null);
    try {
      const result = await apiFetch<TractionSummary>("/api/traction/summary?format=json");
      if (result.mode !== "live" || result.data.demoMode) {
        throw new Error("Switch to Live Mode to export real Arc transaction activity.");
      }
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "agentvault-arc-testnet-traction.json";
      anchor.click();
      URL.revokeObjectURL(url);
      setTractionMessage("Verified-activity JSON downloaded.");
    } catch (cause) {
      setTractionError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const forecastEntries = summary?.forecast.entries ?? [];
  const maxForecast = Math.max(
    1,
    ...forecastEntries.map((entry) => Number(entry.projectedBalance))
  );

  return (
    <>
      <div className={`mode-banner ${summary ? (summary.demoMode ? "mode-banner-demo" : "mode-banner-live") : "mode-banner-unknown"}`} role="status" aria-live="polite">
        <strong>
          {summary
            ? summary.demoMode
              ? "DEMO MODE – Synthetic Data"
              : "LIVE MODE – Real Arc Testnet"
            : error
              ? "MODE UNKNOWN – Financial Data Hidden"
              : "VERIFYING MODE – Financial Data Withheld"}
        </strong>
        <span>
          {summary
            ? summary.demoMode
              ? "All balances, approvals, decisions, and audit entries below are simulated; no blockchain transaction is sent."
              : "Balances come from Circle Arc testnet wallets. Decisions and transaction outcomes come from the signed audit ledger."
            : error
              ? "The API mode could not be verified. No dashboard financial data is being shown."
              : "Waiting for a consistent Demo/Live mode from all API data sources."}
        </span>
      </div>
      <header className="dashboard-hero">
        <div>
          <div className="eyebrow">ARC TESTNET · FREELANCER TREASURY</div>
          <h1 className="page-title">Treasury overview</h1>
          <p className="page-subtitle">
            Liquidity, upcoming cash commitments, and recent decision activity.
          </p>
        </div>
        <div className="dashboard-actions">
          {summary && (
            <span className={`agent-status ${summary.agentStatus}`}>
              <span className="agent-status-dot" />
              {summary.agentStatus.replaceAll("_", " ")}
            </span>
          )}
          <button className="btn btn-demo" onClick={() => void toggleDemo()} disabled={busy}>
            {summary?.demoMode ? "Exit Demo Mode" : "▶ Try Demo Mode"}
          </button>
        </div>
      </header>

      {error && (
        <div className="dashboard-alert" role="alert">
          <strong>Dashboard data unavailable.</strong> {error}
          <button className="btn btn-ghost" onClick={() => void refresh()}>Retry</button>
        </div>
      )}

      <section className="stats-grid treasury-stats" aria-label="Treasury status">
        <StatCard label="Liquid treasury" value={currency(summary?.totalBalance)} hint={summary ? summary.demoMode ? "Simulated USDC across all wallets" : "Circle USDC across all wallets" : "Mode unverified"} icon="◈" />
        <StatCard label="USYC · Experimental" value={currency(summary?.usycYield)} hint="Experimental / Not fully verified on testnet" icon="↗" />
        <StatCard label="Borrowing" value="Coming soon" hint="Adapter only · disabled" icon="⌁" />
        <StatCard label="Needs your review" value={String(summary?.pendingTransactions ?? 0)} hint="Pending approvals" icon="◎" />
      </section>
      <div className="audit-demo-note" role="note">
        USYC save/redeem is experimental and not fully verified on testnet. Borrowing is disabled; only an unverified adapter exists.
      </div>

      <section className="wallet-strip" aria-label="Wallet balances">
        <WalletBalance name="Treasury" balance={summary?.treasuryBalance} demoMode={summary?.demoMode ?? null} />
        <WalletBalance name="Operations" balance={summary?.operationsBalance} demoMode={summary?.demoMode ?? null} />
        <WalletBalance name="Reserves" balance={summary?.reservesBalance} demoMode={summary?.demoMode ?? null} />
        <span className="live-indicator"><i /> Updates every 8 seconds</span>
      </section>

      <section className="dashboard-grid">
        <div className="card dashboard-panel forecast-panel">
          <div className="card-header">
            <div>
              <div className="eyebrow">CASH MANAGEMENT · 7-DAY OUTLOOK</div>
              <h2 className="card-title">Cash-flow forecast</h2>
            </div>
            <span className="forecast-horizon">Next 7 days</span>
          </div>
          {summary?.forecast.summary ? (
            <>
              <p className="forecast-summary">{summary.forecast.summary}</p>
              <div className="forecast-chart" aria-label="Projected cash balance">
                {forecastEntries.map((entry) => (
                  <div className="forecast-day" key={entry.date} title={`${entry.date}: ${currency(entry.projectedBalance)}`}>
                    <div className="forecast-bar-wrap">
                      <div
                        className="forecast-bar"
                        style={{ height: `${Math.max(8, (Number(entry.projectedBalance) / maxForecast) * 100)}%` }}
                      />
                    </div>
                    <span className="forecast-day-label">
                      {new Date(`${entry.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" })}
                    </span>
                    <span className="forecast-day-value">{currency(entry.projectedBalance)}</span>
                  </div>
                ))}
              </div>
              <div className="forecast-recommendation">
                <span>AGENT OUTLOOK</span>
                <p>{summary.forecast.recommendation}</p>
              </div>
            </>
          ) : (
            <EmptyState loading={loading} text="Forecast data will appear when treasury data is available." />
          )}
        </div>

        <div className="card dashboard-panel decision-panel">
          <div className="card-header">
            <div>
              <div className="eyebrow">DECISION ACTIVITY</div>
              <h2 className="card-title">Agent decisions</h2>
            </div>
            <a href="/ledger" className="text-link">Full history →</a>
          </div>
          {summary?.recentDecisions?.length ? (
            <div className="decision-list">
              {summary.recentDecisions.slice(0, 4).map((decision) => (
                <article className="decision-item" key={decision.id}>
                  <div className="decision-item-top">
                    <span className={`decision-icon action-${decision.action}`}>
                      {decision.action === "receive" ? "↓" : decision.action === "send" ? "↑" : "◇"}
                    </span>
                    <div className="decision-title">
                      <strong>{decision.action.replaceAll("_", " ")}</strong>
                      <span>{new Date(decision.timestamp).toLocaleString()}</span>
                    </div>
                    <span className={`record-mode-tag ${summary.demoMode ? "record-mode-simulated" : "record-mode-live"}`}>
                      {summary.demoMode ? "SIMULATED" : "LIVE LEDGER"}
                    </span>
                    <strong className="decision-amount">{currency(decision.amountUSDC)}</strong>
                  </div>
                  <p>{decision.reasoning}</p>
                  <div className="decision-rule">RULE <b>{decision.ruleApplied}</b></div>
                  <div className="decision-outcome">{decision.actionTaken}</div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState loading={loading} text="Agent decisions and their reasoning will appear here." />
          )}
          <button className="btn btn-primary evaluate-button" onClick={() => void evaluate()} disabled={busy}>
            {busy ? "Working…" : "Run agent evaluation"}
          </button>
        </div>
      </section>

      <section className="dashboard-grid lower-grid">
        <div className="card dashboard-panel approval-panel">
          <div className="card-header">
            <div>
              <div className="eyebrow">HUMAN REVIEW</div>
              <h2 className="card-title">Approval queue</h2>
            </div>
            <a href="/approvals" className="text-link">Review all →</a>
          </div>
          {approvals.length ? approvals.slice(0, 3).map((approval) => (
            <article className="approval-inline" key={approval.id}>
              <div className="approval-inline-copy">
                <strong>{approval.action.replaceAll("_", " ")} · {currency(approval.amountUSDC)}</strong>
                <span className={`record-mode-tag ${summary?.demoMode ? "record-mode-simulated" : "record-mode-live"}`}>
                  {summary?.demoMode ? "SIMULATED APPROVAL" : "LIVE LEDGER"}
                </span>
                <p>{approval.reasoning}</p>
              </div>
              <div className="approval-inline-actions">
                <button className="btn btn-success" disabled={busy} onClick={() => void decideApproval(approval.id, "approve")}>Approve</button>
                <button className="btn btn-danger" disabled={busy} onClick={() => void decideApproval(approval.id, "reject")}>Reject</button>
              </div>
            </article>
          )) : <EmptyState loading={loading} text="No decisions are waiting for your approval." />}
        </div>

        <div className="card dashboard-panel audit-panel">
          <div className="card-header">
            <div>
              <div className="eyebrow">ACCOUNTABILITY · SIGNED RECORDS</div>
              <h2 className="card-title">Audit activity</h2>
            </div>
            <a href="/ledger" className="text-link">Open ledger →</a>
          </div>
          {summary?.demoMode && <div className="audit-demo-note">Simulation records — not cryptographically signed or sent on-chain.</div>}
          {auditEntries.length ? auditEntries.slice(0, 4).map((entry) => (
            <div className="audit-row" key={entry.id}>
              <span className="audit-sequence">#{entry.sequenceNumber}</span>
              <div>
                <strong>{entry.action.replaceAll("_", " ")}</strong>
                <span className={`record-mode-tag ${summary?.demoMode ? "record-mode-simulated" : "record-mode-live"}`}>
                  {summary?.demoMode ? "SIMULATED" : "LIVE LEDGER"}
                </span>
                <span>{entry.actionTaken}</span>
              </div>
              <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
            </div>
          )) : <EmptyState loading={loading} text="New decisions will be recorded in the append-only ledger." />}
        </div>
      </section>

      <section className="card traction-panel" aria-labelledby="traction-title">
        <div className="card-header">
          <div>
            <div className="eyebrow">REAL ARC TESTNET ACTIVITY</div>
            <h2 className="card-title" id="traction-title">Traction</h2>
            <p className="text-sm text-muted">Only successful, hash-backed transactions verified on Arc testnet are included.</p>
          </div>
          {summary?.demoMode === false && (
            <div className="traction-export-actions">
              <button className="btn btn-ghost" onClick={() => void copyTractionSummary()} disabled={traction.length === 0}>
                Copy submission Markdown
              </button>
              <button className="btn btn-ghost" onClick={() => void downloadTractionJson()} disabled={traction.length === 0}>
                Download JSON
              </button>
            </div>
          )}
        </div>

        {summary?.demoMode !== false ? (
          <div className="traction-empty">
            {summary?.demoMode
              ? "Real traction is hidden while Demo Mode is active so simulated and live data stay separate."
              : "Waiting for a verified Live Mode before showing Arc activity."}
          </div>
        ) : (
          <>
            {tractionError && <div className="ledger-error" role="alert">{tractionError}</div>}
            {tractionMessage && <div className="traction-success" role="status">{tractionMessage}</div>}

            {traction.length ? (
              <div className="traction-list">
                {traction.map((transaction) => (
                  <article className="traction-item" key={transaction.transactionHash}>
                    <div>
                      <strong>CONFIRMED · {transaction.action.toUpperCase()} · {transaction.asset === "USDC" ? currency(transaction.amount) : `${Number(transaction.amount).toLocaleString("en-US", { maximumFractionDigits: 6 })} USYC`}</strong>
                      <span>{new Date(transaction.timestamp).toLocaleString()} · {transaction.verification}</span>
                      {transaction.from && transaction.to && (
                        <span className="traction-addresses">From {transaction.from} → To {transaction.to}</span>
                      )}
                    </div>
                    <a href={transaction.explorerUrl} target="_blank" rel="noreferrer">
                      {transaction.transactionHash}
                    </a>
                  </article>
                ))}
              </div>
            ) : (
              <div className="traction-empty">No real confirmed transactions have been recorded yet.</div>
            )}

            <form className="traction-form" onSubmit={(event) => void verifyTractionTransaction(event)}>
              <div className="traction-form-heading">
                <strong>Manually verify an Arc USDC transfer</strong>
                <span>The API checks a successful Arc receipt and exact USDC amount before signing it. Send/receive is your classification; sender and recipient are read from the chain.</span>
              </div>
              <label>
                Transaction hash
                <input
                  value={tractionHash}
                  onChange={(event) => setTractionHash(event.target.value)}
                  placeholder="0x…"
                  pattern="0x[0-9a-fA-F]{64}"
                  required
                />
              </label>
              <label>
                Amount (USDC)
                <input
                  type="number"
                  min="0.000001"
                  step="0.000001"
                  value={tractionAmount}
                  onChange={(event) => setTractionAmount(event.target.value)}
                  placeholder="25.00"
                  required
                />
              </label>
              <label>
                Type
                <select value={tractionAction} onChange={(event) => setTractionAction(event.target.value as "send" | "receive")}>
                  <option value="send">Send</option>
                  <option value="receive">Receive</option>
                </select>
              </label>
              <label>
                Admin verification token
                <input
                  type="password"
                  value={verificationToken}
                  onChange={(event) => setVerificationToken(event.target.value)}
                  autoComplete="off"
                  required
                />
              </label>
              <button className="btn btn-primary" type="submit" disabled={tractionBusy || !verificationToken}>
                {tractionBusy ? "Checking Arc receipt…" : "Verify and record"}
              </button>
            </form>
          </>
        )}
      </section>
    </>
  );
}

function StatCard({ label, value, hint, icon }: { label: string; value: string; hint: string; icon: string }) {
  return (
    <article className="stat-card treasury-stat">
      <div className="stat-icon">{icon}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-change">{hint}</div>
    </article>
  );
}

function WalletBalance({ name, balance, demoMode }: { name: string; balance: string | undefined; demoMode: boolean | null }) {
  const source = demoMode === null ? "mode unverified" : demoMode ? "simulated" : "Circle";
  return <div className="wallet-balance"><span>{name} · {source}</span><strong>{currency(balance)}</strong></div>;
}

function EmptyState({ loading, text }: { loading: boolean; text: string }) {
  return <div className="dashboard-empty">{loading ? "Loading treasury data…" : text}</div>;
}

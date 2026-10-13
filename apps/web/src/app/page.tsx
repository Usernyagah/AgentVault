"use client";

import { useCallback, useEffect, useState } from "react";
import type { DashboardSummary, DecisionRecord } from "@agentvault/shared";

interface LedgerRecord extends DecisionRecord {
  recordType: "decision" | "execution";
  sequenceNumber: number;
  hash: string;
  previousHash: string;
}

interface Approval extends DecisionRecord {}

interface LedgerResponse {
  entries: LedgerRecord[];
  total: number;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(body.error || `API request failed (${response.status}).`);
  }
  return body.data as T;
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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextSummary, nextApprovals, ledger] = await Promise.all([
        requestJson<DashboardSummary>("/api/dashboard"),
        requestJson<Approval[]>("/api/approvals"),
        requestJson<LedgerResponse>("/api/ledger?limit=5"),
      ]);
      setSummary(nextSummary);
      setApprovals(nextApprovals);
      setAuditEntries(ledger.entries ?? []);
      setError(null);
    } catch (cause) {
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
      await requestJson<{ enabled: boolean }>("/api/demo", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
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
      await requestJson("/api/agent/evaluate", { method: "POST" });
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
      await requestJson(`/api/approvals/${id}/${action}`, { method: "POST" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const forecastEntries = summary?.forecast.entries ?? [];
  const maxForecast = Math.max(
    1,
    ...forecastEntries.map((entry) => Number(entry.projectedBalance))
  );

  return (
    <>
      <header className="dashboard-hero">
        <div>
          <div className="eyebrow">ARC TESTNET · FREELANCER TREASURY</div>
          <h1 className="page-title">Treasury overview</h1>
          <p className="page-subtitle">
            Liquidity, upcoming cash commitments, and recent decision activity.
          </p>
        </div>
        <div className="dashboard-actions">
          {summary?.demoMode && <span className="demo-pill">DEMO SIMULATION</span>}
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
        <StatCard label="Liquid treasury" value={currency(summary?.totalBalance)} hint="USDC across all wallets" icon="◈" />
        <StatCard label="Yield position" value={currency(summary?.usycYield)} hint="USYC held" icon="↗" />
        <StatCard label="Outstanding loans" value={currency(summary?.outstandingLoans)} hint="Net recorded loan activity" icon="⌁" />
        <StatCard label="Needs your review" value={String(summary?.pendingTransactions ?? 0)} hint="Pending approvals" icon="◎" />
      </section>

      <section className="wallet-strip" aria-label="Wallet balances">
        <WalletBalance name="Treasury" balance={summary?.treasuryBalance} />
        <WalletBalance name="Operations" balance={summary?.operationsBalance} />
        <WalletBalance name="Reserves" balance={summary?.reservesBalance} />
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
                <span>{entry.actionTaken}</span>
              </div>
              <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
            </div>
          )) : <EmptyState loading={loading} text="New decisions will be recorded in the append-only ledger." />}
        </div>
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

function WalletBalance({ name, balance }: { name: string; balance: string | undefined }) {
  return <div className="wallet-balance"><span>{name}</span><strong>{currency(balance)}</strong></div>;
}

function EmptyState({ loading, text }: { loading: boolean; text: string }) {
  return <div className="dashboard-empty">{loading ? "Loading treasury data…" : text}</div>;
}

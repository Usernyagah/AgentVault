// ────────────────────────────────────────────────
// Audit Ledger Page – Append-Only Decision Log
// ────────────────────────────────────────────────
"use client";

import { useState, useEffect } from "react";

interface LedgerEntry {
  id: string;
  recordType: "decision" | "execution";
  relatedDecisionId?: string;
  sequenceNumber: number;
  timestamp: string;
  balanceSeen: {
    treasury: string;
    operations: string;
    reserves: string;
  };
  balanceSeenUSYC: {
    treasury: string;
    operations: string;
    reserves: string;
  };
  forecast: string;
  reasoning: string;
  ruleApplied: string;
  actionTaken: string;
  action: string;
  amountUSDC: string;
  transactionHash?: string;
  transactionId?: string;
  hash: string;
  previousHash: string;
  agentSignature: string;
  requiresApproval: boolean;
  withinDailyLimit: boolean;
}

const PAGE_SIZE = 100;

export default function LedgerPage() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [chainValid, setChainValid] = useState<boolean | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setOffset(0);
  }, [search, action]);

  useEffect(() => {
    void fetchLedger(offset);
  }, [search, action, offset]);

  async function fetchLedger(nextOffset = offset) {
    setLoading(true);
    setLoadError(null);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(nextOffset),
      });
      if (search.trim()) params.set("q", search.trim());
      if (action) params.set("action", action);

      const [ledgerRes, verifyRes] = await Promise.all([
        fetch(`${apiUrl}/api/ledger?${params.toString()}`),
        fetch(`${apiUrl}/api/ledger/verify`),
      ]);
      if (!ledgerRes.ok || !verifyRes.ok) {
        throw new Error(`Ledger request failed (${ledgerRes.status}/${verifyRes.status}).`);
      }
      const [ledgerJson, verifyJson] = await Promise.all([
        ledgerRes.json(),
        verifyRes.json(),
      ]);
      if (!ledgerJson.success) throw new Error(ledgerJson.error || "Unable to load audit records.");
      if (!verifyJson.success) throw new Error(verifyJson.error || "Unable to verify the audit chain.");

      setEntries(ledgerJson.data?.entries ?? []);
      setTotal(ledgerJson.data?.total ?? 0);
      setChainValid(verifyJson.data?.valid ?? null);
      setDemoMode(verifyJson.data?.demoMode === true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  const actionColors: Record<string, string> = {
    send: "var(--status-error)",
    receive: "var(--status-success)",
    invest_usyc: "var(--accent-2)",
    redeem_usyc: "var(--accent-3)",
    borrow: "var(--status-warning)",
    repay: "var(--status-info)",
    bridge: "var(--accent-1)",
    hold: "var(--text-muted)",
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Audit Ledger</h1>
          <p className="page-subtitle">
            Signed, persistent append-only log of decisions and execution outcomes
          </p>
        </div>
        <div className="flex gap-4 items-center">
          {chainValid !== null && (
            <span
              className={`agent-status ${chainValid ? "idle" : "awaiting_approval"}`}
            >
              <span className="agent-status-dot" />
              Chain {chainValid ? "Valid ✓" : "BROKEN ✗"}
            </span>
          )}
          {demoMode && <span className="demo-pill">SIMULATED · NOT SIGNED</span>}
          <button className="btn btn-ghost" onClick={() => void fetchLedger()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {demoMode && (
        <div className="audit-demo-note">
          Demo Mode is showing synthetic sample records. Their signatures and hashes
          are placeholders; no transaction was sent on-chain.
        </div>
      )}

      <div className="ledger-filters">
        <label>
          Search records
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Reasoning, rule, forecast, transaction…"
          />
        </label>
        <label>
          Action
          <select value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="">All actions</option>
            {Object.keys(actionColors).map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <span className="text-sm text-muted">{total} record(s)</span>
      </div>

      {loadError && (
        <div className="ledger-error" role="alert">
          Unable to load audit ledger: {loadError}
        </div>
      )}

      <div className="card" id="ledger-table">
        {entries.length === 0 ? (
          <div className="ledger-empty">
            <p style={{ fontSize: "32px", marginBottom: "12px" }}>📒</p>
            <p>{loading ? "Loading audit records…" : "No matching audit records."}</p>
            {!loading && (
              <p style={{ marginTop: "8px" }}>
                Decisions include observed balances, forecast, reasoning, policy,
                signed record details, and transaction outcomes when available.
              </p>
            )}
          </div>
        ) : (
          <>
            {entries.map((entry) => (
              <article key={entry.id} className="ledger-entry">
                <span className="ledger-seq">#{entry.sequenceNumber}</span>
                <div className="ledger-entry-body">
                  <div className="ledger-entry-heading">
                    <span
                      className="ledger-action"
                      style={{ color: actionColors[entry.action] || "inherit" }}
                    >
                      {entry.action.replaceAll("_", " ")}
                    </span>
                    <span className="ledger-record-type">{entry.recordType}</span>
                    <span className="ledger-amount">${entry.amountUSDC}</span>
                    <time className="text-sm text-muted" dateTime={entry.timestamp}>
                      {new Date(entry.timestamp).toLocaleString()}
                    </time>
                  </div>
                  <dl className="ledger-details">
                    <div>
                      <dt>Observed balances (USDC / USYC)</dt>
                      <dd>
                        Treasury ${entry.balanceSeen.treasury} · Operations $
                        {entry.balanceSeen.operations} · Reserves ${entry.balanceSeen.reserves}
                      </dd>
                      <dd>
                        USYC — Treasury {entry.balanceSeenUSYC.treasury} · Operations{" "}
                        {entry.balanceSeenUSYC.operations} · Reserves{" "}
                        {entry.balanceSeenUSYC.reserves}
                      </dd>
                    </div>
                    <div>
                      <dt>Cash-flow forecast</dt>
                      <dd>{entry.forecast}</dd>
                    </div>
                    <div>
                      <dt>Reasoning</dt>
                      <dd>{entry.reasoning}</dd>
                    </div>
                    <div>
                      <dt>Rule applied</dt>
                      <dd>{entry.ruleApplied}</dd>
                    </div>
                    <div>
                      <dt>Action taken</dt>
                      <dd>{entry.actionTaken}</dd>
                    </div>
                    {entry.transactionHash && (
                      <div>
                        <dt>Transaction hash</dt>
                        <dd className="ledger-hash">{entry.transactionHash}</dd>
                      </div>
                    )}
                    {entry.transactionId && (
                      <div>
                        <dt>Transaction ID</dt>
                        <dd className="ledger-hash">{entry.transactionId}</dd>
                      </div>
                    )}
                    {entry.relatedDecisionId && (
                      <div>
                        <dt>Decision record</dt>
                        <dd className="ledger-hash">{entry.relatedDecisionId}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Agent signature</dt>
                      <dd className="ledger-hash">{entry.agentSignature}</dd>
                    </div>
                    <div>
                      <dt>Record hash / previous</dt>
                      <dd className="ledger-hash">
                        {entry.hash} / {entry.previousHash}
                      </dd>
                    </div>
                  </dl>
                </div>
              </article>
            ))}
            {offset + PAGE_SIZE < total && (
              <div className="ledger-pagination">
                <button
                  className="btn btn-ghost"
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  disabled={loading}
                >
                  Load older records
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

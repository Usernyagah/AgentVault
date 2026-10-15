// ────────────────────────────────────────────────
// Approvals Page – Human-in-the-Loop Oversight
// ────────────────────────────────────────────────
"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";

interface Approval {
  id: string;
  action: string;
  amountUSDC: string;
  reasoning: string;
  ruleApplied: string;
  confidence: number;
  forecast: string;
  balanceSeen: {
    treasury: string;
    operations: string;
    reserves: string;
  };
  timestamp: string;
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [demoMode, setDemoMode] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    fetchApprovals();
  }, []);

  async function fetchApprovals() {
    try {
      const [approvalsResult, demoResult] = await Promise.all([
        apiFetch<Approval[]>("/api/approvals"),
        apiFetch<{ enabled: boolean; mode: "demo" | "live" }>("/api/demo"),
      ]);
      const mode = demoResult.data.mode;
      if (
        (mode !== "demo" && mode !== "live") ||
        approvalsResult.mode !== mode ||
        demoResult.mode !== mode ||
        demoResult.data.enabled !== (mode === "demo")
      ) {
        throw new Error("API mode changed while loading approvals. Refresh to avoid mixing Demo and Live records.");
      }
      setApprovals(approvalsResult.data);
      setDemoMode(mode === "demo");
      setActionError(null);
    } catch (error) {
      setApprovals([]);
      setDemoMode(null);
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleApproval(id: string, action: "approve" | "reject") {
    try {
      const result = await apiFetch(`/api/approvals/${id}/${action}`, { method: "POST" });
      if (demoMode === null || result.mode !== (demoMode ? "demo" : "live")) {
        throw new Error("Application mode changed; refusing to display a potentially mixed approval result.");
      }
      await fetchApprovals();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Pending Approvals</h1>
          <p className="page-subtitle">
            Decisions that exceed your approval threshold require human sign-off
          </p>
        </div>
        <button className="btn btn-ghost" onClick={fetchApprovals}>
          Refresh
        </button>
      </div>

      <div className={`mode-banner ${demoMode === null ? "mode-banner-unknown" : demoMode ? "mode-banner-demo" : "mode-banner-live"}`} role="status">
        <strong>
          {demoMode === null
            ? "MODE UNKNOWN – Approvals Hidden"
            : demoMode
              ? "DEMO MODE – Synthetic Data"
              : "LIVE MODE – Real Arc Testnet"}
        </strong>
        <span>
          {demoMode === null
            ? "The API mode could not be verified. No approval data is being shown."
            : demoMode
            ? "Approvals and displayed decisions are simulated. Approve/reject only changes the demo; no blockchain transaction is sent."
            : "Approvals and displayed decisions are from the live application ledger. Approval can execute a real Circle Arc testnet transaction."}
        </span>
      </div>
      {actionError && <div className="ledger-error" role="alert">{actionError}</div>}

      {demoMode === null ? (
        <div className="card ledger-empty">Waiting for verified API mode before displaying approval records.</div>
      ) : approvals.length === 0 ? (
        <div
          className="card"
          style={{
            color: "var(--text-muted)",
            fontSize: "14px",
            padding: "48px 24px",
            textAlign: "center",
          }}
        >
          <p style={{ fontSize: "32px", marginBottom: "12px" }}>✅</p>
          <p>No pending approvals.</p>
          <p style={{ marginTop: "8px" }}>
            When the agent proposes a transaction above your approval threshold,
            it will appear here for your review.
          </p>
        </div>
      ) : (
        approvals.map((a) => (
          <div key={a.id} className="approval-card" id={`approval-${a.id}`}>
            <div className="approval-card-header">
              <div>
                <span
                  className="ledger-action"
                  style={{ fontSize: "16px", marginBottom: "4px" }}
                >
                  {a.action.replace("_", " ")}
                </span>
                <span className="ledger-amount" style={{ marginLeft: "12px" }}>
                  ${a.amountUSDC} USDC
                </span>
              </div>
              <span className="agent-status awaiting_approval">
                <span className="agent-status-dot" />
                Awaiting Approval
              </span>
            </div>

            <div className="flex-col gap-2">
              <p style={{ fontSize: "14px" }}>
                <strong>Reasoning:</strong> {a.reasoning}
              </p>
              <p className="text-sm text-muted">
                <strong>Forecast:</strong> {a.forecast}
              </p>
              <p className="text-sm text-muted">
                <strong>Rule:</strong> {a.ruleApplied} | Confidence:{" "}
                {(a.confidence * 100).toFixed(0)}%
              </p>
              <p className="text-sm text-muted">
                <strong>Balances at decision:</strong> Treasury $
                {a.balanceSeen.treasury} · Operations ${a.balanceSeen.operations}{" "}
                · Reserves ${a.balanceSeen.reserves}
              </p>
            </div>

            <div className="approval-card-actions">
              <button
                className="btn btn-success"
                onClick={() => handleApproval(a.id, "approve")}
              >
                {demoMode ? "✓ Approve Simulation" : "✓ Approve & Execute"}
              </button>
              <button
                className="btn btn-danger"
                onClick={() => handleApproval(a.id, "reject")}
              >
                ✗ Reject
              </button>
            </div>
          </div>
        ))
      )}
    </>
  );
}

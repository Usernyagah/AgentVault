// ────────────────────────────────────────────────
// Approvals Page – Human-in-the-Loop Oversight
// ────────────────────────────────────────────────
"use client";

import { useState, useEffect } from "react";

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
  const [demoMode, setDemoMode] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    fetchApprovals();
  }, []);

  async function fetchApprovals() {
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
      const [res, demoRes] = await Promise.all([
        fetch(`${apiUrl}/api/approvals`),
        fetch(`${apiUrl}/api/demo`),
      ]);
      if (!res.ok || !demoRes.ok) throw new Error("Unable to load approval status.");
      const [json, demoJson] = await Promise.all([res.json(), demoRes.json()]);
      if (!json.success || !demoJson.success) throw new Error(json.error || demoJson.error || "Unable to load approvals.");
      setApprovals(json.data || []);
      setDemoMode(demoJson.data?.enabled === true);
      setActionError(null);
    } catch {
      setActionError("Could not connect to the API. Approval status may be out of date.");
    }
  }

  async function handleApproval(id: string, action: "approve" | "reject") {
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
      const response = await fetch(`${apiUrl}/api/approvals/${id}/${action}`, { method: "POST" });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "Approval action failed.");
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

      {demoMode && (
        <div className="audit-demo-note">
          Demo Mode is active. Approve and reject actions update only the simulated
          freelancer treasury; they never execute blockchain transactions.
        </div>
      )}
      {actionError && <div className="ledger-error" role="alert">{actionError}</div>}

      {approvals.length === 0 ? (
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

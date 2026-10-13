// ────────────────────────────────────────────────
// @agentvault/agent-core – Guardrails Engine
// ────────────────────────────────────────────────
// Hard limits the agent CANNOT override. These are
// enforced before any transaction is submitted.
// The agent's LLM has no ability to modify or
// bypass these — they are checked in native code.
// ────────────────────────────────────────────────

import type { GuardrailConfig, DecisionAction, TxCategory } from "@agentvault/shared";
import { getLedger } from "./ledger.js";

export interface GuardrailCheckResult {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  /** Which specific guardrail was triggered */
  triggeredRule?: string;
}

// Extended guardrail config with borrow limits
export type ExtendedGuardrailConfig = GuardrailConfig;

const DEFAULT_GUARDRAILS: ExtendedGuardrailConfig = {
  maxDailySpend: 5000,
  approvalThreshold: 1000,
  autoInvestThreshold: 500,
  minReserveBalance: 200,
  maxBorrowAmount: 2000,
  maxDailyBorrow: 3000,
  payrollDay: 1,
  reservePercent: 15,
  allowedCategories: [
    "invoice_payment",
    "vendor_payment",
    "contractor_payment",
    "yield_deposit",
    "yield_withdrawal",
    "bridge",
    "borrow",
    "repay",
    "internal_transfer",
  ],
  blockedAddresses: [],
};

let config: ExtendedGuardrailConfig = { ...DEFAULT_GUARDRAILS };

export function setGuardrails(
  newConfig: Partial<ExtendedGuardrailConfig>
): void {
  config = { ...config, ...newConfig };
  console.log("[GUARDRAILS] Updated:", JSON.stringify(config, null, 2));
}

export function getGuardrails(): Readonly<ExtendedGuardrailConfig> {
  return { ...config };
}

export function getRequiredReserveBalance(balances: {
  treasury: string;
  operations: string;
  reserves: string;
}): number {
  const totalLiquid =
    Number(balances.treasury) +
    Number(balances.operations) +
    Number(balances.reserves);
  if (!Number.isFinite(totalLiquid) || totalLiquid < 0) {
    throw new Error("Cannot calculate reserve floor from invalid wallet balances.");
  }
  return Math.max(config.minReserveBalance, totalLiquid * (config.reservePercent ?? 0) / 100);
}

// ── Daily Spend Tracking ──────────────────────

function getDailySpend(excludeDecisionId?: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const todaysDecisions = getLedger().filter(
    (d) =>
      d.recordType === "decision" &&
      d.timestamp.startsWith(today) &&
      d.id !== excludeDecisionId &&
      d.withinDailyLimit &&
      ["send", "bridge"].includes(d.action)
  );
  return todaysDecisions.reduce((sum, d) => sum + parseFloat(d.amountUSDC), 0);
}

function getDailyBorrow(excludeDecisionId?: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const todaysBorrows = getLedger().filter(
    (d) =>
      d.recordType === "decision" &&
      d.timestamp.startsWith(today) &&
      d.id !== excludeDecisionId &&
      d.withinDailyLimit &&
      d.action === "borrow"
  );
  return todaysBorrows.reduce((sum, d) => sum + parseFloat(d.amountUSDC), 0);
}

// ── Main Guardrail Check ──────────────────────

export function checkGuardrails(
  action: DecisionAction,
  amountUSDC: number,
  category: TxCategory,
  toAddress?: string,
  excludeDecisionId?: string
): GuardrailCheckResult {
  // ── 1. Amount sanity ───────────────────────
  if (amountUSDC <= 0) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: "Amount must be greater than zero",
      triggeredRule: "positive_amount",
    };
  }

  if (!isFinite(amountUSDC) || isNaN(amountUSDC)) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: "Amount must be a finite number",
      triggeredRule: "finite_amount",
    };
  }

  // ── 2. Blocked address ─────────────────────
  if (toAddress && config.blockedAddresses.includes(toAddress)) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `Address ${toAddress} is blocked`,
      triggeredRule: "blocked_address",
    };
  }

  // ── 3. Category check ─────────────────────
  if (!config.allowedCategories.includes(category)) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `Category "${category}" is not allowed by guardrails`,
      triggeredRule: "blocked_category",
    };
  }

  // ── 4. Borrow-specific limits ─────────────
  if (action === "borrow") {
    if (amountUSDC > config.maxBorrowAmount) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Borrow amount $${amountUSDC} exceeds maximum single-borrow limit of $${config.maxBorrowAmount}`,
        triggeredRule: "max_borrow_amount",
      };
    }

    const dailyBorrow = getDailyBorrow(excludeDecisionId);
    if (dailyBorrow + amountUSDC > config.maxDailyBorrow) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Daily borrow limit exceeded: $${dailyBorrow} + $${amountUSDC} > $${config.maxDailyBorrow}`,
        triggeredRule: "max_daily_borrow",
      };
    }
  }

  // ── 5. Daily spend limit ──────────────────
  if (["send", "bridge"].includes(action)) {
    const dailySpend = getDailySpend(excludeDecisionId);
    if (dailySpend + amountUSDC > config.maxDailySpend) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Daily spend limit exceeded: $${dailySpend} + $${amountUSDC} > $${config.maxDailySpend}`,
        triggeredRule: "max_daily_spend",
      };
    }
  }

  // ── 6. Approval threshold ─────────────────
  if (amountUSDC >= config.approvalThreshold) {
    return {
      allowed: true,
      requiresApproval: true,
      reason: `Amount $${amountUSDC} exceeds approval threshold of $${config.approvalThreshold}`,
      triggeredRule: "approval_threshold",
    };
  }

  return {
    allowed: true,
    requiresApproval: false,
    reason: "All guardrail checks passed",
  };
}

// ── Guardrail Summary (for agent context) ────

export function getGuardrailsSummary(): string {
  return [
    `HARD GUARDRAILS (you CANNOT override these):`,
    `• Max daily spend: $${config.maxDailySpend}`,
    `• Max single borrow: $${config.maxBorrowAmount}`,
    `• Max daily borrow: $${config.maxDailyBorrow}`,
    `• Min reserve balance: $${config.minReserveBalance} (must be maintained at all times)`,
    `• Reserve target: ${config.reservePercent ?? 0}% of liquid wallet balances`,
    `• Payroll day: ${config.payrollDay ?? 1} of each month`,
    `• Approval required for amounts ≥ $${config.approvalThreshold}`,
    `• Auto-invest threshold: $${config.autoInvestThreshold}`,
    `• Blocked addresses: ${config.blockedAddresses.length > 0 ? config.blockedAddresses.join(", ") : "none"}`,
    `• Daily spend so far: $${getDailySpend().toFixed(2)}`,
    `• Daily borrows so far: $${getDailyBorrow().toFixed(2)}`,
  ].join("\n");
}

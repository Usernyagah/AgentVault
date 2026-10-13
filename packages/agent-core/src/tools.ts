// ────────────────────────────────────────────────
// @agentvault/agent-core – Tool Implementations
// ────────────────────────────────────────────────
// Each tool wraps a Circle service call with Zod
// validation, guardrail checks, and ledger recording.
// The agent calls these via the OpenAI function-calling
// loop. No money moves without a Decision on file.
// ────────────────────────────────────────────────

import type { AgentConfig, CashFlowForecast, DecisionAction, ForecastEntry, TxCategory } from "@agentvault/shared";
import {
  GetBalanceParams,
  ForecastCashflowParams,
  SendUsdcParams,
  SaveToUsycParams,
  RedeemUsycParams,
  BorrowUsdcParams,
  GenerateInvoiceParams,
  RecordIncomingPaymentParams,
  RecordDecisionParams,
  DecisionSchema,
} from "./types.js";
import {
  getWalletBalance,
  getUnifiedGatewayBalance,
  transferUSDC,
  depositToUSYC,
  redeemFromUSYC,
  borrowUSDC,
} from "./circle-service.js";
import {
  checkGuardrails,
  getGuardrails,
  getRequiredReserveBalance,
} from "./guardrails.js";
import {
  appendDecision,
  appendDecisionOutcome,
  getLedger,
  type LedgerEntry,
} from "./ledger.js";
import { getObligations } from "./obligations.js";
import { createInvoice, getInvoices, recordIncomingPayment, getIncomingPayments } from "./payments.js";

// ── Result type for every tool ────────────────

export interface ToolResult {
  success: boolean;
  data: unknown;
  explanation: string; // Plain-English for the agent to relay to the user
}

// ── Tool Context (injected per run) ───────────

export interface ToolContext {
  config: AgentConfig;
  /** The last recorded decision ID — tools check this to enforce "decide before act" */
  lastDecisionId: string | null;
  /** Track decisions recorded in this conversation turn */
  decisionsThisTurn: string[];
  decisionAuthorizations: DecisionAuthorization[];
  allBalancesChecked: boolean;
}

interface DecisionAuthorization {
  decisionId: string;
  action: DecisionAction;
  amountUSDC: string;
  category: TxCategory;
  toAddress?: string;
  fromWallet: string;
  toWallet?: string;
  requiresApproval: boolean;
  consumed: boolean;
  reasoning: string;
}

function normalizeAmount(amount: string): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  return `${BigInt(whole).toString()}.${fraction.padEnd(6, "0")}`;
}

function findDecisionAuthorization(
  ctx: ToolContext,
  expected: Omit<DecisionAuthorization, "decisionId" | "requiresApproval" | "consumed" | "reasoning">
): DecisionAuthorization | undefined {
  return ctx.decisionAuthorizations.find((decision) => {
    const decisionFromWallet = decision.fromWallet ?? "";
    const expectedFromWallet = expected.fromWallet ?? "";
    const decisionToWallet = decision.toWallet ?? "";
    const expectedToWallet = expected.toWallet ?? "";

    return (
      !decision.consumed &&
      decision.action === expected.action &&
      normalizeAmount(decision.amountUSDC) === normalizeAmount(expected.amountUSDC) &&
      decision.category === expected.category &&
      decision.toAddress === expected.toAddress &&
      decisionFromWallet === expectedFromWallet &&
      decisionToWallet === expectedToWallet
    );
  });
}

function decisionRequired(): ToolResult {
  return {
    success: false,
    data: null,
    explanation:
      "BLOCKED: A matching, unconsumed Decision must be recorded before this money movement.",
  };
}

function approvalRequired(authorization: DecisionAuthorization): ToolResult {
  return {
    success: true,
    data: { status: "awaiting_approval", decisionId: authorization.decisionId },
    explanation:
      "This action is recorded but requires human approval; no money has moved.",
  };
}

function checkMovementAuthorization(
  authorization: DecisionAuthorization,
  amount: number,
  address?: string
): ToolResult | null {
  const check = checkGuardrails(
    authorization.action,
    amount,
    authorization.category,
    address,
    authorization.decisionId
  );
  if (!check.allowed) {
    authorization.consumed = true;
    appendDecisionOutcome(authorization.decisionId, {
      actionTaken: `Movement blocked by guardrails: ${check.reason}`,
    });
    return {
      success: false,
      data: { guardrailViolation: check.reason },
      explanation: `BLOCKED by current guardrails: ${check.reason}.`,
    };
  }
  if (authorization.requiresApproval || check.requiresApproval) {
    return approvalRequired(authorization);
  }
  return null;
}

async function checkReserveFloor(ctx: ToolContext): Promise<{
  allowed: boolean;
  reason: string;
}> {
  const [treasury, operations, reserves] = await Promise.all([
    getWalletBalance(ctx.config.wallets.treasury),
    getWalletBalance(ctx.config.wallets.operations),
    getWalletBalance(ctx.config.wallets.reserves),
  ]);
  const balances = {
    treasury: treasury.balanceUSDC,
    operations: operations.balanceUSDC,
    reserves: reserves.balanceUSDC,
  };
  const required = getRequiredReserveBalance(balances);
  return {
    allowed: parseFloat(reserves.balanceUSDC) >= required,
    reason: `Reserves hold $${reserves.balanceUSDC}; required reserve floor is $${required.toFixed(2)}.`,
  };
}

// ── get_balance ───────────────────────────────

export async function toolGetBalance(
  rawParams: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const params = GetBalanceParams.parse(rawParams);

  if (params.wallet === "all") {
    const [treasury, operations, reserves] = await Promise.all([
      getWalletBalance(ctx.config.wallets.treasury),
      getWalletBalance(ctx.config.wallets.operations),
      getWalletBalance(ctx.config.wallets.reserves),
    ]);

    const totalUsdc =
      parseFloat(treasury.balanceUSDC) +
      parseFloat(operations.balanceUSDC) +
      parseFloat(reserves.balanceUSDC);
    ctx.allBalancesChecked = true;
    const gateway = await Promise.all([
      getUnifiedGatewayBalance(treasury.address),
      getUnifiedGatewayBalance(operations.address),
      getUnifiedGatewayBalance(reserves.address),
    ]).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    const gatewayTotals = Array.isArray(gateway)
      ? gateway.reduce((sum, balance) => sum + parseFloat(balance.totalUSDC), 0)
      : null;

    return {
      success: true,
      data: {
        treasury: { usdc: treasury.balanceUSDC, usyc: treasury.balanceUSYC },
        operations: { usdc: operations.balanceUSDC, usyc: operations.balanceUSYC },
        reserves: { usdc: reserves.balanceUSDC, usyc: reserves.balanceUSYC },
        totalUSDC: totalUsdc.toFixed(2),
        gateway: Array.isArray(gateway)
          ? {
              wallets: gateway.map(({ depositor, balances, totalUSDC }) => ({
                depositor,
                balances,
                totalUSDC,
              })),
              unifiedTotalUSDC: gatewayTotals!.toFixed(6),
            }
          : { available: false, error: gateway.error },
      },
      explanation: Array.isArray(gateway)
        ? `Arc wallet balances total $${totalUsdc.toFixed(2)} USDC. Gateway unified balance across configured domains totals $${gatewayTotals!.toFixed(6)} USDC; it is shown separately and is not counted as local spendable liquidity.`
        : `Arc wallet balances total $${totalUsdc.toFixed(2)} USDC. Gateway balance lookup is currently unavailable: ${gateway.error}`,
    };
  }

  const walletId = ctx.config.wallets[params.wallet as keyof typeof ctx.config.wallets];
  const wallet = await getWalletBalance(walletId, params.wallet);
  const gateway = await getUnifiedGatewayBalance(wallet.address).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));

  return {
    success: true,
    data: {
      wallet: params.wallet,
      usdc: wallet.balanceUSDC,
      usyc: wallet.balanceUSYC,
      gateway,
    },
    explanation: "totalUSDC" in gateway
      ? `${params.wallet} wallet: $${wallet.balanceUSDC} USDC, ${wallet.balanceUSYC} USYC. Gateway unified balance: $${gateway.totalUSDC} USDC.`
      : `${params.wallet} wallet: $${wallet.balanceUSDC} USDC, ${wallet.balanceUSYC} USYC. Gateway balance unavailable: ${gateway.error}`,
  };
}

// ── forecast_cashflow ─────────────────────────

export async function toolForecastCashflow(
  rawParams: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const params = ForecastCashflowParams.parse(rawParams);

  // Get current balances for the forecast baseline
  const [treasury, operations, reserves] = await Promise.all([
    getWalletBalance(ctx.config.wallets.treasury),
    getWalletBalance(ctx.config.wallets.operations),
    getWalletBalance(ctx.config.wallets.reserves),
  ]);

  const currentTotal =
    parseFloat(treasury.balanceUSDC) +
    parseFloat(operations.balanceUSDC) +
    parseFloat(reserves.balanceUSDC);

  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  const recentCutoff = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ledger = getLedger();
  const executionOutcomes = new Map(
    ledger
      .filter((entry) => entry.recordType === "execution" && entry.relatedDecisionId)
      .map((entry) => [entry.relatedDecisionId!, entry.actionTaken.toLowerCase()])
  );
  const recentOutflows = ledger.filter((decision) => {
    if (
      decision.recordType !== "decision" ||
      decision.action !== "send" ||
      decision.requiresApproval ||
      !decision.withinDailyLimit ||
      new Date(decision.timestamp) < recentCutoff
    ) {
      return false;
    }
    const outcome = executionOutcomes.get(decision.id);
    return Boolean(outcome && !outcome.includes("failed") && !outcome.includes("blocked"));
  });
  const avgDailyOutflow =
    recentOutflows.length > 0
      ? recentOutflows.reduce((s, d) => s + parseFloat(d.amountUSDC), 0) / 30
      : 0;
  const upcomingObligations = getObligations().filter(
    (obligation) => obligation.status === "open" && obligation.dueDate <= new Date(today.getTime() + params.days * 86400000).toISOString().slice(0, 10)
  );

  const entries: ForecastEntry[] = [];
  let runningBalance = currentTotal;
  let minProjectedBalance = currentTotal;
  const guardrails = getGuardrails();

  for (let i = 1; i <= params.days; i++) {
    const date = new Date(today.getTime() + i * 86400000);
    const dateKey = date.toISOString().slice(0, 10);
    const lastDayOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    const previousDate = i === 1 ? todayKey : entries[i - 2]!.date;
    const dueObligations = upcomingObligations.filter(
      (obligation) => obligation.dueDate <= dateKey && obligation.dueDate > previousDate
    );
    const obligationOutflow = dueObligations.reduce(
      (sum, obligation) => sum + parseFloat(obligation.amountUSDC),
      0
    );
    const dailyOutflow = avgDailyOutflow + obligationOutflow;
    const dailyInflow = 0; // TODO: integrate with invoice/receivable data
    runningBalance = runningBalance - dailyOutflow + dailyInflow;
    minProjectedBalance = Math.min(minProjectedBalance, runningBalance);

    entries.push({
      date: dateKey,
      expectedInflow: dailyInflow.toFixed(2),
      expectedOutflow: dailyOutflow.toFixed(2),
      projectedBalance: Math.max(0, runningBalance).toFixed(2),
      notes: [
        dueObligations.length > 0
          ? `Includes ${dueObligations.length} scheduled obligation(s).`
          : undefined,
        date.getUTCDate() === Math.min(guardrails.payrollDay ?? 1, lastDayOfMonth)
          ? "Configured payroll day; confirm liquid funds are reserved for payroll."
          : undefined,
      ].filter(Boolean).join(" ") || undefined,
    });
  }

  const shortfallIndex = entries.findIndex((entry) => parseFloat(entry.projectedBalance) <= 0);
  const reserveIndex = entries.findIndex(
    (entry) => parseFloat(entry.projectedBalance) < guardrails.minReserveBalance
  );
  const daysUntilShortfall = shortfallIndex >= 0 ? shortfallIndex + 1 : null;
  const daysUntilBelowReserve = reserveIndex >= 0 ? reserveIndex + 1 : null;
  const dueObligationsTotal = upcomingObligations.reduce(
    (sum, obligation) => sum + parseFloat(obligation.amountUSDC),
    0
  );
  const availableToInvest = Math.max(
    0,
    currentTotal - guardrails.minReserveBalance - dueObligationsTotal - avgDailyOutflow * 7
  );

  const summary =
    daysUntilShortfall != null
      ? `Cash shortfall projected in ${daysUntilShortfall} day(s). Current balance: $${currentTotal.toFixed(2)}, average daily outflow: $${avgDailyOutflow.toFixed(2)}, scheduled obligations: $${dueObligationsTotal.toFixed(2)}.`
      : `Balance is healthy for the next ${params.days} days. Current: $${currentTotal.toFixed(2)}, average daily outflow: $${avgDailyOutflow.toFixed(2)}, scheduled obligations: $${dueObligationsTotal.toFixed(2)}.`;

  const recommendation =
    daysUntilShortfall != null
      ? "Consider redeeming USYC or borrowing to cover upcoming shortfall."
      : availableToInvest > guardrails.autoInvestThreshold
        ? `Surplus detected — up to $${availableToInvest.toFixed(2)} may be invested while preserving the reserve and near-term cash needs.`
        : "Maintain current allocation.";

  const forecast: CashFlowForecast = {
    generatedAt: new Date().toISOString(),
    entries: entries.slice(0, 14), // Return at most 14 entries to the LLM
    summary,
    recommendation,
  };

  return {
    success: true,
    data: {
      forecast,
      daysUntilShortfall,
      daysUntilBelowReserve,
      projectedShortfallUSDC: Math.max(0, guardrails.minReserveBalance - minProjectedBalance).toFixed(2),
      avgDailyOutflow: avgDailyOutflow.toFixed(2),
      availableToInvest: availableToInvest.toFixed(2),
      upcomingObligations,
    },
    explanation: `${summary} ${recommendation}`,
  };
}

// ── create_invoice ────────────────────────────

export async function toolCreateInvoice(
  rawParams: unknown,
  _ctx: ToolContext
): Promise<ToolResult> {
  const params = GenerateInvoiceParams.parse(rawParams);
  const invoice = createInvoice({
    recipientName: params.recipientName,
    recipientAddress: params.recipientAddress,
    walletAddress: params.walletAddress,
    amountUSDC: params.amount,
    dueDate: params.dueDate,
    memo: params.memo,
  });

  return {
    success: true,
    data: invoice,
    explanation: `Invoice ${invoice.id} created for ${params.recipientName} for $${params.amount} USDC. Payment link: ${invoice.paymentLink ?? "n/a"}`,
  };
}

// ── record_incoming_payment ─────────────────────

export async function toolRecordIncomingPayment(
  rawParams: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const params = RecordIncomingPaymentParams.parse(rawParams);
  if (!ctx.allBalancesChecked) {
    return {
      success: false,
      data: null,
      explanation: "BLOCKED: Call get_balance with wallet 'all' before recording an inbound payment.",
    };
  }

  const authorization = findDecisionAuthorization(ctx, {
    action: "receive",
    amountUSDC: params.amount,
    category: "invoice_payment",
    fromWallet: "",
    toWallet: ctx.config.wallets.treasury,
  });

  if (!authorization) return decisionRequired();
  const movementCheck = checkMovementAuthorization(authorization, parseFloat(params.amount), params.toAddress);
  if (movementCheck) return movementCheck;

  authorization.consumed = true;
  const payment = recordIncomingPayment({
    invoiceId: params.invoiceId,
    fromAddress: params.fromAddress,
    toAddress: params.toAddress,
    amountUSDC: params.amount,
    txHash: params.txHash,
    memo: params.memo,
    status: "confirmed",
  });
  appendDecisionOutcome(authorization.decisionId, {
    actionTaken: `Recorded incoming payment ${payment.id} as ${payment.status}.`,
    transactionHash: payment.txHash,
    transactionId: payment.id,
  });

  return {
    success: true,
    data: payment,
    explanation: `Decision ${authorization.decisionId}: ${authorization.reasoning} Recorded inbound payment of $${params.amount} USDC from ${params.fromAddress} to ${params.toAddress}.`,
  };
}

// ── send_usdc ────────────────────────────────

export async function toolSendUsdc(
  rawParams: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const params = SendUsdcParams.parse(rawParams);
  const authorization = findDecisionAuthorization(ctx, {
    action: "send",
    amountUSDC: params.amount,
    category: params.category,
    toAddress: params.toAddress,
    fromWallet: ctx.config.wallets.operations,
  });
  if (!authorization) return decisionRequired();
  const movementCheck = checkMovementAuthorization(authorization, parseFloat(params.amount), params.toAddress);
  if (movementCheck) return movementCheck;

  // ⛔ HARD GUARDRAIL: Check min reserve balance
  const reserveCheck = await checkReserveFloor(ctx);
  if (!reserveCheck.allowed) {
    authorization.consumed = true;
    appendDecisionOutcome(authorization.decisionId, {
      actionTaken: `Movement blocked: ${reserveCheck.reason}`,
    });
    return {
      success: false,
      data: { guardrailViolation: "min_reserve_balance" },
      explanation: `BLOCKED: ${reserveCheck.reason}`,
    };
  }

  // Execute the transfer
  authorization.consumed = true;
  const tx = await transferUSDC({
    fromWalletId: ctx.config.wallets.operations,
    toAddress: params.toAddress,
    amount: params.amount,
    category: params.category,
    memo: params.memo,
  });
  appendDecisionOutcome(authorization.decisionId, {
    actionTaken: `Transfer ${tx.id} submitted with status ${tx.status}.`,
    transactionHash: tx.txHash,
    transactionId: tx.id,
  });

  return {
    success: true,
    data: {
      transactionId: tx.id,
      status: tx.status,
      amount: params.amount,
      toAddress: params.toAddress,
      txHash: tx.txHash,
    },
    explanation: `Decision ${authorization.decisionId}: ${authorization.reasoning} Sent $${params.amount} USDC to ${params.toAddress} (${params.category}). Transaction ${tx.id} is ${tx.status}.`,
  };
}

// ── save_to_usyc ─────────────────────────────

export async function toolSaveToUsyc(
  rawParams: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const params = SaveToUsycParams.parse(rawParams);
  const amount = parseFloat(params.amount);
  const fromWallet = params.fromWallet ?? "treasury";
  const walletId = ctx.config.wallets[fromWallet as keyof typeof ctx.config.wallets];
  const authorization = findDecisionAuthorization(ctx, {
    action: "invest_usyc",
    amountUSDC: params.amount,
    category: "yield_deposit",
    fromWallet: walletId,
  });
  if (!authorization) return decisionRequired();
  const movementCheck = checkMovementAuthorization(authorization, parseFloat(params.amount));
  if (movementCheck) return movementCheck;

  // ⛔ HARD GUARDRAIL: Ensure the designated reserve remains above its floor
  const balance = await getWalletBalance(walletId);
  const reserveCheck = await checkReserveFloor(ctx);

  if (parseFloat(balance.balanceUSDC) < amount) {
    authorization.consumed = true;
    appendDecisionOutcome(authorization.decisionId, {
      actionTaken: `Movement blocked: ${fromWallet} balance $${balance.balanceUSDC} is below the $${params.amount} deposit.`,
    });
    return {
      success: false,
      data: { guardrailViolation: "insufficient_balance" },
      explanation: `BLOCKED: ${fromWallet} has $${balance.balanceUSDC}, less than the $${params.amount} USDC deposit.`,
    };
  }
  if (!reserveCheck.allowed) {
    authorization.consumed = true;
    appendDecisionOutcome(authorization.decisionId, {
      actionTaken: `Movement blocked: ${reserveCheck.reason}`,
    });
    return {
      success: false,
      data: { guardrailViolation: "min_reserve_balance" },
      explanation: `BLOCKED: ${reserveCheck.reason}`,
    };
  }

  authorization.consumed = true;
  const tx = await depositToUSYC(walletId, params.amount);
  appendDecisionOutcome(authorization.decisionId, {
    actionTaken: `Deposited $${params.amount} USDC into USYC with status ${tx.status}.`,
    transactionHash: tx.txHash,
    transactionId: tx.id,
  });

  return {
    success: true,
    data: { transactionId: tx.id, status: tx.status, amount: params.amount },
    explanation: `Decision ${authorization.decisionId}: ${authorization.reasoning} Deposited $${params.amount} USDC into USYC from ${fromWallet} wallet. TX: ${tx.id}.`,
  };
}

// ── redeem_usyc ──────────────────────────────

export async function toolRedeemUsyc(
  rawParams: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const params = RedeemUsycParams.parse(rawParams);
  const toWallet = params.toWallet ?? "treasury";
  const walletId = ctx.config.wallets[toWallet as keyof typeof ctx.config.wallets];
  const authorization = findDecisionAuthorization(ctx, {
    action: "redeem_usyc",
    amountUSDC: params.amount,
    category: "yield_withdrawal",
    fromWallet: "",
    toWallet: walletId,
  });
  if (!authorization) return decisionRequired();
  const movementCheck = checkMovementAuthorization(authorization, parseFloat(params.amount));
  if (movementCheck) return movementCheck;

  authorization.consumed = true;
  const tx = await redeemFromUSYC(walletId, params.amount);
  appendDecisionOutcome(authorization.decisionId, {
    actionTaken: `Redeemed ${params.amount} USYC to USDC with status ${tx.status}.`,
    transactionHash: tx.txHash,
    transactionId: tx.id,
  });

  return {
    success: true,
    data: { transactionId: tx.id, status: tx.status, amount: params.amount },
    explanation: `Decision ${authorization.decisionId}: ${authorization.reasoning} Redeemed ${params.amount} USYC to USDC into ${toWallet} wallet. TX: ${tx.id}.`,
  };
}

// ── borrow_usdc ──────────────────────────────

export async function toolBorrowUsdc(
  rawParams: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const params = BorrowUsdcParams.parse(rawParams);
  const walletId = ctx.config.wallets.treasury;
  const authorization = findDecisionAuthorization(ctx, {
    action: "borrow",
    amountUSDC: params.amount,
    category: "borrow",
    fromWallet: "",
    toWallet: walletId,
  });
  if (!authorization) return decisionRequired();
  const movementCheck = checkMovementAuthorization(authorization, parseFloat(params.amount));
  if (movementCheck) return movementCheck;

  authorization.consumed = true;
  const tx = await borrowUSDC(walletId, params.amount, params.reason);
  appendDecisionOutcome(authorization.decisionId, {
    actionTaken: `Borrowed $${params.amount} USDC with status ${tx.status}.`,
    transactionHash: tx.txHash,
    transactionId: tx.id,
  });

  return {
    success: true,
    data: { transactionId: tx.id, status: tx.status, amount: params.amount },
    explanation: `Decision ${authorization.decisionId}: ${authorization.reasoning} Borrowed $${params.amount} USDC. Reason: ${params.reason}. TX: ${tx.id}.`,
  };
}

// ── record_decision ──────────────────────────

export async function toolRecordDecision(
  rawParams: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const params = RecordDecisionParams.parse(rawParams);
  if (!ctx.allBalancesChecked) {
    const [treasury, operations, reserves] = await Promise.all([
      getWalletBalance(ctx.config.wallets.treasury),
      getWalletBalance(ctx.config.wallets.operations),
      getWalletBalance(ctx.config.wallets.reserves),
    ]);
    const rejected = appendDecision({
      balanceSeen: {
        treasury: treasury.balanceUSDC,
        operations: operations.balanceUSDC,
        reserves: reserves.balanceUSDC,
      },
      balanceSeenUSYC: {
        treasury: treasury.balanceUSYC,
        operations: operations.balanceUSYC,
        reserves: reserves.balanceUSYC,
      },
      forecast: params.forecast,
      reasoning: params.reasoning,
      ruleApplied: params.ruleApplied,
      confidence: params.confidence,
      action: params.action,
      amountUSDC: params.amount,
      toAddress: params.toAddress,
      withinDailyLimit: false,
      requiresApproval: false,
      actionTaken: "Rejected because the required all-wallet balance check was not completed.",
    });
    return {
      success: false,
      data: { decisionId: rejected.id },
      explanation: "BLOCKED: Call get_balance with wallet 'all' before recording a financial Decision.",
    };
  }

  // Get current balances for the snapshot
  const [treasury, operations, reserves] = await Promise.all([
    getWalletBalance(ctx.config.wallets.treasury),
    getWalletBalance(ctx.config.wallets.operations),
    getWalletBalance(ctx.config.wallets.reserves),
  ]);

  const balanceSeen = {
    treasury: treasury.balanceUSDC,
    operations: operations.balanceUSDC,
    reserves: reserves.balanceUSDC,
  };
  const balanceSeenUSYC = {
    treasury: treasury.balanceUSYC,
    operations: operations.balanceUSYC,
    reserves: reserves.balanceUSYC,
  };

  // Check guardrails to populate the decision record
  const actionToCategory: Record<DecisionAction, TxCategory> = {
    send: "vendor_payment",
    invest_usyc: "yield_deposit",
    redeem_usyc: "yield_withdrawal",
    borrow: "borrow",
    repay: "repay",
    bridge: "bridge",
    hold: "internal_transfer",
    receive: "invoice_payment",
  };

  const category = params.category ?? actionToCategory[params.action];
  const fromWalletName = params.fromWallet
    ? params.fromWallet
    : params.action === "send"
      ? "operations"
      : params.action === "invest_usyc"
        ? "treasury"
        : undefined;
  const toWalletName = params.toWallet
    ? params.toWallet
    : params.action === "borrow"
      ? "treasury"
      : params.action === "receive"
        ? "treasury"
        : undefined;
  const fromWalletId = fromWalletName
    ? ctx.config.wallets[fromWalletName]
    : undefined;
  const toWalletId = toWalletName
    ? ctx.config.wallets[toWalletName]
    : undefined;
  const decision = DecisionSchema.parse({
    action: params.action,
    amountUSDC: params.amount,
    reasoning: params.reasoning,
    forecast: params.forecast,
    ruleApplied: params.ruleApplied,
    confidence: params.confidence,
    category,
    fromWallet: fromWalletName,
    toWallet: toWalletName,
    toAddress: params.toAddress,
  });
  const check = checkGuardrails(
    decision.action,
    parseFloat(params.amount),
    decision.category ?? category,
    decision.toAddress
  );

  if (!check.allowed) {
    const rejected = appendDecision({
      balanceSeen,
      balanceSeenUSYC,
      forecast: params.forecast,
      reasoning: params.reasoning,
      ruleApplied: params.ruleApplied,
      confidence: params.confidence,
      action: decision.action,
      amountUSDC: params.amount,
      category: decision.category ?? category,
      fromWallet: fromWalletId,
      toWallet: toWalletId,
      toAddress: decision.toAddress,
      withinDailyLimit: false,
      requiresApproval: false,
      actionTaken: `Rejected by guardrails: ${check.reason}`,
    });
    return {
      success: false,
      data: { guardrailViolation: check.reason, decisionId: rejected.id },
      explanation: `Decision REJECTED by guardrails: ${check.reason}. Cannot proceed with ${params.action} of $${params.amount}.`,
    };
  }

  if (decision.action === "send" || decision.action === "invest_usyc") {
    const minReserveBalance = getRequiredReserveBalance(balanceSeen);
    if (parseFloat(balanceSeen.reserves) < minReserveBalance) {
      const reason = `The reserves wallet has $${balanceSeen.reserves}, below the required reserve floor of $${minReserveBalance.toFixed(2)}.`;
      const rejected = appendDecision({
        balanceSeen,
        balanceSeenUSYC,
        forecast: params.forecast,
        reasoning: params.reasoning,
        ruleApplied: params.ruleApplied,
        confidence: params.confidence,
        action: decision.action,
        amountUSDC: params.amount,
        category: decision.category ?? category,
        fromWallet: fromWalletId,
        toWallet: toWalletId,
        toAddress: decision.toAddress,
        withinDailyLimit: false,
        requiresApproval: false,
        actionTaken: `Rejected by reserve-floor guardrail: ${reason}`,
      });
      return {
        success: false,
        data: { guardrailViolation: "min_reserve_balance", decisionId: rejected.id },
        explanation: `Decision REJECTED: ${reason}`,
      };
    }
  }

  // Append to the immutable ledger
  const entry = appendDecision({
    balanceSeen,
    balanceSeenUSYC,
    forecast: params.forecast,
    reasoning: params.reasoning,
    ruleApplied: params.ruleApplied,
    confidence: params.confidence,
    action: params.action as any,
    amountUSDC: params.amount,
    category: decision.category ?? category,
    fromWallet: fromWalletId,
    toWallet: toWalletId,
    toAddress: decision.toAddress,
    withinDailyLimit: check.allowed,
    requiresApproval: check.requiresApproval,
    actionTaken:
      decision.action === "hold"
        ? "Hold decision recorded; no transaction was executed."
        : check.requiresApproval
          ? "Decision recorded; awaiting human approval."
          : "Decision recorded; approved by guardrails and awaiting execution.",
  });

  ctx.decisionAuthorizations.push({
    decisionId: entry.id,
    action: decision.action,
    amountUSDC: decision.amountUSDC,
    category: decision.category ?? category,
    toAddress: decision.toAddress,
    fromWallet: fromWalletId ?? "",
    toWallet: toWalletId,
    requiresApproval: check.requiresApproval,
    consumed: false,
    reasoning: decision.reasoning,
  });

  // Track this decision so subsequent tool calls know it exists
  ctx.decisionsThisTurn.push(entry.id);
  ctx.lastDecisionId = entry.id;

  return {
    success: true,
    data: {
      decisionId: entry.id,
      decision,
      sequenceNumber: entry.sequenceNumber,
      hash: entry.hash,
      requiresApproval: check.requiresApproval,
      status: check.requiresApproval ? "awaiting_approval" : "recorded",
    },
    explanation: `Decision #${entry.sequenceNumber} recorded: ${params.action} $${params.amount} USDC. Reasoning: "${params.reasoning}". ${check.requiresApproval ? "⚠️ REQUIRES HUMAN APPROVAL before execution." : "✅ Auto-approved within guardrails."}`,
  };
}

// ── Tool Router ──────────────────────────────

export type ToolName =
  | "get_balance"
  | "forecast_cashflow"
  | "create_invoice"
  | "record_incoming_payment"
  | "send_usdc"
  | "save_to_usyc"
  | "redeem_usyc"
  | "borrow_usdc"
  | "record_decision";

const TOOL_MAP: Record<
  ToolName,
  (rawParams: unknown, ctx: ToolContext) => Promise<ToolResult>
> = {
  get_balance: toolGetBalance,
  forecast_cashflow: toolForecastCashflow,
  create_invoice: toolCreateInvoice,
  record_incoming_payment: toolRecordIncomingPayment,
  send_usdc: toolSendUsdc,
  save_to_usyc: toolSaveToUsyc,
  redeem_usyc: toolRedeemUsyc,
  borrow_usdc: toolBorrowUsdc,
  record_decision: toolRecordDecision,
};

export async function executeTool(
  name: string,
  rawParams: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const handler = TOOL_MAP[name as ToolName];
  if (!handler) {
    return {
      success: false,
      data: null,
      explanation: `Unknown tool: "${name}". Available tools: ${Object.keys(TOOL_MAP).join(", ")}.`,
    };
  }

  try {
    return await handler(rawParams, ctx);
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[TOOL] Error executing ${name}:`, message);
    const movementActions: Partial<Record<ToolName, DecisionAction>> = {
      record_incoming_payment: "receive",
      send_usdc: "send",
      save_to_usyc: "invest_usyc",
      redeem_usyc: "redeem_usyc",
      borrow_usdc: "borrow",
    };
    const expectedAction = movementActions[name as ToolName];
    const authorization = expectedAction
      ? [...ctx.decisionAuthorizations].reverse().find(
          (candidate) =>
            candidate.consumed &&
            candidate.action === expectedAction &&
            !getLedger().some(
              (entry) =>
                entry.recordType === "execution" &&
                entry.relatedDecisionId === candidate.decisionId
            )
        )
      : undefined;
    if (authorization) {
      appendDecisionOutcome(authorization.decisionId, {
        actionTaken: `Execution failed: ${message}. Transaction status may require reconciliation.`,
      });
    }
    return {
      success: false,
      data: { error: message },
      explanation: `Tool "${name}" failed: ${message}`,
    };
  }
}

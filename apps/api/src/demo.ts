import { v4 as uuid } from "uuid";
import type {
  CashFlowForecast,
  ChatMessage,
  DashboardSummary,
  DecisionAction,
  DecisionRecord,
  ForecastEntry,
} from "@agentvault/shared";

export interface DemoLedgerEntry extends DecisionRecord {
  recordType: "decision" | "execution";
  sequenceNumber: number;
  previousHash: string;
  hash: string;
  signingKeyId: string;
  signingPublicKey: string;
  relatedDecisionId?: string;
  transactionHash?: string;
  transactionId?: string;
}

interface DemoState {
  enabled: boolean;
  treasury: number;
  operations: number;
  reserves: number;
  treasuryUSYC: number;
  operationsUSYC: number;
  reservesUSYC: number;
  outstandingLoans: number;
  evaluation: number;
  records: DemoLedgerEntry[];
  approvals: string[];
}

const money = (amount: number) => amount.toFixed(2);
const day = (offset: number) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  return undefined;
}

export function isVercelDeployment(): boolean {
  return process.env.VERCEL === "1" || process.env.VERCEL === "true";
}

export function demoModeFromEnv(): boolean | undefined {
  return parseBooleanEnv(process.env.AGENTVAULT_DEMO_MODE);
}

export function initialDemoEnabled(): boolean {
  const fromEnv = demoModeFromEnv();
  if (fromEnv !== undefined) return fromEnv;
  return isVercelDeployment();
}

export function isDemoLocked(): boolean {
  return isVercelDeployment() && initialDemoEnabled();
}

export function shouldInitializeLiveServices(): boolean {
  return !isVercelDeployment() || !initialDemoEnabled();
}

const state: DemoState = {
  enabled: false,
  treasury: 8240,
  operations: 1680,
  reserves: 3650,
  treasuryUSYC: 5725,
  operationsUSYC: 0,
  reservesUSYC: 0,
  outstandingLoans: 1200,
  evaluation: 0,
  records: [],
  approvals: [],
};

function totalLiquid() {
  return state.treasury + state.operations + state.reserves;
}

function forecast(): CashFlowForecast {
  const entries: ForecastEntry[] = [];
  const recurringInvoices = [0, 3200, 0, 1800, 0, 0, 2400];
  const recurringExpenses = [85, 120, 95, 580, 105, 85, 165];
  let balance = totalLiquid();
  for (let i = 0; i < 7; i++) {
    const expectedInflow = recurringInvoices[i]!;
    const expectedOutflow = recurringExpenses[i]!;
    balance += expectedInflow - expectedOutflow;
    entries.push({
      date: day(i + 1),
      expectedInflow: money(expectedInflow),
      expectedOutflow: money(expectedOutflow),
      projectedBalance: money(balance),
      notes: expectedInflow > 0 ? "Expected client invoice settlement." : "Estimated freelancer operating expenses.",
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    entries,
    summary: `7-day forecast: projected cash rises from $${money(totalLiquid())} to $${money(balance)} with $7,400 in expected client receipts and $1,235 in expenses.`,
    recommendation: "Keep operating expenses liquid; the forecast leaves room to pay a contractor and preserve the reserve floor.",
  };
}

function appendRecord(
  params: Pick<DecisionRecord, "action" | "amountUSDC" | "reasoning" | "ruleApplied"> &
    Partial<Pick<DecisionRecord, "transactionHash" | "transactionId">> & {
      recordType?: "decision" | "execution";
      relatedDecisionId?: string;
      actionTaken: string;
      approval?: boolean;
    }
): DemoLedgerEntry {
  const sequenceNumber = state.records.length;
  const previousHash = state.records.at(-1)?.hash ?? "demo-genesis";
  const id = `demo-${uuid()}`;
  const balances = {
    treasury: money(state.treasury),
    operations: money(state.operations),
    reserves: money(state.reserves),
  };
  const record: DemoLedgerEntry = {
    id,
    timestamp: new Date().toISOString(),
    agentSignature: "DEMO ONLY - NOT A CRYPTOGRAPHIC SIGNATURE",
    actionTaken: params.actionTaken,
    balanceSeen: balances,
    balanceSeenUSYC: {
      treasury: money(state.treasuryUSYC),
      operations: money(state.operationsUSYC),
      reserves: money(state.reservesUSYC),
    },
    forecast: forecast().summary,
    reasoning: params.reasoning,
    ruleApplied: params.ruleApplied,
    confidence: 0.94,
    action: params.action,
    amountUSDC: params.amountUSDC,
    transactionHash: params.transactionHash,
    transactionId: params.transactionId,
    withinDailyLimit: true,
    requiresApproval: params.approval ?? false,
    recordType: params.recordType ?? "decision",
    relatedDecisionId: params.relatedDecisionId,
    sequenceNumber,
    previousHash,
    hash: `demo-hash-${String(sequenceNumber + 1).padStart(4, "0")}`,
    signingKeyId: "demo",
    signingPublicKey: "DEMO ONLY - NO SIGNING KEY",
  };
  state.records.push(record);
  if (params.approval) state.approvals.push(id);
  return record;
}

function resetDemo(): void {
  state.treasury = 8240;
  state.operations = 1680;
  state.reserves = 3650;
  state.treasuryUSYC = 5725;
  state.operationsUSYC = 0;
  state.reservesUSYC = 0;
  state.outstandingLoans = 1200;
  state.evaluation = 0;
  state.records = [];
  state.approvals = [];

  appendRecord({
    action: "receive",
    amountUSDC: "3200.00",
    reasoning: "A recurring design client has paid invoice INV-2047. This replenishes operating cash ahead of monthly contractor and software expenses.",
    ruleApplied: "reconcile_confirmed_client_receipts",
    actionTaken: "Client invoice paid; funds credited to treasury.",
    transactionId: "demo-invoice-2047",
  });
  appendRecord({
    action: "invest_usyc",
    amountUSDC: "1500.00",
    reasoning: "Treasury has cash above the reserve floor and upcoming expenses. Move only surplus to the yield position while preserving near-term liquidity.",
    ruleApplied: "invest_only_forecast_surplus_after_reserve_and_obligations",
    actionTaken: "Simulated USYC deposit completed.",
    transactionId: "demo-usyc-deposit-01",
  });
  appendRecord({
    action: "send",
    amountUSDC: "1450.00",
    reasoning: "Pay the monthly design contractor invoice. The forecast remains above the reserve floor after payment.",
    ruleApplied: "human_approval_for_large_vendor_payment",
    actionTaken: "Awaiting human approval; no funds moved.",
    approval: true,
  });
}

export function ensureDemoSeeded(): void {
  if (state.enabled && state.records.length === 0) {
    resetDemo();
  }
}

export function isDemoEnabled(): boolean {
  ensureDemoSeeded();
  return state.enabled;
}

export function setDemoEnabled(enabled: boolean): void {
  if (isDemoLocked() && !enabled) {
    throw new Error(
      "Demo Mode is locked on this Vercel deployment so the public demo can run without Circle credentials. Set AGENTVAULT_DEMO_MODE=0 to use live data."
    );
  }
  if (enabled && !state.enabled) resetDemo();
  state.enabled = enabled;
}

export function getDemoDashboard(): DashboardSummary & {
  demoMode: true;
  outstandingLoans: string;
} {
  ensureDemoSeeded();
  return {
    totalBalance: money(totalLiquid()),
    treasuryBalance: money(state.treasury),
    operationsBalance: money(state.operations),
    reservesBalance: money(state.reserves),
    usycYield: money(state.treasuryUSYC + state.operationsUSYC + state.reservesUSYC),
    outstandingLoans: money(state.outstandingLoans),
    pendingTransactions: state.approvals.length,
    recentDecisions: state.records
      .filter((record) => record.recordType === "decision")
      .slice(-5)
      .reverse(),
    forecast: forecast(),
    agentStatus: state.approvals.length > 0 ? "awaiting_approval" : "idle",
    demoMode: true,
    modeLocked: isDemoLocked(),
  };
}

export function getDemoApprovals(): DemoLedgerEntry[] {
  return state.approvals
    .map((id) => state.records.find((record) => record.id === id))
    .filter((record): record is DemoLedgerEntry => record !== undefined);
}

export function queryDemoLedger(params: {
  action?: DecisionAction;
  search?: string;
  since?: string;
  until?: string;
  limit: number;
  offset: number;
}) {
  const search = params.search?.trim().toLocaleLowerCase();
  const filtered = state.records.filter((record) => {
    if (params.action && record.action !== params.action) return false;
    if (params.since && record.timestamp < params.since) return false;
    if (params.until && record.timestamp > params.until) return false;
    if (
      search &&
      ![
        record.reasoning,
        record.forecast,
        record.ruleApplied,
        record.actionTaken,
        record.transactionHash ?? "",
      ].some((field) => field.toLocaleLowerCase().includes(search))
    ) {
      return false;
    }
    return true;
  });
  const pageStart = Math.max(0, filtered.length - params.offset - params.limit);
  const pageEnd = filtered.length - params.offset;
  return {
    entries: filtered.slice(pageStart, pageEnd).reverse(),
    total: filtered.length,
    limit: params.limit,
    offset: params.offset,
  };
}

export function runDemoEvaluation(): DemoLedgerEntry {
  state.evaluation++;
  const scenarios = [
    () => {
      const amount = 3200;
      state.treasury += amount;
      return appendRecord({
        action: "receive",
        amountUSDC: money(amount),
        reasoning: "A recurring client invoice settled. Replenish treasury first and keep the operations wallet funded for scheduled expenses.",
        ruleApplied: "reconcile_confirmed_client_receipts",
        actionTaken: "Simulated client payment received and credited to treasury.",
        transactionHash: `0xdemo${String(state.evaluation).padStart(8, "0")}`,
      });
    },
    () => {
      const amount = 480;
      state.operations -= amount;
      return appendRecord({
        action: "send",
        amountUSDC: money(amount),
        reasoning: "Pay the recurring software and cloud tools bill from operations. The payment is below the approval threshold and leaves adequate working cash.",
        ruleApplied: "auto_pay_recurring_expense_within_threshold",
        actionTaken: "Simulated software expense paid from operations.",
        transactionHash: `0xdemo${String(state.evaluation).padStart(8, "0")}`,
      });
    },
    () => appendRecord({
      action: "hold",
      amountUSDC: "0.00",
      reasoning: "Several client receipts are due shortly. Keep the treasury liquid rather than increasing the yield position before those receipts clear.",
      ruleApplied: "preserve_liquidity_ahead_of_due_receivables",
      actionTaken: "Held funds in liquid treasury; no transaction executed.",
    }),
  ];
  return scenarios[(state.evaluation - 1) % scenarios.length]!();
}

export function runDemoChat(message: string): ChatMessage {
  ensureDemoSeeded();
  const dashboard = getDemoDashboard();
  const pending = getDemoApprovals();
  const text = message.toLowerCase();
  let content: string;
  if (text.includes("approv")) {
    content = pending.length > 0
      ? `There is ${pending.length} simulated approval waiting: a $${pending[0]!.amountUSDC} contractor payment. Approve it from the dashboard or Approvals page — no Arc transaction is sent.`
      : "There are no simulated approvals waiting. Run an agent evaluation if you want another demo decision.";
  } else if (text.includes("forecast") || text.includes("cash")) {
    content = dashboard.forecast.summary;
  } else if (text.includes("ledger") || text.includes("audit")) {
    content = `The demo ledger currently has ${state.records.length} unsigned simulation records. They are labeled DEMO ONLY and are not cryptographically signed.`;
  } else if (text.includes("balance") || text.includes("wallet") || text.includes("treasury")) {
    content = `Simulated liquid treasury is $${dashboard.totalBalance} (treasury $${dashboard.treasuryBalance}, operations $${dashboard.operationsBalance}, reserves $${dashboard.reservesBalance}). Experimental USYC is $${dashboard.usycYield}. These figures are in-memory only.`;
  } else {
    content = `This is Demo Mode on a synthetic freelancer treasury. Liquid cash is $${dashboard.totalBalance} with ${dashboard.pendingTransactions} item(s) needing review. ${dashboard.forecast.recommendation} Ask about balances, the forecast, or approvals — chat here does not call OpenAI or Circle.`;
  }
  return {
    id: `demo-chat-${uuid()}`,
    role: "agent",
    content,
    timestamp: new Date().toISOString(),
  };
}

export function resolveDemoApproval(id: string, approve: boolean): boolean {
  const approvalIndex = state.approvals.indexOf(id);
  const decision = state.records.find((record) => record.id === id);
  if (approvalIndex < 0 || !decision) return false;
  state.approvals.splice(approvalIndex, 1);
  if (approve) state.operations -= Number(decision.amountUSDC);
  appendRecord({
    action: decision.action,
    amountUSDC: decision.amountUSDC,
    reasoning: `Human approver ${approve ? "approved" : "rejected"} the contractor payment. ${decision.reasoning}`,
    ruleApplied: "human_in_the_loop_approval",
    actionTaken: approve
      ? "Approved and simulated; no blockchain transaction was sent."
      : "Rejected by human approver; no funds moved.",
    recordType: "execution",
    relatedDecisionId: id,
    transactionId: approve ? `demo-approved-${uuid()}` : undefined,
  });
  return true;
}

if (initialDemoEnabled()) {
  setDemoEnabled(true);
}


// ────────────────────────────────────────────────
// @agentvault/shared – Domain Types
// ────────────────────────────────────────────────

// ── Wallet Types ────────────────────────────────

export type WalletPurpose = "treasury" | "operations" | "reserves" | "escrow";

export interface Wallet {
  id: string;
  address: string;
  purpose: WalletPurpose;
  balanceUSDC: string; // string to avoid floating-point
  balanceUSYC: string;
  createdAt: string;
}

// ── Transaction Types ──────────────────────────

export type TxDirection = "inbound" | "outbound";
export type TxStatus = "pending" | "confirmed" | "failed";
export type TxCategory =
  | "invoice_payment"
  | "vendor_payment"
  | "contractor_payment"
  | "yield_deposit"
  | "yield_withdrawal"
  | "bridge"
  | "borrow"
  | "repay"
  | "internal_transfer";

export interface Transaction {
  id: string;
  walletId: string;
  direction: TxDirection;
  status: TxStatus;
  category: TxCategory;
  amountUSDC: string;
  counterparty?: string;
  txHash?: string;
  memo?: string;
  createdAt: string;
  confirmedAt?: string;
}

// ── Decision Record (Audit Trail) ──────────────
// Every money movement MUST have one of these.
// This is the core innovation / trust mechanism.

export type DecisionAction =
  | "send"
  | "receive"
  | "invest_usyc"
  | "redeem_usyc"
  | "borrow"
  | "repay"
  | "bridge"
  | "hold";

export interface DecisionRecord {
  id: string;
  timestamp: string;
  agentSignature: string;
  actionTaken: string;

  // Snapshot at decision time
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

  // Reasoning
  forecast: string;        // Agent's cash-flow forecast summary
  reasoning: string;       // Natural language explanation
  ruleApplied: string;     // Which rule triggered this decision
  confidence: number;      // 0-1

  // Action
  action: DecisionAction;
  amountUSDC: string;
  category?: TxCategory;
  fromWallet?: string;
  toWallet?: string;
  toAddress?: string;
  transactionId?: string;
  transactionHash?: string;

  // Guardrails
  withinDailyLimit: boolean;
  requiresApproval: boolean;
  approvedBy?: string;     // null if auto-approved
  approvedAt?: string;
}

// ── Agent Configuration & Rules ────────────────

export interface GuardrailConfig {
  maxDailySpend: number;
  approvalThreshold: number;
  autoInvestThreshold: number;
  minReserveBalance: number;
  maxBorrowAmount: number;
  maxDailyBorrow: number;
  payrollDay?: number;
  reservePercent?: number;
  allowedCategories: TxCategory[];
  blockedAddresses: string[];
}

export interface AgentConfig {
  model: string;
  guardrails: GuardrailConfig;
  wallets: {
    treasury: string;
    operations: string;
    reserves: string;
  };
}

// ── Invoice ────────────────────────────────────

export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "cancelled";

export interface Invoice {
  id: string;
  recipientName: string;
  recipientAddress?: string;
  walletAddress?: string;
  amountUSDC: string;
  dueDate: string;
  status: InvoiceStatus;
  memo?: string;
  paymentTxId?: string;
  paymentLink?: string;
  createdAt: string;
}

// ── Cash-Flow Forecast ─────────────────────────

export interface ForecastEntry {
  date: string;
  expectedInflow: string;
  expectedOutflow: string;
  projectedBalance: string;
  notes?: string;
}

export interface CashFlowForecast {
  generatedAt: string;
  entries: ForecastEntry[];
  summary: string;
  recommendation: string;
}

// ── API Request / Response ─────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  page: number;
  pageSize: number;
  total: number;
}

// ── Chat / Agent Communication ─────────────────

export type ChatRole = "user" | "agent" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: string;
  metadata?: {
    decisionId?: string;
    transactionId?: string;
    toolCalls?: string[];
  };
}

// ── Dashboard Summary ──────────────────────────

export interface DashboardSummary {
  totalBalance: string;
  treasuryBalance: string;
  operationsBalance: string;
  reservesBalance: string;
  usycYield: string;
  outstandingLoans?: string;
  pendingTransactions: number;
  recentDecisions: DecisionRecord[];
  forecast: CashFlowForecast;
  agentStatus: "idle" | "thinking" | "executing" | "awaiting_approval";
  demoMode: boolean;
  modeLocked?: boolean;
}

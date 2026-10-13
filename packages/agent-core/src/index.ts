// ────────────────────────────────────────────────
// @agentvault/agent-core – Public API
// ────────────────────────────────────────────────

// Types & Schemas
export {
  GetBalanceParams,
  ForecastCashflowParams,
  SendUsdcParams,
  SaveToUsycParams,
  RedeemUsycParams,
  RecordDecisionParams,
  GenerateInvoiceParams,
  RecordIncomingPaymentParams,
  DecisionSchema,
  TOOL_DEFINITIONS,
  type Decision,
  type ToolDefinition,
} from "./types.js";

// Tools
export {
  executeTool,
  toolGetBalance,
  toolForecastCashflow,
  toolSendUsdc,
  toolSaveToUsyc,
  toolRedeemUsyc,
  toolCreateInvoice,
  toolRecordIncomingPayment,
  toolRecordDecision,
  type ToolResult,
  type ToolContext,
  type ToolName,
} from "./tools.js";

// Ledger
export {
  appendDecision,
  appendDecisionOutcome,
  appendVerifiedTransaction,
  getLedger,
  queryLedger,
  getDecisionById,
  getRecentDecisions,
  verifyChain,
  initLedger,
  type LedgerEntry,
  type LedgerQuery,
  type LedgerQueryResult,
} from "./ledger.js";
export {
  verifyArcUsdcTransfer,
  ArcTransactionVerificationError,
  type VerifiedArcUsdcTransfer,
} from "./circle-service.js";
export {
  getRealTractionTransactions,
  buildTractionSummary,
  formatTractionMarkdown,
  type RealTractionTransaction,
  type TractionSummary,
} from "./traction.js";

// Guardrails
export {
  checkGuardrails,
  setGuardrails,
  getGuardrails,
  getGuardrailsSummary,
  getRequiredReserveBalance,
  type GuardrailCheckResult,
  type ExtendedGuardrailConfig,
} from "./guardrails.js";

// Circle Service
export {
  initCircle,
  getWalletBalance,
  getUnifiedGatewayBalance,
  createWallet,
  transferUSDC,
  depositToUSYC,
  redeemFromUSYC,
  borrowUSDC,
  getBorrowCapacity,
  bridgeUSDC,
} from "./circle-service.js";

// Agent
export {
  initAgent,
  chat,
  evaluateAndAct,
  approveDecision,
  rejectDecision,
  setAgentWallet,
  getAgentStatus,
  getChatHistory,
  getPendingApprovals,
  getDashboardSummary,
} from "./agent.js";

export {
  createObligation,
  getObligations,
  updateObligationStatus,
  type TreasuryObligation,
  type ObligationStatus,
} from "./obligations.js";

export {
  createInvoice,
  getInvoices,
  recordIncomingPayment,
  getIncomingPayments,
  type IncomingPayment,
} from "./payments.js";

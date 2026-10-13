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
  BorrowUsdcParams,
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
  toolBorrowUsdc,
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

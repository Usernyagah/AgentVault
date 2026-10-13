// ────────────────────────────────────────────────
// @agentvault/agent-core – Zod Schemas & Types
// ────────────────────────────────────────────────
// Runtime-validated schemas for all tool parameters
// and the structured Decision object. Every money
// movement MUST produce a Decision before execution.
// ────────────────────────────────────────────────

import { z } from "zod";
import type { DecisionAction, TxCategory } from "@agentvault/shared";

// ── Tool Parameter Schemas ─────────────────────

export const GetBalanceParams = z.object({
  wallet: z
    .enum(["treasury", "operations", "reserves", "all"])
    .describe("Which wallet to check. Use 'all' to see every wallet."),
});
export type GetBalanceParams = z.infer<typeof GetBalanceParams>;

export const ForecastCashflowParams = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .default(30)
    .describe("Number of days to forecast (1–90)."),
  includeRecurring: z
    .boolean()
    .default(true)
    .describe("Whether to include known recurring inflows/outflows."),
});
export type ForecastCashflowParams = z.infer<typeof ForecastCashflowParams>;

export const SendUsdcParams = z.object({
  toAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid Ethereum-style address")
    .describe("Recipient wallet address (0x-prefixed, 40 hex chars)."),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Must be a valid USDC amount (up to 6 decimals)")
    .describe("Amount of USDC to send (string to preserve precision)."),
  memo: z
    .string()
    .max(256)
    .optional()
    .describe("Human-readable memo for the transfer."),
  category: z
    .enum([
      "invoice_payment",
      "vendor_payment",
      "contractor_payment",
      "internal_transfer",
    ] as const)
    .describe("The purpose category for this transfer."),
});
export type SendUsdcParams = z.infer<typeof SendUsdcParams>;

export const SaveToUsycParams = z.object({
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Must be a valid USDC amount")
    .describe("EXPERIMENTAL: Amount of USDC to deposit into the configured USYC adapter. Not fully verified on Arc testnet; do not use with funds that cannot be risked."),
  fromWallet: z
    .enum(["treasury", "operations"])
    .default("treasury")
    .describe("Experimental adapter source wallet. USYC integration is not fully verified on Arc testnet."),
});
export type SaveToUsycParams = z.infer<typeof SaveToUsycParams>;

export const RedeemUsycParams = z.object({
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Must be a valid USYC amount")
    .describe("EXPERIMENTAL: Amount of USYC to redeem using the configured adapter. Not fully verified on Arc testnet."),
  toWallet: z
    .enum(["treasury", "operations"])
    .default("treasury")
    .describe("Experimental adapter destination wallet. USYC integration is not fully verified on Arc testnet."),
});
export type RedeemUsycParams = z.infer<typeof RedeemUsycParams>;

export const RecordDecisionParams = z.object({
  action: z
    .enum(["send", "receive", "invest_usyc", "redeem_usyc", "repay", "bridge", "hold"])
    .describe("Supported actions: USDC transfers, experimental USYC adapter actions, or hold. Borrowing is disabled."),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Must be a valid USDC amount")
    .describe("Amount involved. USYC actions are experimental; borrowing is disabled."),
  reasoning: z
    .string()
    .min(20)
    .max(1000)
    .describe("Plain-English explanation of WHY this action is being taken."),
  forecast: z
    .string()
    .min(10)
    .max(500)
    .describe("Cash-flow forecast summary at the time of decision."),
  ruleApplied: z
    .string()
    .min(3)
    .max(200)
    .describe("Which business rule or policy triggered this action."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Agent's confidence in this decision (0–1)."),
  toAddress: z
    .string()
    .optional()
    .describe("Destination address if applicable."),
  category: z
    .enum([
      "invoice_payment",
      "vendor_payment",
      "contractor_payment",
      "yield_deposit",
      "yield_withdrawal",
      "bridge",
      "repay",
      "internal_transfer",
    ] as const)
    .optional()
    .describe("Transaction category, matching the movement tool when applicable."),
  fromWallet: z
    .enum(["treasury", "operations"])
    .optional()
    .describe("Source wallet for an investment, or operations for a payment."),
  toWallet: z
    .enum(["treasury", "operations"])
    .optional()
    .describe("Destination wallet for a redemption."),
});
export type RecordDecisionParams = z.infer<typeof RecordDecisionParams>;

export const GenerateInvoiceParams = z.object({
  recipientName: z.string().min(2).max(200).describe("Customer or counterparty name."),
  recipientAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional()
    .describe("Optional destination wallet to receive the payment (0x...40)."),
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional()
    .describe("Wallet that should receive inbound USDC for this invoice."),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Must be a valid USDC amount up to 6 decimals")
    .describe("Invoice total in USDC."),
  dueDate: z
    .string()
    .optional()
    .describe("Due date in ISO YYYY-MM-DD format."),
  memo: z.string().max(500).optional().describe("Invoice description or memo."),
});
export type GenerateInvoiceParams = z.infer<typeof GenerateInvoiceParams>;

export const RecordIncomingPaymentParams = z.object({
  invoiceId: z.string().optional().describe("Invoice ID to match to this payment, if known."),
  fromAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe("Sender address for the incoming USDC transfer."),
  toAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe("Treasury or invoice wallet address receiving the funds."),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Must be a valid USDC amount up to 6 decimals")
    .describe("Amount of USDC received."),
  txHash: z.string().optional().describe("Transaction hash on Arc/Circle."),
  memo: z.string().max(500).optional().describe("Optional payment memo."),
});
export type RecordIncomingPaymentParams = z.infer<typeof RecordIncomingPaymentParams>;

// ── Structured Decision Object ─────────────────
// The agent MUST produce this before any money movement.

export const DecisionSchema = z.object({
  action: z.enum([
    "send",
    "receive",
    "invest_usyc",
    "redeem_usyc",
    "repay",
    "bridge",
    "hold",
  ]),
  amountUSDC: z.string().regex(/^\d+(\.\d{1,6})?$/),
  reasoning: z
    .string()
    .min(20, "Reasoning must be at least 20 characters – explain the WHY."),
  forecast: z.string().min(10),
  ruleApplied: z.string().min(3),
  confidence: z.number().min(0).max(1),
  fromWallet: z.enum(["treasury", "operations", "reserves"]).optional(),
  toWallet: z.enum(["treasury", "operations", "reserves"]).optional(),
  toAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  category: z
    .enum([
      "invoice_payment",
      "vendor_payment",
      "contractor_payment",
      "yield_deposit",
      "yield_withdrawal",
      "bridge",
      "repay",
      "internal_transfer",
    ] as const)
    .optional(),
}).superRefine((decision, context) => {
  if (decision.action === "send" && !decision.toAddress) {
    context.addIssue({ code: "custom", message: "A send Decision requires a recipient address.", path: ["toAddress"] });
  }
  if (decision.action === "invest_usyc" && !decision.fromWallet) {
    context.addIssue({ code: "custom", message: "An investment Decision requires a source wallet.", path: ["fromWallet"] });
  }
  if (decision.action === "send" && decision.fromWallet && decision.fromWallet !== "operations") {
    context.addIssue({ code: "custom", message: "USDC sends must use the operations wallet.", path: ["fromWallet"] });
  }
  if (decision.action === "send" && decision.toWallet) {
    context.addIssue({ code: "custom", message: "USDC sends require a recipient address, not an internal destination wallet.", path: ["toWallet"] });
  }
  if (decision.action === "send" && decision.category && !["invoice_payment", "vendor_payment", "contractor_payment", "internal_transfer"].includes(decision.category)) {
    context.addIssue({ code: "custom", message: "A send Decision requires a payment category.", path: ["category"] });
  }
  if (decision.action === "invest_usyc" && decision.category && decision.category !== "yield_deposit") {
    context.addIssue({ code: "custom", message: "An investment Decision requires the yield_deposit category.", path: ["category"] });
  }
  if (decision.action === "invest_usyc" && decision.fromWallet === "reserves") {
    context.addIssue({ code: "custom", message: "The reserves wallet cannot be invested.", path: ["fromWallet"] });
  }
  if (decision.action === "invest_usyc" && decision.toWallet) {
    context.addIssue({ code: "custom", message: "An investment Decision does not have an internal destination wallet.", path: ["toWallet"] });
  }
  if (decision.action === "redeem_usyc" && decision.category && decision.category !== "yield_withdrawal") {
    context.addIssue({ code: "custom", message: "A redemption Decision requires the yield_withdrawal category.", path: ["category"] });
  }
  if (decision.action === "redeem_usyc" && decision.toWallet === "reserves") {
    context.addIssue({ code: "custom", message: "Redemptions can only be sent to treasury or operations.", path: ["toWallet"] });
  }
});
export type Decision = z.infer<typeof DecisionSchema>;

// ── Tool Definitions for OpenAI Function Calling ─

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// We build the OpenAI-compatible function schemas from Zod
// using zodToJsonSchema-style output (hand-written for precision).

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_balance",
    description:
      "Fetch the current USDC and USYC balance of one or all Circle wallets. Always call this before making any financial decision.",
    parameters: {
      type: "object",
      properties: {
        wallet: {
          type: "string",
          enum: ["treasury", "operations", "reserves", "all"],
          description: "Which wallet to check. Use 'all' to see every wallet.",
        },
      },
      required: ["wallet"],
    },
  },
  {
    name: "forecast_cashflow",
    description:
      "Generate a cash-flow forecast for the next N days. Use this to anticipate shortfalls or surpluses before deciding on actions.",
    parameters: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Number of days to forecast (1–90). Default 30.",
          minimum: 1,
          maximum: 90,
        },
        includeRecurring: {
          type: "boolean",
          description: "Include known recurring inflows/outflows. Default true.",
        },
      },
      required: [],
    },
  },
  {
    name: "create_invoice",
    description:
      "Generate a customer invoice or USDC payment link for inbound funds. This creates a payable invoice and returns a canonical Arc-compatible payment URL.",
    parameters: {
      type: "object",
      properties: {
        recipientName: {
          type: "string",
          description: "Customer or counterparty name.",
        },
        recipientAddress: {
          type: "string",
          description: "Optional customer wallet receiving payment on Arc.",
        },
        walletAddress: {
          type: "string",
          description: "Treasury wallet/address that should receive the incoming USDC.",
        },
        amount: {
          type: "string",
          description: "Invoice amount in USDC.",
        },
        dueDate: {
          type: "string",
          description: "Invoice due date in ISO YYYY-MM-DD format.",
        },
        memo: {
          type: "string",
          description: "Optional invoice description.",
        },
      },
      required: ["recipientName", "amount"],
    },
  },
  {
    name: "record_incoming_payment",
    description:
      "Register a received USDC payment, attach it to an invoice if known, and update the payment status in the ledger. A matching Decision must be recorded first.",
    parameters: {
      type: "object",
      properties: {
        invoiceId: {
          type: "string",
          description: "Invoice ID to match to this payment.",
        },
        fromAddress: {
          type: "string",
          description: "Sender address for the incoming payment.",
        },
        toAddress: {
          type: "string",
          description: "Treasury wallet or invoice wallet that received the payment.",
        },
        amount: {
          type: "string",
          description: "USDC amount received.",
        },
        txHash: {
          type: "string",
          description: "Arc transaction hash for this received payment.",
        },
        memo: {
          type: "string",
          description: "Optional payment memo.",
        },
      },
      required: ["fromAddress", "toAddress", "amount"],
    },
  },
  {
    name: "send_usdc",
    description:
      "Transfer USDC from the operations wallet to an external address using Circle Developer-Controlled Wallets on Arc testnet. A matching Decision must be recorded first.",
    parameters: {
      type: "object",
      properties: {
        toAddress: {
          type: "string",
          description: "Recipient address (0x-prefixed, 40 hex chars).",
        },
        amount: {
          type: "string",
          description: "Amount of USDC to send.",
        },
        memo: {
          type: "string",
          description: "Human-readable memo.",
        },
        category: {
          type: "string",
          enum: [
            "invoice_payment",
            "vendor_payment",
            "contractor_payment",
            "internal_transfer",
          ],
          description: "Purpose of the transfer.",
        },
      },
      required: ["toAddress", "amount", "category"],
    },
  },
  {
    name: "save_to_usyc",
    description:
      "EXPERIMENTAL / NOT FULLY VERIFIED ON TESTNET. USYC contract calls use an unverified adapter; this is not a supported or tested yield product. Do not execute or imply safety; only proceed if the user explicitly requests experimental testnet interaction.",
    parameters: {
      type: "object",
      properties: {
        amount: {
          type: "string",
          description: "EXPERIMENTAL / NOT FULLY VERIFIED ON TESTNET. USDC amount to pass to the unverified USYC adapter.",
        },
        fromWallet: {
          type: "string",
          enum: ["treasury", "operations"],
          description: "Wallet to fund from. Default 'treasury'.",
        },
      },
      required: ["amount"],
    },
  },
  {
    name: "redeem_usyc",
    description:
      "EXPERIMENTAL / NOT FULLY VERIFIED ON TESTNET. USYC contract calls use an unverified adapter; this is not a supported or tested redemption flow. Do not execute or imply safety; only proceed if the user explicitly requests experimental testnet interaction.",
    parameters: {
      type: "object",
      properties: {
        amount: {
          type: "string",
          description: "EXPERIMENTAL / NOT FULLY VERIFIED ON TESTNET. USYC amount to pass to the unverified redemption adapter.",
        },
        toWallet: {
          type: "string",
          enum: ["treasury", "operations"],
          description: "Wallet to receive USDC. Default 'treasury'.",
        },
      },
      required: ["amount"],
    },
  },
  {
    name: "record_decision",
    description:
      "Record a structured Decision in the append-only audit ledger before supported money movements. USYC adapter actions are experimental and not fully verified on testnet; borrowing is disabled and must not be recorded as an available action.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "send",
            "receive",
            "invest_usyc",
            "redeem_usyc",
            "repay",
            "bridge",
            "hold",
          ],
          description: "Supported action type. Borrow is disabled; USYC save/redeem actions are experimental and not fully verified on testnet.",
        },
        amount: {
          type: "string",
          description: "USDC amount.",
        },
        reasoning: {
          type: "string",
          description:
            "Plain-English explanation of WHY this action is being taken (min 20 chars).",
        },
        forecast: {
          type: "string",
          description: "Cash-flow forecast summary at decision time.",
        },
        ruleApplied: {
          type: "string",
          description: "Which rule or policy applies.",
        },
        confidence: {
          type: "number",
          description: "Confidence 0–1.",
          minimum: 0,
          maximum: 1,
        },
        toAddress: {
          type: "string",
          description: "Destination address if applicable.",
        },
        category: {
          type: "string",
          enum: [
            "invoice_payment",
            "vendor_payment",
            "contractor_payment",
            "yield_deposit",
            "yield_withdrawal",
            "bridge",
            "repay",
            "internal_transfer",
          ],
          description: "Transaction category, matching the movement tool when applicable.",
        },
        fromWallet: {
          type: "string",
          enum: ["treasury", "operations"],
          description: "Source wallet for an investment, or operations for a payment.",
        },
        toWallet: {
          type: "string",
          enum: ["treasury", "operations", "reserves"],
          description: "Destination wallet for a redemption.",
        },
      },
      required: ["action", "amount", "reasoning", "forecast", "ruleApplied", "confidence"],
    },
  },
];

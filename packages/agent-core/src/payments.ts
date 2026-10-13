// ────────────────────────────────────────────────
// @agentvault/agent-core – Invoice & Payment Receipt Tracking
// ────────────────────────────────────────────────

import { randomUUID } from "crypto";
import { z } from "zod";
import type { Invoice } from "@agentvault/shared";

export const InvoiceInputSchema = z.object({
  id: z.string().optional(),
  recipientName: z.string().min(2).max(200),
  recipientAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  amountUSDC: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Amount must be a valid USDC amount up to 6 decimals"),
  dueDate: z.string().optional(),
  memo: z.string().max(500).optional(),
  status: z.enum(["draft", "sent", "paid", "overdue", "cancelled"]).optional(),
  paymentTxId: z.string().optional(),
  createdAt: z.string().optional(),
  paymentLink: z.string().url().optional(),
});

export interface IncomingPayment {
  id: string;
  invoiceId?: string;
  fromAddress: string;
  toAddress: string;
  amountUSDC: string;
  txHash?: string;
  memo?: string;
  status: "pending" | "confirmed" | "failed";
  createdAt: string;
  confirmedAt?: string;
}

const invoices: Invoice[] = [];
const incomingPayments: IncomingPayment[] = [];

function buildPaymentLink(invoiceId: string, amountUSDC: string, walletAddress?: string, memo?: string) {
  const params = new URLSearchParams({
    amount: amountUSDC,
    wallet: walletAddress ?? "",
    memo: memo ?? "",
  });

  return `https://agentvault.local/pay/${invoiceId}?${params.toString()}`;
}

export function createInvoice(raw: unknown): Invoice {
  const input = InvoiceInputSchema.parse(raw);
  const invoiceId = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();

  const invoice: Invoice = {
    id: invoiceId,
    recipientName: input.recipientName,
    recipientAddress: input.recipientAddress,
    walletAddress: input.walletAddress ?? input.recipientAddress,
    amountUSDC: input.amountUSDC,
    dueDate: input.dueDate ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    status: input.status ?? "draft",
    memo: input.memo,
    paymentTxId: input.paymentTxId,
    createdAt,
    paymentLink:
      input.paymentLink ??
      buildPaymentLink(invoiceId, input.amountUSDC, input.walletAddress ?? input.recipientAddress, input.memo),
  };

  invoices.push(invoice);
  return { ...invoice };
}

export function getInvoices(): Invoice[] {
  return invoices.map((invoice) => ({ ...invoice }));
}

export const IncomingPaymentSchema = z.object({
  id: z.string().optional(),
  invoiceId: z.string().optional(),
  fromAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  toAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amountUSDC: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Amount must be a valid USDC amount up to 6 decimals"),
  txHash: z.string().optional(),
  memo: z.string().max(500).optional(),
  status: z.enum(["pending", "confirmed", "failed"]).optional(),
  createdAt: z.string().optional(),
  confirmedAt: z.string().optional(),
});

export function recordIncomingPayment(raw: unknown): IncomingPayment {
  const input = IncomingPaymentSchema.parse(raw);
  const payment: IncomingPayment = {
    id: input.id ?? randomUUID(),
    invoiceId: input.invoiceId,
    fromAddress: input.fromAddress,
    toAddress: input.toAddress,
    amountUSDC: input.amountUSDC,
    txHash: input.txHash,
    memo: input.memo,
    status: input.status ?? "confirmed",
    createdAt: input.createdAt ?? new Date().toISOString(),
    confirmedAt: input.confirmedAt ?? (input.status === "confirmed" ? new Date().toISOString() : undefined),
  };

  incomingPayments.push(payment);

  if (payment.invoiceId) {
    const invoice = invoices.find((entry) => entry.id === payment.invoiceId);
    if (invoice) {
      invoice.status = "paid";
      invoice.paymentTxId = payment.txHash ?? invoice.paymentTxId;
    }
  }

  return { ...payment };
}

export function getIncomingPayments(): IncomingPayment[] {
  return incomingPayments.map((entry) => ({ ...entry }));
}

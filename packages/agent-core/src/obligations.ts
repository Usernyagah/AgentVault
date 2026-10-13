import { v4 as uuid } from "uuid";
import { z } from "zod";

const ObligationInputSchema = z.object({
  description: z.string().trim().min(3).max(256),
  amountUSDC: z.string().regex(/^\d+(\.\d{1,6})?$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  wallet: z.enum(["treasury", "operations"]).default("operations"),
});

export type ObligationStatus = "open" | "paid" | "cancelled";

export interface TreasuryObligation {
  id: string;
  description: string;
  amountUSDC: string;
  dueDate: string;
  wallet: "treasury" | "operations";
  status: ObligationStatus;
  createdAt: string;
  settledAt?: string;
}

const obligations: TreasuryObligation[] = [];

export function createObligation(raw: unknown): TreasuryObligation {
  const input = ObligationInputSchema.parse(raw);
  const dueDate = new Date(`${input.dueDate}T00:00:00.000Z`);
  if (Number.isNaN(dueDate.getTime()) || dueDate.toISOString().slice(0, 10) !== input.dueDate) {
    throw new Error("dueDate must be a real calendar date in YYYY-MM-DD format.");
  }

  const obligation: TreasuryObligation = {
    ...input,
    id: uuid(),
    status: "open",
    createdAt: new Date().toISOString(),
  };
  obligations.push(obligation);
  return { ...obligation };
}

export function getObligations(): TreasuryObligation[] {
  return obligations.map((obligation) => ({ ...obligation }));
}

export function updateObligationStatus(
  id: string,
  status: Exclude<ObligationStatus, "open">
): TreasuryObligation | undefined {
  const obligation = obligations.find((item) => item.id === id);
  if (!obligation || obligation.status !== "open") return undefined;
  obligation.status = status;
  obligation.settledAt = new Date().toISOString();
  return { ...obligation };
}

import type { DecisionAction } from "@agentvault/shared";
import type { LedgerEntry } from "./ledger.js";

const ARC_TESTNET_CHAIN_ID = 5_042_002;
const ARC_TESTNET_EXPLORER_URL = "https://explorer.testnet.arc.io";

export interface RealTractionTransaction {
  timestamp: string;
  action: DecisionAction;
  amount: string;
  asset: "USDC" | "USYC";
  transactionHash: string;
  explorerUrl: string;
  verification: "Arc receipt + USDC event" | "Circle confirmed";
  from?: string;
  to?: string;
}

export interface TractionSummary {
  generatedAt: string;
  network: "Arc Testnet";
  chainId: number;
  totalTransactions: number;
  totalUSDC: string;
  transactions: RealTractionTransaction[];
}

function isSuccessfulCircleExecution(entry: LedgerEntry): boolean {
  if (entry.recordType !== "execution" || !entry.transactionHash) return false;
  if (!["send", "invest_usyc", "redeem_usyc", "borrow", "repay"].includes(entry.action)) {
    return false;
  }
  return (
    /Transfer confirmed on Arc testnet at Circle status (?:CONFIRMED|COMPLETE)\./i.test(entry.actionTaken) ||
    /\bwith status (?:confirmed|complete)\b/i.test(entry.actionTaken)
  );
}

export function getRealTractionTransactions(
  entries: readonly LedgerEntry[]
): RealTractionTransaction[] {
  const transactionsByHash = new Map<string, RealTractionTransaction>();

  for (const entry of entries) {
    const manuallyVerified =
      entry.recordType === "verified_transaction" &&
      entry.verifiedRealUsage === true &&
      entry.verificationChainId === ARC_TESTNET_CHAIN_ID &&
      entry.verificationBlockNumber !== undefined &&
      entry.verificationLogIndex !== undefined;
    if (!manuallyVerified && !isSuccessfulCircleExecution(entry)) continue;
    if (!entry.transactionHash || !/^0x[0-9a-f]{64}$/i.test(entry.transactionHash)) continue;

    const transaction: RealTractionTransaction = {
      timestamp: entry.timestamp,
      action: entry.action,
      amount: entry.amountUSDC,
      asset: entry.action === "redeem_usyc" ? "USYC" : "USDC",
      transactionHash: entry.transactionHash,
      explorerUrl: `${ARC_TESTNET_EXPLORER_URL}/tx/${encodeURIComponent(entry.transactionHash)}`,
      verification: manuallyVerified ? "Arc receipt + USDC event" : "Circle confirmed",
      from: entry.transferFrom,
      to: entry.transferTo ?? entry.toAddress,
    };
    const key = entry.transactionHash.toLowerCase();
    const existing = transactionsByHash.get(key);
    if (!existing || transaction.verification === "Arc receipt + USDC event") {
      transactionsByHash.set(key, transaction);
    }
  }

  return [...transactionsByHash.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp)
  );
}

export function buildTractionSummary(
  transactions: RealTractionTransaction[]
): TractionSummary {
  const totalMicroUSDC = transactions
    .filter((transaction) => transaction.asset === "USDC")
    .reduce((sum, transaction) => {
      const amount = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(transaction.amount);
      if (!amount) throw new Error(`Invalid USDC amount in verified traction record: ${transaction.amount}`);
      return sum + BigInt(amount[1]!) * 1_000_000n + BigInt((amount[2] ?? "").padEnd(6, "0") || "0");
    }, 0n);
  const totalCents = (totalMicroUSDC + 5_000n) / 10_000n;
  const totalUSDC = `${totalCents / 100n}.${String(totalCents % 100n).padStart(2, "0")}`;
  return {
    generatedAt: new Date().toISOString(),
    network: "Arc Testnet",
    chainId: ARC_TESTNET_CHAIN_ID,
    totalTransactions: transactions.length,
    totalUSDC,
    transactions,
  };
}

export function formatTractionMarkdown(summary: TractionSummary): string {
  const lines = [
    "# Verified Arc Testnet Activity",
    "",
    `- Network: ${summary.network} (chain ID ${summary.chainId})`,
    `- Confirmed transactions: ${summary.totalTransactions}`,
    `- Total USDC transaction volume: $${summary.totalUSDC}`,
    `- Generated: ${summary.generatedAt}`,
    "",
    "| Timestamp (UTC) | Type | Amount | Transaction | Verification |",
    "|---|---|---:|---|---|",
  ];

  if (summary.transactions.length === 0) {
    lines.push("| — | No verified transactions yet | — | — | — |");
  } else {
    for (const transaction of summary.transactions) {
      lines.push(
        `| ${transaction.timestamp} | ${transaction.action} | ${transaction.asset === "USDC" ? "$" : ""}${transaction.amount} ${transaction.asset} | [${transaction.transactionHash}](${transaction.explorerUrl}) | ${transaction.verification} |`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

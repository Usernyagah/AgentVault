// ────────────────────────────────────────────────
// @agentvault/agent-core – Circle Service
// ────────────────────────────────────────────────
// Circle Developer-Controlled Wallet operations on Arc testnet.
// Contract actions remain disabled until their on-chain
// integrations are configured and verified.
// ────────────────────────────────────────────────

import type { Wallet, Transaction, TxCategory, TxDirection } from "@agentvault/shared";
import { v4 as uuid } from "uuid";
import {
  Blockchain,
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, formatUnits, http, parseUnits, type Address } from "viem";

// ── Configuration ──────────────────────────────

interface CircleConfig {
  apiKey: string;
  entitySecret: string;
  walletSetId: string;
  usdcTokenId: string;
  gatewayApiBaseUrl: string;
  gatewaySourceDomains: number[];
  arcRpcUrl: string;
  usdcContractAddress: string;
  usycVaultAddress: string;
  usycShareDecimals: number;
  lendingContractAddress: string;
  lendingTokenDecimals: number;
}

export interface UnifiedGatewayBalance {
  depositor: string;
  balances: Array<{ domain: number; balanceUSDC: string }>;
  totalUSDC: string;
}

let circleConfig: CircleConfig | null = null;
let circleClient: CircleDeveloperControlledWalletsClient | null = null;

export function initCircle(config: CircleConfig): void {
  circleConfig = config;
  circleClient =
    config.apiKey && config.entitySecret
      ? initiateDeveloperControlledWalletsClient({
          apiKey: config.apiKey,
          entitySecret: config.entitySecret,
        })
      : null;
  console.log("[CIRCLE] Initialized with wallet set:", config.walletSetId);
}

function ensureInitialized(): CircleConfig {
  if (!circleConfig) {
    throw new Error("Circle service not initialized. Call initCircle() first.");
  }
  return circleConfig;
}

function ensureClient(): {
  config: CircleConfig;
  client: CircleDeveloperControlledWalletsClient;
} {
  const config = ensureInitialized();
  if (!circleClient) {
    throw new Error("Circle API key and entity secret are required for wallet operations.");
  }
  return { config, client: circleClient };
}

function mapTransactionStatus(state: string): Transaction["status"] {
  if (state === "CONFIRMED" || state === "COMPLETE") return "confirmed";
  if (state === "FAILED" || state === "DENIED" || state === "CANCELLED") return "failed";
  return "pending";
}

async function executeContractTransaction(params: {
  walletId: string;
  contractAddress: string;
  functionSignature: string;
  arguments: Array<string | number | boolean>;
}): Promise<{ id: string; txHash?: string; createdAt: string }> {
  const { client } = ensureClient();
  const walletResponse = await client.getWallet({ id: params.walletId });
  const wallet = walletResponse.data?.wallet;
  if (!wallet || wallet.blockchain !== Blockchain.ArcTestnet) {
    throw new Error("Contract actions are restricted to configured ARC-TESTNET wallets.");
  }

  const submitted = await client.createContractExecutionTransaction({
    walletId: params.walletId,
    contractAddress: params.contractAddress,
    abiFunctionSignature: params.functionSignature,
    abiParameters: params.arguments,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const id = submitted.data?.id;
  if (!id) throw new Error(`Circle did not return a transaction ID for ${params.functionSignature}.`);

  const completed = await client.getTransaction({ id, waitForState: "COMPLETE" });
  const transaction = completed.data?.transaction;
  if (!transaction || transaction.state !== "COMPLETE") {
    throw new Error(`${params.functionSignature} did not complete on Arc testnet.`);
  }
  return { id, txHash: transaction.txHash, createdAt: transaction.createDate };
}

function getWalletPublicClient() {
  const config = ensureInitialized();
  if (!config.arcRpcUrl) throw new Error("ARC_RPC_URL is required for lending pool reads.");
  return createPublicClient({ transport: http(config.arcRpcUrl) });
}

// ── Wallet Operations ──────────────────────────

export async function getWalletBalance(
  walletId: string,
  purpose: Wallet["purpose"] = "treasury"
): Promise<Wallet> {
  const { client } = ensureClient();
  const [walletResponse, balanceResponse] = await Promise.all([
    client.getWallet({ id: walletId }),
    client.getWalletTokenBalance({ id: walletId, includeAll: true }),
  ]);
  const wallet = walletResponse.data?.wallet;
  if (!wallet) throw new Error(`Circle did not return wallet ${walletId}.`);
  if (wallet.blockchain !== Blockchain.ArcTestnet) {
    throw new Error(`Wallet ${walletId} is on ${wallet.blockchain}, not ARC-TESTNET.`);
  }

  const tokenBalances = balanceResponse.data?.tokenBalances ?? [];
  const usdc = tokenBalances.find(
    ({ token }) => token.id === ensureInitialized().usdcTokenId || token.symbol?.toUpperCase() === "USDC"
  );
  const usyc = tokenBalances.find(({ token }) => token.symbol?.toUpperCase() === "USYC");

  return {
    id: wallet.id,
    address: wallet.address,
    purpose,
    balanceUSDC: usdc?.amount ?? "0.00",
    balanceUSYC: usyc?.amount ?? "0.00",
    createdAt: wallet.createDate,
  };
}

function usdcToUnits(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}

function unitsToUSDC(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

export async function getUnifiedGatewayBalance(
  depositor: string
): Promise<UnifiedGatewayBalance> {
  const config = ensureInitialized();
  const response = await fetch(`${config.gatewayApiBaseUrl.replace(/\/$/, "")}/v1/balances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: "USDC",
      sources: config.gatewaySourceDomains.map((domain) => ({ domain, depositor })),
    }),
  });
  if (!response.ok) {
    throw new Error(`Gateway balance request failed (${response.status}): ${await response.text()}`);
  }

  const result = (await response.json()) as {
    balances?: Array<{ domain: number; balance: string }>;
  };
  if (!Array.isArray(result.balances)) {
    throw new Error("Gateway returned an invalid balances response.");
  }
  const balances = result.balances.map(({ domain, balance }) => {
    if (!Number.isInteger(domain) || !/^\d+(\.\d{1,6})?$/.test(balance)) {
      throw new Error("Gateway returned a malformed domain or USDC balance.");
    }
    return { domain, balanceUSDC: balance };
  });
  const totalUnits = balances.reduce((sum, balance) => sum + usdcToUnits(balance.balanceUSDC), 0n);

  return {
    depositor,
    balances,
    totalUSDC: unitsToUSDC(totalUnits),
  };
}

export async function createWallet(
  purpose: Wallet["purpose"]
): Promise<Wallet> {
  const { config, client } = ensureClient();
  if (!config.walletSetId) throw new Error("CIRCLE_WALLET_SET_ID is required to create wallets.");
  const response = await client.createWallets({
    walletSetId: config.walletSetId,
    blockchains: [Blockchain.ArcTestnet],
    count: 1,
    metadata: [{ name: purpose }],
  });
  const wallet = response.data?.wallets?.[0];
  if (!wallet) throw new Error("Circle did not return the created wallet.");
  return {
    id: wallet.id,
    address: wallet.address,
    purpose,
    balanceUSDC: "0.00",
    balanceUSYC: "0.00",
    createdAt: wallet.createDate,
  };
}

// ── Transfer (via Paymaster for gasless) ───────

export async function transferUSDC(params: {
  fromWalletId: string;
  toAddress: string;
  amount: string;
  category: TxCategory;
  memo?: string;
}): Promise<Transaction> {
  const { config, client } = ensureClient();
  if (!config.usdcTokenId) throw new Error("CIRCLE_USDC_TOKEN_ID is required to send USDC.");
  const wallet = await client.getWallet({ id: params.fromWalletId });
  if (wallet.data?.wallet?.blockchain !== Blockchain.ArcTestnet) {
    throw new Error("USDC transfers are restricted to ARC-TESTNET wallets.");
  }
  const response = await client.createTransaction({
    walletId: params.fromWalletId,
    tokenId: config.usdcTokenId,
    amount: [params.amount],
    destinationAddress: params.toAddress,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const transaction = response.data;
  if (!transaction?.id) throw new Error("Circle did not return a transfer transaction ID.");
  const details = await client.getTransaction({ id: transaction.id });

  return {
    id: transaction.id,
    walletId: params.fromWalletId,
    direction: "outbound" as TxDirection,
    status: mapTransactionStatus(transaction.state),
    category: params.category,
    amountUSDC: params.amount,
    counterparty: params.toAddress,
    txHash: details.data?.transaction?.txHash,
    memo: params.memo,
    createdAt: new Date().toISOString(),
  };
}

// ── USYC (Yield) Operations ───────────────────

export async function depositToUSYC(
  walletId: string,
  amount: string
): Promise<Transaction> {
  const { config, client } = ensureClient();
  if (!config.usycVaultAddress || !config.usdcContractAddress) {
    throw new Error("USYC deposits require USYC_VAULT_ADDRESS and ARC_TESTNET_USDC_ADDRESS for an ERC-4626-compatible vault.");
  }
  const walletResponse = await client.getWallet({ id: walletId });
  const address = walletResponse.data?.wallet?.address;
  if (!address) throw new Error(`Circle did not return wallet ${walletId}.`);
  const amountUnits = parseUnits(amount, 6).toString();

  await executeContractTransaction({
    walletId,
    contractAddress: config.usdcContractAddress,
    functionSignature: "approve(address,uint256)",
    arguments: [config.usycVaultAddress, amountUnits],
  });
  const transaction = await executeContractTransaction({
    walletId,
    contractAddress: config.usycVaultAddress,
    functionSignature: "deposit(uint256,address)",
    arguments: [amountUnits, address],
  });
  return {
    id: transaction.id,
    walletId,
    direction: "outbound",
    status: "confirmed",
    category: "yield_deposit",
    amountUSDC: amount,
    txHash: transaction.txHash,
    memo: "Deposit USDC into configured USYC ERC-4626 vault",
    createdAt: transaction.createdAt,
    confirmedAt: transaction.createdAt,
  };
}

export async function redeemFromUSYC(
  walletId: string,
  amount: string
): Promise<Transaction> {
  const config = ensureInitialized();
  if (!config.usycVaultAddress) {
    throw new Error("USYC redemptions require USYC_VAULT_ADDRESS for an ERC-4626-compatible vault.");
  }
  const wallet = await getWalletBalance(walletId);
  const owner = wallet.address;
  const amountUnits = parseUnits(amount, config.usycShareDecimals).toString();
  const transaction = await executeContractTransaction({
    walletId,
    contractAddress: config.usycVaultAddress,
    functionSignature: "redeem(uint256,address,address)",
    arguments: [amountUnits, owner, owner],
  });
  return {
    id: transaction.id,
    walletId,
    direction: "inbound",
    status: "confirmed",
    category: "yield_withdrawal",
    amountUSDC: amount,
    txHash: transaction.txHash,
    memo: "Redeem configured USYC ERC-4626 shares to USDC",
    createdAt: transaction.createdAt,
    confirmedAt: transaction.createdAt,
  };
}

const lendingAbi = [
  {
    type: "function",
    name: "maxBorrow",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "poolLiquidity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export async function getBorrowCapacity(walletId: string): Promise<{
  maxBorrowUSDC: string;
  poolLiquidityUSDC: string;
  availableUSDC: string;
}> {
  const config = ensureInitialized();
  if (!config.lendingContractAddress) {
    throw new Error("ARC_LENDING_CONTRACT_ADDRESS is required for borrow capacity checks.");
  }
  const wallet = await getWalletBalance(walletId);
  const client = getWalletPublicClient();
  const [maxBorrow, poolLiquidity] = await Promise.all([
    client.readContract({
      address: config.lendingContractAddress as Address,
      abi: lendingAbi,
      functionName: "maxBorrow",
      args: [wallet.address as Address],
    }),
    client.readContract({
      address: config.lendingContractAddress as Address,
      abi: lendingAbi,
      functionName: "poolLiquidity",
    }),
  ]);
  const available = maxBorrow < poolLiquidity ? maxBorrow : poolLiquidity;
  return {
    maxBorrowUSDC: formatUnits(maxBorrow, config.lendingTokenDecimals),
    poolLiquidityUSDC: formatUnits(poolLiquidity, config.lendingTokenDecimals),
    availableUSDC: formatUnits(available, config.lendingTokenDecimals),
  };
}

// ── Borrow (via DeFi Lending on Arc) ──────────

export async function borrowUSDC(
  walletId: string,
  amount: string,
  reason: string
): Promise<Transaction> {
  const config = ensureInitialized();
  if (!config.lendingContractAddress) {
    throw new Error("ARC_LENDING_CONTRACT_ADDRESS is required for borrowing.");
  }
  const capacity = await getBorrowCapacity(walletId);
  if (parseUnits(amount, config.lendingTokenDecimals) > parseUnits(capacity.availableUSDC, config.lendingTokenDecimals)) {
    throw new Error(`Borrow exceeds configured collateral and pool capacity ($${capacity.availableUSDC} available).`);
  }
  const transaction = await executeContractTransaction({
    walletId,
    contractAddress: config.lendingContractAddress,
    functionSignature: "takeLoan(uint256)",
    arguments: [parseUnits(amount, config.lendingTokenDecimals).toString()],
  });
  return {
    id: transaction.id,
    walletId,
    direction: "inbound",
    status: "confirmed",
    category: "borrow",
    amountUSDC: amount,
    txHash: transaction.txHash,
    memo: `Arc lending pool borrow: ${reason}`,
    createdAt: transaction.createdAt,
    confirmedAt: transaction.createdAt,
  };
}

// ── CCTP Bridge ───────────────────────────────

export async function bridgeUSDC(params: {
  fromWalletId: string;
  toChain: string;
  toAddress: string;
  amount: string;
}): Promise<Transaction> {
  ensureInitialized();

  // TODO: Replace with Gateway / CCTP call
  // const { data } = await circleDeveloperSdk.createCCTPTransfer({
  //   walletId: params.fromWalletId,
  //   destinationChain: params.toChain,
  //   destinationAddress: params.toAddress,
  //   amount: params.amount,
  // });
  console.log(
    `[CIRCLE] Bridging ${params.amount} USDC → ${params.toChain} via CCTP`
  );

  return {
    id: uuid(),
    walletId: params.fromWalletId,
    direction: "outbound",
    status: "pending",
    category: "bridge",
    amountUSDC: params.amount,
    counterparty: params.toAddress,
    memo: `Bridge to ${params.toChain}`,
    createdAt: new Date().toISOString(),
  };
}

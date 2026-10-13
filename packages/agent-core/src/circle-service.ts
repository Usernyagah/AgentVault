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
import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
  isAddress,
  keccak256,
  parseUnits,
  toBytes,
  type Address,
  type Hash,
} from "viem";

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

const ARC_TESTNET_EXPLORER_URL = "https://explorer.testnet.arc.io";
const ARC_TESTNET_CHAIN_ID = 5_042_002;
const TRANSFER_CONFIRMATION_TIMEOUT_MS = 60_000;
const usdcTransferAbi = [{
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
}] as const;
const usdcTransferTopic = keccak256(toBytes("Transfer(address,address,uint256)"));

export class ArcTransactionVerificationError extends Error {
  constructor(message: string, readonly statusCode: 422 | 502 | 503) {
    super(message);
    this.name = "ArcTransactionVerificationError";
  }
}

export interface VerifiedArcUsdcTransfer {
  transactionHash: string;
  amountUSDC: string;
  timestamp: string;
  chainId: number;
  blockNumber: bigint;
  logIndex: number;
  from: string;
  to: string;
}

export function initCircle(config: CircleConfig): void {
  circleConfig = config;
  circleClient =
    config.apiKey?.trim() && config.entitySecret?.trim()
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
    const missing = [
      !config.apiKey?.trim() ? "CIRCLE_API_KEY" : undefined,
      !config.entitySecret?.trim() ? "CIRCLE_ENTITY_SECRET" : undefined,
    ].filter((value): value is string => value !== undefined);
    if (missing.length === 0) {
      throw new Error("Circle wallet client could not be initialized. Verify Circle credentials and restart the API.");
    }
    throw new Error(
      `Circle wallet operations require ${missing.join(" and ")}. Configure the missing credential${missing.length > 1 ? "s" : ""} and restart the API.`
    );
  }
  return { config, client: circleClient };
}

function mapTransactionStatus(state: string): Transaction["status"] {
  if (state === "CONFIRMED" || state === "COMPLETE") return "confirmed";
  if (["FAILED", "DENIED", "CANCELLED", "STUCK"].includes(state)) return "failed";
  return "pending";
}

export interface CircleTransferResult extends Transaction {
  success: boolean;
  finalStatus: string;
  explorerUrl?: string;
  error?: string;
}

function getExplorerTransactionUrl(txHash?: string): string | undefined {
  return txHash
    ? `${ARC_TESTNET_EXPLORER_URL}/tx/${encodeURIComponent(txHash)}`
    : undefined;
}

function getCircleTransactionError(transaction: {
  errorReason?: string;
  errorDetails?: string;
}): string | undefined {
  return [transaction.errorReason, transaction.errorDetails]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(": ") || undefined;
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

export async function verifyArcUsdcTransfer(params: {
  transactionHash: string;
  amountUSDC: string;
}): Promise<VerifiedArcUsdcTransfer> {
  const config = ensureInitialized();
  if (!config.arcRpcUrl?.trim()) {
    throw new ArcTransactionVerificationError("ARC_RPC_URL is required to verify Arc transactions.", 503);
  }
  if (!config.usdcContractAddress || !isAddress(config.usdcContractAddress)) {
    throw new ArcTransactionVerificationError(
      "Set ARC_TESTNET_USDC_ADDRESS to the Arc testnet USDC contract address before verifying transactions.",
      503
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.transactionHash)) {
    throw new ArcTransactionVerificationError("Transaction hash must be a 32-byte 0x-prefixed hex hash.", 422);
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(params.amountUSDC)) {
    throw new ArcTransactionVerificationError("USDC amount must be positive and use no more than 6 decimal places.", 422);
  }

  const amountUnits = parseUnits(params.amountUSDC, 6);
  if (amountUnits <= 0n) {
    throw new ArcTransactionVerificationError("USDC amount must be greater than zero.", 422);
  }

  const client = createPublicClient({ transport: http(config.arcRpcUrl) });
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (error) {
    throw new ArcTransactionVerificationError(
      `Unable to reach the configured Arc RPC endpoint: ${error instanceof Error ? error.message : String(error)}`,
      502
    );
  }
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new ArcTransactionVerificationError(
      `Configured RPC is on chain ${chainId}; Arc testnet chain ${ARC_TESTNET_CHAIN_ID} is required.`,
      503
    );
  }

  const hash = params.transactionHash as Hash;
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/receipt.*not found|transaction.*not found/i.test(detail)) {
      throw new ArcTransactionVerificationError(
        `No confirmed Arc receipt was found for ${params.transactionHash}; it may be pending, missing, or on another network.`,
        422
      );
    }
    throw new ArcTransactionVerificationError(
      `Unable to retrieve a confirmed receipt for ${params.transactionHash}: ${detail}`,
      502
    );
  }
  if (receipt.status !== "success") {
    throw new ArcTransactionVerificationError(`Arc transaction ${params.transactionHash} did not succeed.`, 422);
  }

  let block;
  try {
    block = await client.getBlock({ blockNumber: receipt.blockNumber });
  } catch (error) {
    throw new ArcTransactionVerificationError(
      `The transaction succeeded, but its Arc block timestamp could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      502
    );
  }
  const blockTimeSeconds = Number(block.timestamp);
  if (!Number.isSafeInteger(blockTimeSeconds) || blockTimeSeconds > Number.MAX_SAFE_INTEGER / 1_000) {
    throw new ArcTransactionVerificationError("Arc returned an invalid block timestamp.", 502);
  }

  const usdcAddress = config.usdcContractAddress.toLowerCase();
  const usdcTransfers = receipt.logs.flatMap((log) => {
    if (
      log.address.toLowerCase() !== usdcAddress ||
      log.topics[0]?.toLowerCase() !== usdcTransferTopic.toLowerCase()
    ) {
      return [];
    }
    const decoded = decodeEventLog({
      abi: usdcTransferAbi,
      eventName: "Transfer",
      data: log.data,
      topics: log.topics,
    });
    return [{
      from: decoded.args.from,
      to: decoded.args.to,
      value: decoded.args.value,
      logIndex: log.logIndex,
    }];
  });

  if (usdcTransfers.length === 0) {
    throw new ArcTransactionVerificationError(
      `Arc transaction ${params.transactionHash} contains no USDC Transfer event.`,
      422
    );
  }
  if (usdcTransfers.length > 1) {
    throw new ArcTransactionVerificationError(
      `Arc transaction ${params.transactionHash} contains multiple USDC transfers and cannot be recorded as one unambiguous traction item.`,
      422
    );
  }

  const transfer = usdcTransfers[0]!;
  if (transfer.value !== amountUnits) {
    throw new ArcTransactionVerificationError(
      `Arc transaction ${params.transactionHash} transferred ${formatUnits(transfer.value, 6)} USDC, not the entered amount ${params.amountUSDC}.`,
      422
    );
  }
  return {
    transactionHash: hash,
    amountUSDC: formatUnits(amountUnits, 6),
    timestamp: new Date(blockTimeSeconds * 1_000).toISOString(),
    chainId,
    blockNumber: receipt.blockNumber,
    logIndex: transfer.logIndex,
    from: transfer.from,
    to: transfer.to,
  };
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

// ── USDC Transfer ─────────────────────────────

export async function transferUSDC(params: {
  fromWalletId: string;
  toAddress: string;
  amount: string;
  category: TxCategory;
  memo?: string;
}): Promise<CircleTransferResult> {
  const { config, client } = ensureClient();
  if (!config.usdcTokenId) throw new Error("CIRCLE_USDC_TOKEN_ID is required to send USDC.");
  if (!params.fromWalletId?.trim()) {
    throw new Error("An operations Circle wallet ID is required to send USDC. Configure OPERATIONS_WALLET_ID.");
  }
  const wallet = await client.getWallet({ id: params.fromWalletId });
  if (!wallet.data?.wallet) {
    throw new Error(`Circle did not return configured operations wallet ${params.fromWalletId}. Check OPERATIONS_WALLET_ID.`);
  }
  if (wallet.data.wallet.blockchain !== Blockchain.ArcTestnet) {
    throw new Error(
      `Operations wallet ${params.fromWalletId} is on ${wallet.data.wallet.blockchain}, not ARC-TESTNET.`
    );
  }
  const response = await client.createTransaction({
    walletId: params.fromWalletId,
    tokenId: config.usdcTokenId,
    amount: [params.amount],
    destinationAddress: params.toAddress,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const submitted = response.data;
  if (!submitted?.id) throw new Error("Circle accepted no transfer: it did not return a transaction ID.");

  let transaction;
  let statusError: string | undefined;
  const signal = AbortSignal.timeout(TRANSFER_CONFIRMATION_TIMEOUT_MS);
  try {
    const completed = await client.getTransaction({
      id: submitted.id,
      waitForState: "COMPLETE",
      pollingInterval: 1_000,
      signal,
    });
    transaction = completed.data?.transaction;
  } catch (error) {
    statusError = error instanceof Error ? error.message : String(error);
    try {
      const latest = await client.getTransaction({ id: submitted.id });
      transaction = latest.data?.transaction;
    } catch (lookupError) {
      throw new Error(
        `Transfer ${submitted.id} was submitted, but Circle could not confirm its status. ` +
          `Polling error: ${statusError}. Status lookup error: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`
      );
    }

    if (
      transaction &&
      mapTransactionStatus(transaction.state) === "pending" &&
      !signal.aborted
    ) {
      throw new Error(
        `Transfer ${submitted.id} was submitted, but Circle status polling failed: ${statusError}.`
      );
    }
  }

  if (!transaction) {
    throw new Error(`Circle returned no transaction details for submitted transfer ${submitted.id}.`);
  }
  if (mapTransactionStatus(transaction.state) === "confirmed" && !transaction.txHash) {
    try {
      const withHash = await client.getTransaction({
        id: submitted.id,
        waitForTxHash: true,
        pollingInterval: 1_000,
        signal: AbortSignal.timeout(10_000),
      });
      transaction = withHash.data?.transaction;
    } catch (error) {
      throw new Error(
        `Transfer ${submitted.id} reached ${transaction.state}, but Circle did not provide its transaction hash: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (!transaction) {
    throw new Error(`Circle returned no transaction details for submitted transfer ${submitted.id}.`);
  }

  const finalStatus = transaction.state || "UNKNOWN";
  const status = mapTransactionStatus(finalStatus);
  if (status === "confirmed" && !transaction.txHash) {
    throw new Error(
      `Transfer ${submitted.id} reached ${finalStatus}, but Circle returned no transaction hash. Check this transaction in Circle before retrying.`
    );
  }
  const error = getCircleTransactionError(transaction) ??
    (status === "failed" ? statusError : undefined) ??
    (status === "pending" && signal.aborted
      ? `Circle did not reach a final state within ${TRANSFER_CONFIRMATION_TIMEOUT_MS / 1000} seconds.`
      : undefined);
  const txHash = transaction.txHash;

  return {
    id: submitted.id,
    walletId: params.fromWalletId,
    direction: "outbound" as TxDirection,
    status,
    success: status === "confirmed",
    finalStatus,
    category: params.category,
    amountUSDC: params.amount,
    counterparty: params.toAddress,
    txHash,
    explorerUrl: getExplorerTransactionUrl(txHash),
    error,
    memo: params.memo,
    createdAt: transaction.createDate ?? new Date().toISOString(),
    confirmedAt: status === "confirmed"
      ? transaction.firstConfirmDate ?? transaction.updateDate
      : undefined,
  };
}

// EXPERIMENTAL / NOT FULLY VERIFIED ON TESTNET:
// These ERC-4626-shaped calls require an independently verified vault/ABI and
// successful end-to-end Arc testing before they can be represented as supported.
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

// COMING SOON — ADAPTER ONLY:
// This adapter is not exposed to the agent and must not be treated as a working
// borrow flow until a deployed pool is independently verified and tested.
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

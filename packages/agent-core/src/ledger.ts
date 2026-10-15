// ────────────────────────────────────────────────
// @agentvault/agent-core – Persistent Audit Ledger
// ────────────────────────────────────────────────

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { v4 as uuid } from "uuid";
import type { DecisionAction, DecisionRecord } from "@agentvault/shared";

export interface LedgerEntry extends DecisionRecord {
  recordType: "decision" | "execution" | "verified_transaction";
  sequenceNumber: number;
  previousHash: string;
  hash: string;
  signingKeyId: string;
  signingPublicKey: string;
  transactionHash?: string;
  transactionId?: string;
  relatedDecisionId?: string;
  verifiedRealUsage?: boolean;
  verificationChainId?: number;
  verificationBlockNumber?: string;
  verificationLogIndex?: number;
  verifiedAt?: string;
  transferFrom?: string;
  transferTo?: string;
}

export interface LedgerQuery {
  action?: DecisionAction;
  search?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface LedgerQueryResult {
  entries: LedgerEntry[];
  total: number;
  limit: number;
  offset: number;
}

interface SigningKeys {
  privateKey: KeyObject;
  publicKey: string;
  keyId: string;
}

const GENESIS_HASH = "genesis";
let ledger: LedgerEntry[] = [];
let signingKeys: SigningKeys | null = null;
let initialized = false;

function dataPath(configuredPath: string | undefined, fallbackPath: string): string {
  const path = configuredPath ?? fallbackPath;
  if (
    process.env.VERCEL === "1" &&
    configuredPath !== undefined &&
    !isAbsolute(configuredPath)
  ) {
    return resolve(tmpdir(), "agentvault", configuredPath);
  }
  return resolve(path);
}

function ledgerPath(): string {
  const defaultPath = process.env.VERCEL === "1"
    ? resolve(tmpdir(), "agentvault", "decision-ledger.jsonl")
    : "data/decision-ledger.jsonl";
  return dataPath(process.env.AGENTVAULT_LEDGER_PATH, defaultPath);
}

function signingKeyPath(): string {
  return dataPath(
    process.env.AGENTVAULT_SIGNING_KEY_PATH,
    `${dirname(ledgerPath())}/audit-signing-key.pem`,
  );
}

function cloneEntry(entry: LedgerEntry): LedgerEntry {
  return structuredClone(entry);
}

function ensureSigningKeys(): SigningKeys {
  if (signingKeys) return signingKeys;

  const path = signingKeyPath();
  mkdirSync(dirname(path), { recursive: true });

  let privateKeyPem: string;
  if (existsSync(path)) {
    privateKeyPem = readFileSync(path, "utf8");
  } else {
    const pair = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    try {
      writeFileSync(path, pair.privateKey, { encoding: "utf8", flag: "wx", mode: 0o600 });
      privateKeyPem = pair.privateKey;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      privateKeyPem = readFileSync(path, "utf8");
    }
  }

  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const keyId = createHash("sha256").update(publicKey).digest("hex");
  signingKeys = { privateKey, publicKey, keyId };
  return signingKeys;
}

function hashPayload(entry: Omit<LedgerEntry, "hash" | "agentSignature">): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

function signEntry(entry: Omit<LedgerEntry, "hash" | "agentSignature">): LedgerEntry {
  const keys = ensureSigningKeys();
  const hash = hashPayload(entry);
  const agentSignature = sign(null, Buffer.from(hash, "hex"), keys.privateKey).toString("base64");
  return { ...entry, hash, agentSignature };
}

function readPersistedEntries(): LedgerEntry[] {
  const path = ledgerPath();
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf8");
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.some((line) => line.trim().length === 0)) {
    throw new Error(`Audit ledger contains an empty record line: ${path}`);
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as LedgerEntry;
    } catch (error) {
      throw new Error(`Unable to parse audit ledger record ${index}: ${String(error)}`);
    }
  });
}

function verifyEntries(entries: readonly LedgerEntry[]): {
  valid: boolean;
  brokenAt?: number;
  entries: number;
} {
  let previousHash = GENESIS_HASH;
  let expectedKeyId: string | undefined;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const {
      hash,
      agentSignature,
      signingPublicKey,
      signingKeyId,
      ...payload
    } = entry;
    const calculatedHash = hashPayload({
      ...payload,
      signingKeyId,
      signingPublicKey,
    } as Omit<LedgerEntry, "hash" | "agentSignature">);

    if (
      entry.sequenceNumber !== index ||
      entry.previousHash !== previousHash ||
      hash !== calculatedHash ||
      createHash("sha256").update(signingPublicKey).digest("hex") !== signingKeyId ||
      (expectedKeyId !== undefined && signingKeyId !== expectedKeyId)
    ) {
      return { valid: false, brokenAt: entry.sequenceNumber, entries: entries.length };
    }

    try {
      const validSignature = verify(
        null,
        Buffer.from(hash, "hex"),
        signingPublicKey,
        Buffer.from(agentSignature, "base64")
      );
      if (!validSignature) {
        return { valid: false, brokenAt: entry.sequenceNumber, entries: entries.length };
      }
    } catch {
      return { valid: false, brokenAt: entry.sequenceNumber, entries: entries.length };
    }

    expectedKeyId = signingKeyId;
    previousHash = hash;
  }

  return { valid: true, entries: entries.length };
}

function initialize(): void {
  if (initialized) return;
  ensureSigningKeys();

  ledger = readPersistedEntries();
  const result = verifyEntries(ledger);
  if (!result.valid) {
    throw new Error(`Audit ledger verification failed at sequence ${result.brokenAt}. Refusing to append.`);
  }
  const activeKeyId = ensureSigningKeys().keyId;
  if (ledger.some((entry) => entry.signingKeyId !== activeKeyId)) {
    throw new Error("Configured audit signing key does not match the persisted ledger. Refusing to append.");
  }
  initialized = true;
}

function persist(entry: LedgerEntry): void {
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    appendFileSync(fd, `${JSON.stringify(entry)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function initLedger(): void {
  initialize();
}

export function appendDecision(
  params: Omit<DecisionRecord, "id" | "timestamp" | "agentSignature" | "actionTaken"> & {
    actionTaken?: string;
    transactionHash?: string;
    transactionId?: string;
  }
): LedgerEntry {
  initialize();
  const keys = ensureSigningKeys();
  const previousHash = ledger.at(-1)?.hash ?? GENESIS_HASH;
  const entry = signEntry({
    ...params,
    id: uuid(),
    timestamp: new Date().toISOString(),
    actionTaken: params.actionTaken ?? "Authorized; awaiting execution or approval.",
    recordType: "decision",
    sequenceNumber: ledger.length,
    previousHash,
    signingKeyId: keys.keyId,
    signingPublicKey: keys.publicKey,
  });

  persist(entry);
  ledger.push(entry);
  console.log(`[LEDGER] #${entry.sequenceNumber} ${entry.action} $${entry.amountUSDC} USDC`);
  return cloneEntry(entry);
}

export function appendDecisionOutcome(
  decisionId: string,
  outcome: {
    actionTaken: string;
    transactionHash?: string;
    transactionId?: string;
  }
): LedgerEntry {
  initialize();
  const decision = ledger.find(
    (entry) => entry.id === decisionId && entry.recordType === "decision"
  );
  if (!decision) throw new Error(`Cannot record outcome: decision ${decisionId} was not found.`);

  const previousOutcome = ledger.find(
    (entry) => entry.relatedDecisionId === decisionId && entry.recordType === "execution"
  );
  if (previousOutcome) {
    throw new Error(`Decision ${decisionId} already has an immutable execution outcome.`);
  }

  const keys = ensureSigningKeys();
  const {
    hash: _hash,
    agentSignature: _agentSignature,
    sequenceNumber: _sequenceNumber,
    previousHash: _previousHash,
    signingKeyId: _signingKeyId,
    signingPublicKey: _signingPublicKey,
    recordType: _recordType,
    ...decisionData
  } = decision;
  const entry = signEntry({
    ...decisionData,
    ...outcome,
    id: uuid(),
    timestamp: new Date().toISOString(),
    recordType: "execution",
    relatedDecisionId: decisionId,
    sequenceNumber: ledger.length,
    previousHash: ledger.at(-1)?.hash ?? GENESIS_HASH,
    signingKeyId: keys.keyId,
    signingPublicKey: keys.publicKey,
  });

  persist(entry);
  ledger.push(entry);
  return cloneEntry(entry);
}

export function appendVerifiedTransaction(params: {
  action: "send" | "receive";
  amountUSDC: string;
  transactionHash: string;
  timestamp: string;
  chainId: number;
  blockNumber: bigint;
  logIndex: number;
  from: string;
  to: string;
}): LedgerEntry {
  initialize();
  const existing = ledger.find(
    (entry) =>
      entry.recordType === "verified_transaction" &&
      entry.transactionHash?.toLowerCase() === params.transactionHash.toLowerCase()
  );
  if (existing) {
    throw new Error(
      `Arc transaction ${params.transactionHash} log ${params.logIndex} is already recorded as verified real usage.`
    );
  }

  const keys = ensureSigningKeys();
  const entry = signEntry({
    id: uuid(),
    timestamp: params.timestamp,
    actionTaken: "Manually recorded after Arc testnet USDC Transfer event verification.",
    balanceSeen: { treasury: "not captured", operations: "not captured", reserves: "not captured" },
    balanceSeenUSYC: { treasury: "not captured", operations: "not captured", reserves: "not captured" },
    forecast: "Not captured for this externally initiated transaction.",
    reasoning: `A successful Arc testnet receipt contains a matching USDC transfer of $${params.amountUSDC} from ${params.from} to ${params.to}. Transaction type was classified as ${params.action} during manual verification.`,
    ruleApplied: "verified_arc_testnet_transaction",
    confidence: 1,
    action: params.action,
    amountUSDC: params.amountUSDC,
    transactionHash: params.transactionHash,
    toAddress: params.to,
    withinDailyLimit: false,
    requiresApproval: false,
    recordType: "verified_transaction",
    sequenceNumber: ledger.length,
    previousHash: ledger.at(-1)?.hash ?? GENESIS_HASH,
    verifiedRealUsage: true,
    verificationChainId: params.chainId,
    verificationBlockNumber: params.blockNumber.toString(),
    verificationLogIndex: params.logIndex,
    verifiedAt: new Date().toISOString(),
    transferFrom: params.from,
    transferTo: params.to,
    signingKeyId: keys.keyId,
    signingPublicKey: keys.publicKey,
  });

  persist(entry);
  ledger.push(entry);
  console.log(`[LEDGER] #${entry.sequenceNumber} verified Arc transaction ${entry.transactionHash}`);
  return cloneEntry(entry);
}

export function getLedger(): ReadonlyArray<LedgerEntry> {
  initialize();
  return ledger.map(cloneEntry);
}

export function queryLedger(query: LedgerQuery = {}): LedgerQueryResult {
  initialize();
  const normalizedSearch = query.search?.trim().toLocaleLowerCase();
  const filtered = ledger.filter((entry) => {
    if (query.action && entry.action !== query.action) return false;
    if (query.since && entry.timestamp < query.since) return false;
    if (query.until && entry.timestamp > query.until) return false;
    if (
      normalizedSearch &&
      ![
        entry.reasoning,
        entry.forecast,
        entry.ruleApplied,
        entry.actionTaken,
        entry.transactionHash ?? "",
        entry.transactionId ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(normalizedSearch))
    ) {
      return false;
    }
    return true;
  });
  const limit = Math.min(500, Math.max(1, Math.trunc(query.limit ?? 100)));
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  const pageStart = Math.max(0, filtered.length - offset - limit);
  const pageEnd = filtered.length - offset;
  return {
    entries: filtered.slice(pageStart, pageEnd).reverse().map(cloneEntry),
    total: filtered.length,
    limit,
    offset,
  };
}

export function getDecisionById(id: string): LedgerEntry | undefined {
  initialize();
  const entry = ledger.find((candidate) => candidate.id === id);
  return entry ? cloneEntry(entry) : undefined;
}

export function getRecentDecisions(count: number = 10): LedgerEntry[] {
  initialize();
  return ledger
    .filter((entry) => entry.recordType === "decision")
    .slice(-count)
    .reverse()
    .map(cloneEntry);
}

export function verifyChain(): { valid: boolean; brokenAt?: number; entries: number } {
  initialize();
  const persisted = readPersistedEntries();
  const persistedResult = verifyEntries(persisted);
  if (!persistedResult.valid) return persistedResult;
  const mismatchIndex = persisted.findIndex(
    (entry, index) => entry.hash !== ledger[index]?.hash
  );
  if (mismatchIndex >= 0 || persisted.length !== ledger.length) {
    return {
      valid: false,
      brokenAt: mismatchIndex >= 0 ? mismatchIndex : Math.min(persisted.length, ledger.length),
      entries: persisted.length,
    };
  }
  return persistedResult;
}

import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { AgentConfig } from "@agentvault/shared";

const WORKSPACE_WALLETS = ["treasury", "operations", "reserves"] as const;
type WorkspaceWallet = (typeof WORKSPACE_WALLETS)[number];

const OnboardingRulesSchema = z.object({
  payrollDay: z.number().int().min(1).max(31),
  reservePercent: z.number().min(0).max(90),
  maxBorrowAmount: z.number().min(0).max(1_000_000),
});

const InviteRequestSchema = z.object({
  email: z.string().trim().email().max(254),
});

const AcceptInviteSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
});

const activityEventSchema = z.enum([
  "dashboard_view",
  "chat_opened",
  "ledger_viewed",
  "approval_reviewed",
]);
export type OnboardingActivityEvent = z.infer<typeof activityEventSchema>;

interface StoredInvite {
  tokenHash: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  acceptedBy?: string;
}

const StoredInviteSchema: z.ZodType<StoredInvite> = z.object({
  tokenHash: z.string(),
  email: z.string().email(),
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().optional(),
  acceptedBy: z.string().optional(),
});

interface StoredUser {
  id: string;
  name: string;
  email: string;
  joinedAt: string;
  lastActiveAt: string;
  activityTokenHash: string;
  activityCounts: Partial<Record<OnboardingActivityEvent, number>>;
}

interface StoredOnboarding {
  rules: z.infer<typeof OnboardingRulesSchema>;
  wallets: Partial<Record<WorkspaceWallet, string>>;
  invites: StoredInvite[];
  users: StoredUser[];
}

export interface OnboardingStatus {
  complete: boolean;
  rules: StoredOnboarding["rules"];
  wallets: Partial<Record<WorkspaceWallet, { id: string; address?: string }>>;
  invites: Array<Pick<StoredInvite, "email" | "createdAt" | "expiresAt" | "acceptedAt">>;
  users: Array<{
    id: string;
    name: string;
    email: string;
    joinedAt: string;
    lastActiveAt: string;
    activityCounts: StoredUser["activityCounts"];
  }>;
}

let store: StoredOnboarding | undefined;

function storePath() {
  return resolve(process.env.AGENTVAULT_ONBOARDING_PATH ?? "data/onboarding.json");
}

function defaultStore(): StoredOnboarding {
  return {
    rules: {
      payrollDay: 1,
      reservePercent: 15,
      maxBorrowAmount: Number(process.env.AGENT_MAX_BORROW_AMOUNT || "2000"),
    },
    wallets: {
      treasury: process.env.TREASURY_WALLET_ID || undefined,
      operations: process.env.OPERATIONS_WALLET_ID || undefined,
      reserves: process.env.RESERVES_WALLET_ID || undefined,
    },
    invites: [],
    users: [],
  };
}

function getStore(): StoredOnboarding {
  if (store) return store;
  const path = storePath();
  if (!existsSync(path)) {
    store = defaultStore();
    return store;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const schema = z.object({
    rules: OnboardingRulesSchema,
    wallets: z.record(z.string()).default({}),
    invites: z.array(StoredInviteSchema).default([]),
    users: z.array(z.object({
      id: z.string(),
      name: z.string(),
      email: z.string().email(),
      joinedAt: z.string(),
      lastActiveAt: z.string(),
      activityTokenHash: z.string(),
      activityCounts: z.record(z.number()).default({}),
    })).default([]),
  });
  const data = schema.parse(parsed);
  const envWallets: Partial<Record<WorkspaceWallet, string>> = {
    treasury: process.env.TREASURY_WALLET_ID || undefined,
    operations: process.env.OPERATIONS_WALLET_ID || undefined,
    reserves: process.env.RESERVES_WALLET_ID || undefined,
  };
  store = {
    rules: data.rules,
    wallets: { ...envWallets, ...data.wallets } as Partial<Record<WorkspaceWallet, string>>,
    invites: data.invites,
    users: data.users as StoredUser[],
  };
  return store;
}

function persist(): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(getStore(), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function getOnboardingSettings() {
  const current = getStore();
  return {
    rules: { ...current.rules },
    wallets: { ...current.wallets },
  };
}

export function getOnboardingStatus(): OnboardingStatus {
  const current = getStore();
  const wallets: OnboardingStatus["wallets"] = {};
  for (const purpose of WORKSPACE_WALLETS) {
    const id = current.wallets[purpose];
    if (id) wallets[purpose] = { id };
  }
  return {
    complete: WORKSPACE_WALLETS.every((purpose) => Boolean(current.wallets[purpose])),
    rules: { ...current.rules },
    wallets,
    invites: current.invites.map(({ email, createdAt, expiresAt, acceptedAt }) => ({
      email,
      createdAt,
      expiresAt,
      acceptedAt,
    })),
    users: current.users.map(({ id, name, email, joinedAt, lastActiveAt, activityCounts }) => ({
      id,
      name,
      email,
      joinedAt,
      lastActiveAt,
      activityCounts: { ...activityCounts },
    })),
  };
}

export function applyOnboardingConfiguration(base: AgentConfig): AgentConfig {
  const current = getStore();
  return {
    ...base,
    guardrails: {
      ...base.guardrails,
      ...current.rules,
    },
    wallets: {
      ...base.wallets,
      ...current.wallets,
    },
  };
}

export async function connectCircleWallet(
  purpose: WorkspaceWallet,
  walletId: string
): Promise<{ id: string; address: string }> {
  const { getWalletBalance } = await import("@agentvault/agent-core");
  const wallet = await getWalletBalance(walletId, purpose);
  const current = getStore();
  if (WORKSPACE_WALLETS.some((role) => role !== purpose && current.wallets[role] === wallet.id)) {
    throw new Error("Each treasury role must use a different Circle wallet.");
  }
  current.wallets[purpose] = wallet.id;
  persist();
  return { id: wallet.id, address: wallet.address };
}

export async function createCircleWallet(purpose: WorkspaceWallet) {
  const { createWallet } = await import("@agentvault/agent-core");
  const wallet = await createWallet(purpose);
  const current = getStore();
  if (WORKSPACE_WALLETS.some((role) => role !== purpose && current.wallets[role] === wallet.id)) {
    throw new Error("Circle returned a wallet already assigned to another treasury role.");
  }
  current.wallets[purpose] = wallet.id;
  persist();
  return { id: wallet.id, address: wallet.address };
}

export function saveOnboardingRules(raw: unknown) {
  const rules = OnboardingRulesSchema.parse(raw);
  const current = getStore();
  current.rules = rules;
  persist();
  return { ...rules };
}

export function getInvitePreview(token: string) {
  const digest = tokenDigest(token);
  const invite = getStore().invites.find((candidate) =>
    safeDigestEqual(candidate.tokenHash, digest)
  );
  if (!invite || invite.acceptedAt || Date.parse(invite.expiresAt) <= Date.now()) {
    throw new Error("Invite is invalid, expired, or already used.");
  }
  return { email: invite.email, expiresAt: invite.expiresAt };
}

export function createUserInvite(raw: unknown) {
  const { email } = InviteRequestSchema.parse(raw);
  const current = getStore();
  const normalizedEmail = email.toLowerCase();
  if (current.users.some((user) => user.email.toLowerCase() === normalizedEmail)) {
    throw new Error("This email is already registered.");
  }
  const now = new Date();
  if (
    current.invites.some(
      (invite) =>
        invite.email.toLowerCase() === normalizedEmail &&
        !invite.acceptedAt &&
        Date.parse(invite.expiresAt) > now.getTime()
    )
  ) {
    throw new Error("There is already an active invite for this email.");
  }
  const token = randomBytes(32).toString("base64url");
  const invite: StoredInvite = {
    tokenHash: tokenDigest(token),
    email,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
  current.invites.push(invite);
  persist();
  return { email, token, expiresAt: invite.expiresAt };
}

export function acceptUserInvite(token: string, raw: unknown) {
  const { name, email } = AcceptInviteSchema.parse(raw);
  const current = getStore();
  const digest = tokenDigest(token);
  const invite = current.invites.find((candidate) => safeDigestEqual(candidate.tokenHash, digest));
  if (!invite || invite.acceptedAt || Date.parse(invite.expiresAt) <= Date.now()) {
    throw new Error("Invite is invalid, expired, or already used.");
  }
  if (invite.email.toLowerCase() !== email.toLowerCase()) {
    throw new Error("Use the email address this invite was issued to.");
  }
  if (current.users.some((user) => user.email.toLowerCase() === email.toLowerCase())) {
    throw new Error("This email is already registered.");
  }

  const now = new Date().toISOString();
  const activityToken = randomBytes(32).toString("base64url");
  const user: StoredUser = {
    id: randomBytes(16).toString("hex"),
    name,
    email,
    joinedAt: now,
    lastActiveAt: now,
    activityTokenHash: tokenDigest(activityToken),
    activityCounts: {},
  };
  invite.acceptedAt = now;
  invite.acceptedBy = user.id;
  current.users.push(user);
  user.activityCounts.dashboard_view = 1;
  persist();
  return {
    user: { id: user.id, name: user.name, email: user.email },
    activityToken,
  };
}

export function recordUserActivity(token: string, rawEvent: unknown): void {
  const event = activityEventSchema.parse(rawEvent);
  const digest = tokenDigest(token);
  const user = getStore().users.find((candidate) =>
    safeDigestEqual(candidate.activityTokenHash, digest)
  );
  if (!user) throw new Error("Activity session is invalid.");
  user.lastActiveAt = new Date().toISOString();
  user.activityCounts[event] = (user.activityCounts[event] ?? 0) + 1;
  persist();
}

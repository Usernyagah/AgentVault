// ────────────────────────────────────────────────
// @agentvault/api – Hono Backend Server
// ────────────────────────────────────────────────

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { config } from "dotenv";
import { timingSafeEqual } from "node:crypto";

import type {
  ApiResponse,
  ChatMessage,
  DashboardSummary,
  DecisionAction,
} from "@agentvault/shared";
import {
  initAgent,
  initCircle,
  chat,
  evaluateAndAct,
  approveDecision,
  rejectDecision,
  getDashboardSummary,
  getChatHistory,
  getPendingApprovals,
  getLedger,
  appendVerifiedTransaction,
  queryLedger,
  getRecentDecisions,
  verifyChain,
  initLedger,
  verifyArcUsdcTransfer,
  ArcTransactionVerificationError,
  getRealTractionTransactions,
  buildTractionSummary,
  formatTractionMarkdown,
  getGuardrails,
  setGuardrails,
  getGuardrailsSummary,
  setAgentWallet,
  TOOL_DEFINITIONS,
  type ExtendedGuardrailConfig,
  createObligation,
  getObligations,
  updateObligationStatus,
  createInvoice,
  getInvoices,
  recordIncomingPayment,
  getIncomingPayments,
} from "@agentvault/agent-core";
import {
  getDemoApprovals,
  getDemoDashboard,
  isDemoEnabled,
  isDemoLocked,
  isVercelDeployment,
  queryDemoLedger,
  resolveDemoApproval,
  runDemoChat,
  runDemoEvaluation,
  setDemoEnabled,
  shouldInitializeLiveServices,
} from "./demo.js";
import {
  acceptUserInvite,
  applyOnboardingConfiguration,
  connectCircleWallet,
  createCircleWallet,
  createUserInvite,
  getInvitePreview,
  getOnboardingStatus,
  recordUserActivity,
  saveOnboardingRules,
} from "./onboarding.js";

// ── Load environment ────────────────────────────
// Skip dotenv in Vercel (env vars are automatically available)
if (!isVercelDeployment()) {
  config({ path: "../../.env" });
}

const app = new Hono<{ Variables: { demoMode: boolean } }>();

function onboardingAdminError(c: Context) {
  const configuredToken = process.env.ONBOARDING_ADMIN_TOKEN;
  if (
    !configuredToken ||
    configuredToken.length < 32 ||
    /^(your_|change_me|replace_with)/i.test(configuredToken)
  ) {
    return c.json<ApiResponse>(
      {
        success: false,
        error: "Set ONBOARDING_ADMIN_TOKEN to a random value of at least 32 characters before managing onboarding.",
        timestamp: new Date().toISOString(),
      },
      503
    );
  }
  const authorization = c.req.header("Authorization");
  const suppliedToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expected = Buffer.from(configuredToken);
  const supplied = Buffer.from(suppliedToken);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return c.json<ApiResponse>(
      { success: false, error: "Onboarding administrator access is required.", timestamp: new Date().toISOString() },
      401
    );
  }
  return undefined;
}

// ── Middleware ──────────────────────────────────
app.use("/*", cors({ exposeHeaders: ["X-AgentVault-Mode"] }));
app.use("/*", async (c, next) => {
  const demoModeAtRequest = isDemoEnabled();
  const modeAtRequest = demoModeAtRequest ? "demo" : "live";
  c.set("demoMode", demoModeAtRequest);
  const path = c.req.path;
  const method = c.req.method;
  const demoBlocked =
    modeAtRequest === "demo" &&
    (
      path === "/api/invoices" ||
      path === "/api/payments/incoming" ||
      path === "/api/obligations" ||
      path.startsWith("/api/obligations/") ||
      path === "/api/guardrails" ||
      (path === "/api/traction/verify" && method === "POST") ||
      (path === "/api/chat/history" && method === "GET") ||
      (path === "/api/onboarding/wallet" && method === "POST") ||
      (path === "/api/onboarding/rules" && method === "PUT")
    );

  if (demoBlocked) {
    c.header("X-AgentVault-Mode", "demo");
    return c.json<ApiResponse>(
      {
        success: false,
        error: "This live workspace endpoint is disabled in Demo Mode to prevent synthetic and live data from mixing.",
        timestamp: new Date().toISOString(),
      },
      409
    );
  }

  await next();
  const responseMode =
    path === "/api/demo" && method === "POST"
      ? isDemoEnabled() ? "demo" : "live"
      : modeAtRequest;
  c.header("X-AgentVault-Mode", responseMode);
});

// ── Health Check ───────────────────────────────
app.get("/", (c) =>
  c.json({
    name: "AgentVault Treasury API",
    version: "0.1.0",
    status: "running",
    timestamp: new Date().toISOString(),
  })
);

app.get("/health", (c) =>
  c.json({
    status: "ok",
    mode: c.get("demoMode") ? "demo" : "live",
    timestamp: new Date().toISOString(),
  })
);

// ── Dashboard ──────────────────────────────────
app.get("/api/dashboard", async (c) => {
  try {
    if (c.get("demoMode")) {
      return c.json<ApiResponse>({
        success: true,
        data: getDemoDashboard(),
        timestamp: new Date().toISOString(),
      });
    }
    const summary = await getDashboardSummary();
    return c.json<ApiResponse<DashboardSummary>>({
      success: true,
      data: { ...summary, modeLocked: false },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return c.json<ApiResponse>(
      { success: false, error: error.message, timestamp: new Date().toISOString() },
      500
    );
  }
});

app.get("/api/demo", (c) =>
  c.json<ApiResponse>({
    success: true,
    data: {
      enabled: c.get("demoMode"),
      mode: c.get("demoMode") ? "demo" : "live",
      locked: isDemoLocked(),
    },
    timestamp: new Date().toISOString(),
  })
);

app.post("/api/demo", async (c) => {
  try {
    const body = await c.req.json<{ enabled?: unknown }>();
    if (typeof body.enabled !== "boolean") {
      return c.json<ApiResponse>(
        { success: false, error: "enabled must be a boolean.", timestamp: new Date().toISOString() },
        400
      );
    }
    if (isDemoLocked() && !body.enabled) {
      return c.json<ApiResponse>(
        {
          success: false,
          error: "Demo Mode is locked on this Vercel deployment so the public demo can run without Circle credentials. Set AGENTVAULT_DEMO_MODE=0 to use live data.",
          timestamp: new Date().toISOString(),
        },
        409
      );
    }
    setDemoEnabled(body.enabled);
    return c.json<ApiResponse>({
      success: true,
      data: {
        enabled: isDemoEnabled(),
        mode: isDemoEnabled() ? "demo" : "live",
        locked: isDemoLocked(),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json<ApiResponse>(
      { success: false, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() },
      400
    );
  }
});

// ── Business onboarding ────────────────────────
app.get("/api/onboarding", (c) => {
  const authError = onboardingAdminError(c);
  if (authError) return authError;
  return c.json<ApiResponse>({
    success: true,
    data: getOnboardingStatus(),
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/onboarding/wallet", async (c) => {
  const authError = onboardingAdminError(c);
  if (authError) return authError;
  try {
    const body = await c.req.json<{
      purpose?: string;
      mode?: string;
      walletId?: string;
    }>();
    if (!["treasury", "operations", "reserves"].includes(body.purpose ?? "")) {
      return c.json<ApiResponse>(
        { success: false, error: "purpose must be treasury, operations, or reserves.", timestamp: new Date().toISOString() },
        400
      );
    }
    if (body.mode !== "connect" && body.mode !== "create") {
      return c.json<ApiResponse>(
        { success: false, error: "mode must be connect or create.", timestamp: new Date().toISOString() },
        400
      );
    }
    if (body.mode === "connect" && (!body.walletId || body.walletId.trim().length < 3)) {
      return c.json<ApiResponse>(
        { success: false, error: "A Circle wallet ID is required to connect a wallet.", timestamp: new Date().toISOString() },
        400
      );
    }
    const purpose = body.purpose as "treasury" | "operations" | "reserves";
    const wallet = body.mode === "create"
      ? await createCircleWallet(purpose)
      : await connectCircleWallet(purpose, body.walletId!.trim());
    setAgentWallet(purpose, wallet.id);
    return c.json<ApiResponse>({
      success: true,
      data: { purpose, ...wallet },
      timestamp: new Date().toISOString(),
    }, body.mode === "create" ? 201 : 200);
  } catch (error) {
    return c.json<ApiResponse>(
      { success: false, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() },
      400
    );
  }
});

app.put("/api/onboarding/rules", async (c) => {
  const authError = onboardingAdminError(c);
  if (authError) return authError;
  try {
    const rules = saveOnboardingRules(await c.req.json());
    setGuardrails(rules);
    return c.json<ApiResponse>({
      success: true,
      data: { rules },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json<ApiResponse>(
      { success: false, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() },
      400
    );
  }
});

app.post("/api/onboarding/invites", async (c) => {
  const authError = onboardingAdminError(c);
  if (authError) return authError;
  try {
    const invite = createUserInvite(await c.req.json());
    return c.json<ApiResponse>({
      success: true,
      data: invite,
      timestamp: new Date().toISOString(),
    }, 201);
  } catch (error) {
    return c.json<ApiResponse>(
      { success: false, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() },
      400
    );
  }
});

app.get("/api/onboarding/invites/:token", (c) => {
  try {
    return c.json<ApiResponse>({
      success: true,
      data: getInvitePreview(c.req.param("token")),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json<ApiResponse>(
      { success: false, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() },
      404
    );
  }
});

app.post("/api/onboarding/invites/:token/accept", async (c) => {
  try {
    return c.json<ApiResponse>({
      success: true,
      data: acceptUserInvite(c.req.param("token"), await c.req.json()),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json<ApiResponse>(
      { success: false, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() },
      400
    );
  }
});

app.post("/api/onboarding/activity", async (c) => {
  try {
    const authorization = c.req.header("Authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return c.json<ApiResponse>(
        { success: false, error: "A valid activity session is required.", timestamp: new Date().toISOString() },
        401
      );
    }
    const body = await c.req.json<{ event?: unknown }>();
    recordUserActivity(authorization.slice("Bearer ".length), body.event);
    return c.json<ApiResponse>({
      success: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json<ApiResponse>(
      { success: false, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() },
      401
    );
  }
});

// ── Chat with Agent ────────────────────────────
app.post("/api/chat", async (c) => {
  try {
    const { message } = await c.req.json<{ message: string }>();
    if (c.get("demoMode")) {
      if (!message) {
        return c.json<ApiResponse>(
          { success: false, error: "Message is required", timestamp: new Date().toISOString() },
          400
        );
      }
      return c.json<ApiResponse<ChatMessage>>({
        success: true,
        data: runDemoChat(message),
        timestamp: new Date().toISOString(),
      });
    }
    if (!message) {
      return c.json<ApiResponse>(
        { success: false, error: "Message is required", timestamp: new Date().toISOString() },
        400
      );
    }

    const response = await chat(message);
    return c.json<ApiResponse<ChatMessage>>({
      success: true,
      data: response,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return c.json<ApiResponse>(
      { success: false, error: error.message, timestamp: new Date().toISOString() },
      500
    );
  }
});

app.get("/api/chat/history", (c) => {
  return c.json<ApiResponse<ChatMessage[]>>({
    success: true,
    data: getChatHistory(),
    timestamp: new Date().toISOString(),
  });
});

// ── Agent Actions ──────────────────────────────
app.post("/api/agent/evaluate", async (c) => {
  try {
    if (c.get("demoMode")) {
      return c.json<ApiResponse>({
        success: true,
        data: runDemoEvaluation(),
        timestamp: new Date().toISOString(),
      });
    }
    const decision = await evaluateAndAct();
    return c.json<ApiResponse>({
      success: true,
      data: decision,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return c.json<ApiResponse>(
      { success: false, error: error.message, timestamp: new Date().toISOString() },
      500
    );
  }
});

app.get("/api/obligations", (c) =>
  c.json<ApiResponse>({
    success: true,
    data: getObligations(),
    timestamp: new Date().toISOString(),
  })
);

app.get("/api/invoices", (c) =>
  c.json<ApiResponse>({
    success: true,
    data: getInvoices(),
    timestamp: new Date().toISOString(),
  })
);

app.post("/api/invoices", async (c) => {
  try {
    const invoice = createInvoice(await c.req.json());
    return c.json<ApiResponse>({
      success: true,
      data: invoice,
      timestamp: new Date().toISOString(),
    }, 201);
  } catch (error) {
    return c.json<ApiResponse>({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }, 400);
  }
});

app.get("/api/payments/incoming", (c) =>
  c.json<ApiResponse>({
    success: true,
    data: getIncomingPayments(),
    timestamp: new Date().toISOString(),
  })
);

app.post("/api/payments/incoming", async (c) => {
  try {
    const payment = recordIncomingPayment(await c.req.json());
    return c.json<ApiResponse>({
      success: true,
      data: payment,
      timestamp: new Date().toISOString(),
    }, 201);
  } catch (error) {
    return c.json<ApiResponse>({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }, 400);
  }
});

app.post("/api/obligations", async (c) => {
  try {
    const obligation = createObligation(await c.req.json());
    return c.json<ApiResponse>({
      success: true,
      data: obligation,
      timestamp: new Date().toISOString(),
    }, 201);
  } catch (error) {
    return c.json<ApiResponse>({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }, 400);
  }
});

app.put("/api/obligations/:id/status", async (c) => {
  const { status } = await c.req.json<{ status: string }>();
  if (status !== "paid" && status !== "cancelled") {
    return c.json<ApiResponse>({
      success: false,
      error: "Status must be 'paid' or 'cancelled'.",
      timestamp: new Date().toISOString(),
    }, 400);
  }
  const obligation = updateObligationStatus(c.req.param("id"), status);
  if (!obligation) {
    return c.json<ApiResponse>({
      success: false,
      error: "Open obligation not found.",
      timestamp: new Date().toISOString(),
    }, 404);
  }
  return c.json<ApiResponse>({
    success: true,
    data: obligation,
    timestamp: new Date().toISOString(),
  });
});

// ── Approvals ──────────────────────────────────
app.get("/api/approvals", (c) => {
  return c.json<ApiResponse>({
    success: true,
    data: c.get("demoMode") ? getDemoApprovals() : getPendingApprovals(),
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/approvals/:id/approve", async (c) => {
  const id = c.req.param("id");
  if (c.get("demoMode")) {
    const success = resolveDemoApproval(id, true);
    return c.json<ApiResponse>(
      { success, error: success ? undefined : "Pending demo approval not found.", timestamp: new Date().toISOString() },
      success ? 200 : 404
    );
  }
  const result = await approveDecision(id);
  return c.json<ApiResponse>({
    success: result,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/approvals/:id/reject", (c) => {
  const id = c.req.param("id");
  if (c.get("demoMode")) {
    const success = resolveDemoApproval(id, false);
    return c.json<ApiResponse>(
      { success, error: success ? undefined : "Pending demo approval not found.", timestamp: new Date().toISOString() },
      success ? 200 : 404
    );
  }
  const result = rejectDecision(id);
  return c.json<ApiResponse>({
    success: result,
    timestamp: new Date().toISOString(),
  });
});

// ── Audit Ledger ───────────────────────────────
app.get("/api/ledger", (c) => {
  const action = c.req.query("action");
  const search = c.req.query("q");
  const since = c.req.query("since");
  const until = c.req.query("until");
  const limitParam = c.req.query("limit");
  const offsetParam = c.req.query("offset");
  const actions: DecisionAction[] = [
    "send",
    "receive",
    "invest_usyc",
    "redeem_usyc",
    "borrow",
    "repay",
    "bridge",
    "hold",
  ];
  const limit = limitParam === undefined ? 100 : Number(limitParam);
  const offset = offsetParam === undefined ? 0 : Number(offsetParam);
  const validDate = (value: string | undefined) =>
    value === undefined || !Number.isNaN(Date.parse(value));

  if (
    (action !== undefined && !actions.includes(action as DecisionAction)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    !validDate(since) ||
    !validDate(until)
  ) {
    return c.json<ApiResponse>(
      {
        success: false,
        error: "Invalid ledger query. Use a supported action, valid dates, limit 1–500, and a non-negative offset.",
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  const demoMode = c.get("demoMode");
  const query = {
    action: action as DecisionAction | undefined,
    search,
    since: since === undefined ? undefined : new Date(since).toISOString(),
    until: until === undefined ? undefined : new Date(until).toISOString(),
    limit,
    offset,
  };
  const data = demoMode
    ? { ...queryDemoLedger(query), demoMode: true }
    : { ...queryLedger(query), demoMode: false };
  return c.json<ApiResponse>({
    success: true,
    data,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/ledger/verify", (c) => {
  if (c.get("demoMode")) {
    return c.json<ApiResponse>({
      success: true,
      data: { valid: null, demoMode: true, entries: queryDemoLedger({ limit: 500, offset: 0 }).total },
      timestamp: new Date().toISOString(),
    });
  }
  const valid = verifyChain();
  return c.json<ApiResponse>({
    success: true,
    data: { valid, demoMode: false, entries: getLedger().length },
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/traction", (c) => {
  const transactions = c.get("demoMode")
    ? []
    : getRealTractionTransactions(getLedger());
  return c.json<ApiResponse>({
    success: true,
    data: {
      transactions,
      demoMode: c.get("demoMode"),
      withheldInDemoMode: c.get("demoMode"),
    },
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/traction/summary", (c) => {
  const format = c.req.query("format") ?? "json";
  if (format !== "json" && format !== "markdown") {
    return c.json<ApiResponse>(
      { success: false, error: "format must be json or markdown.", timestamp: new Date().toISOString() },
      400
    );
  }
  const transactions = c.get("demoMode")
    ? []
    : getRealTractionTransactions(getLedger());
  const summary = buildTractionSummary(transactions);
  if (format === "markdown") {
    return c.text(formatTractionMarkdown(summary), 200, { "Content-Type": "text/markdown; charset=utf-8" });
  }
  return c.json<ApiResponse>({
    success: true,
    data: { ...summary, demoMode: c.get("demoMode") },
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/traction/verify", async (c) => {
  const authError = onboardingAdminError(c);
  if (authError) return authError;
  try {
    const body = await c.req.json<{
      transactionHash?: unknown;
      amountUSDC?: unknown;
      action?: unknown;
    }>();
    if (typeof body.transactionHash !== "string" || typeof body.amountUSDC !== "string") {
      return c.json<ApiResponse>(
        { success: false, error: "transactionHash and amountUSDC are required strings.", timestamp: new Date().toISOString() },
        400
      );
    }
    if (body.action !== "send" && body.action !== "receive") {
      return c.json<ApiResponse>(
        { success: false, error: "action must be send or receive.", timestamp: new Date().toISOString() },
        400
      );
    }

    const verified = await verifyArcUsdcTransfer({
      transactionHash: body.transactionHash,
      amountUSDC: body.amountUSDC,
    });
    const entry = appendVerifiedTransaction({ ...verified, action: body.action });
    return c.json<ApiResponse>({
      success: true,
      data: { entry, explorerUrl: `https://explorer.testnet.arc.io/tx/${encodeURIComponent(verified.transactionHash)}` },
      timestamp: new Date().toISOString(),
    }, 201);
  } catch (error) {
    const alreadyRecorded = error instanceof Error && error.message.includes("already recorded as verified");
    const status = error instanceof ArcTransactionVerificationError
      ? error.statusCode
      : alreadyRecorded
        ? 409
        : 500;
    return c.json<ApiResponse>(
      { success: false, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() },
      status
    );
  }
});

// ── Guardrails ─────────────────────────────────
app.get("/api/guardrails", (c) => {
  return c.json<ApiResponse>({
    success: true,
    data: getGuardrails(),
    timestamp: new Date().toISOString(),
  });
});

app.put("/api/guardrails", async (c) => {
  const authError = onboardingAdminError(c);
  if (authError) return authError;
  const body = await c.req.json();
  setGuardrails(body);
  return c.json<ApiResponse>({
    success: true,
    data: getGuardrails(),
    timestamp: new Date().toISOString(),
  });
});

// ── Initialize & Start ─────────────────────────

if (shouldInitializeLiveServices()) {
  initLedger();

  initCircle({
    apiKey: process.env.CIRCLE_API_KEY || "",
    entitySecret: process.env.CIRCLE_ENTITY_SECRET || "",
    walletSetId: process.env.CIRCLE_WALLET_SET_ID || "",
    usdcTokenId: process.env.CIRCLE_USDC_TOKEN_ID || "",
    gatewayApiBaseUrl: process.env.GATEWAY_API_BASE_URL || "https://gateway-api-testnet.circle.com",
    gatewaySourceDomains: (process.env.GATEWAY_SOURCE_DOMAINS || "26")
      .split(",")
      .map((domain) => Number(domain.trim()))
      .filter((domain) => Number.isInteger(domain) && domain >= 0),
    arcRpcUrl: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io",
    usdcContractAddress: process.env.ARC_TESTNET_USDC_ADDRESS || "",
    usycVaultAddress: process.env.USYC_VAULT_ADDRESS || "",
    usycShareDecimals: parseInt(process.env.USYC_SHARE_DECIMALS || "6"),
    lendingContractAddress: process.env.ARC_LENDING_CONTRACT_ADDRESS || "",
    lendingTokenDecimals: parseInt(process.env.LENDING_TOKEN_DECIMALS || "6"),
  });

  initAgent(applyOnboardingConfiguration({
    model: process.env.AGENT_MODEL || "gpt-4o",
    guardrails: {
      maxDailySpend: parseInt(process.env.AGENT_MAX_DAILY_SPEND || "5000"),
      approvalThreshold: parseInt(process.env.AGENT_APPROVAL_THRESHOLD || "1000"),
      autoInvestThreshold: parseInt(process.env.AGENT_AUTO_INVEST_THRESHOLD || "500"),
      minReserveBalance: parseInt(process.env.AGENT_MIN_RESERVE_BALANCE || "200"),
      maxBorrowAmount: parseInt(process.env.AGENT_MAX_BORROW_AMOUNT || "2000"),
      maxDailyBorrow: parseInt(process.env.AGENT_MAX_DAILY_BORROW || "3000"),
      payrollDay: 1,
      reservePercent: 15,
      allowedCategories: [
        "invoice_payment",
        "vendor_payment",
        "contractor_payment",
        "yield_deposit",
        "yield_withdrawal",
        "bridge",
        "borrow",
        "repay",
        "internal_transfer",
      ],
      blockedAddresses: [],
    },
    wallets: {
      treasury: process.env.TREASURY_WALLET_ID || "treasury-default",
      operations: process.env.OPERATIONS_WALLET_ID || "operations-default",
      reserves: process.env.RESERVES_WALLET_ID || "reserves-default",
    },
  }));
}

const port = parseInt(process.env.API_PORT || "4000");

if (!isVercelDeployment() && !process.env.NEXT_RUNTIME) {
  void import("@hono/node-server").then(({ serve }) => {
    serve({ fetch: app.fetch, port }, (info) => {
      console.log(`\n🏦 AgentVault Treasury API running on http://localhost:${info.port}\n`);
    });
  });
}

export default app;

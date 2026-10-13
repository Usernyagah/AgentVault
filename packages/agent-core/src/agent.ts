// ────────────────────────────────────────────────
// @agentvault/agent-core – Treasury Agent (ReAct)
// ────────────────────────────────────────────────
// Full ReAct-loop agent using OpenAI function calling.
// The agent:
//   1. Receives a user message or autonomous trigger
//   2. Reasons about the situation (Thought)
//   3. Calls tools to gather info / act (Action)
//   4. Observes results (Observation)
//   5. Repeats until it has a final answer
//
// INVARIANT: Every money movement is preceded by a
//            record_decision call. This is enforced
//            by the tool implementations, not by the
//            LLM — the LLM literally cannot skip it.
// ────────────────────────────────────────────────

import type {
  AgentConfig,
  ChatMessage,
  DecisionAction,
  DashboardSummary,
  CashFlowForecast,
} from "@agentvault/shared";
import { v4 as uuid } from "uuid";
import OpenAI from "openai";

import {
  appendDecisionOutcome,
  getDecisionById,
  getLedger,
  getRecentDecisions,
  type LedgerEntry,
} from "./ledger.js";
import {
  checkGuardrails,
  setGuardrails,
  getGuardrails,
  getGuardrailsSummary,
  getRequiredReserveBalance,
  type ExtendedGuardrailConfig,
} from "./guardrails.js";
import {
  getWalletBalance,
  getBorrowCapacity,
  transferUSDC,
  depositToUSYC,
  redeemFromUSYC,
  borrowUSDC,
} from "./circle-service.js";
import { DecisionSchema, TOOL_DEFINITIONS, type RecordDecisionParams } from "./types.js";
import { executeTool, toolForecastCashflow, type ToolContext, type ToolResult } from "./tools.js";

// ── Constants ────────────────────────────────

/** Maximum ReAct loop iterations to prevent runaway */
const MAX_ITERATIONS = 12;

/** Maximum tool calls per single LLM response */
const MAX_TOOL_CALLS_PER_STEP = 4;

// ── Agent State ────────────────────────────────

type AgentStatus = "idle" | "thinking" | "executing" | "awaiting_approval";

interface AgentState {
  status: AgentStatus;
  config: AgentConfig;
  chatHistory: ChatMessage[];
  pendingApprovals: LedgerEntry[];
  openaiClient: OpenAI | null;
}

let state: AgentState | null = null;

// ── System Prompt ─────────────────────────────

function buildSystemPrompt(): string {
  const guardrails = getGuardrailsSummary();
  const recentDecisions = getRecentDecisions(5);
  const recentSummary =
    recentDecisions.length > 0
      ? recentDecisions
          .map(
            (d) =>
              `  #${d.sequenceNumber}: ${d.action} $${d.amountUSDC} – "${d.reasoning.slice(0, 60)}…"`
          )
          .join("\n")
      : "  No recent decisions.";

  return `You are the AgentVault Treasury Agent — an autonomous AI that manages business finances on the Arc blockchain (Circle's stablecoin L1).

## Your Role
You manage three Circle wallets:
- **Treasury**: Main holding wallet for income and reserves
- **Operations**: Working capital for payments and expenses  
- **Reserves**: Safety net and yield generation via USYC

## Your Tools
You have 9 tools available:
1. **get_balance** – Check wallet balances (ALWAYS do this first)
2. **forecast_cashflow** – Predict future cash needs
3. **create_invoice** – Generate a customer invoice or payment link for inbound USDC on Arc
4. **record_incoming_payment** – Register a received payment and update the invoice status
5. **send_usdc** – Send USDC payments through Circle Developer-Controlled Wallets
6. **save_to_usyc** – Invest idle USDC into USYC for yield
7. **redeem_usyc** – Convert USYC back to USDC when needed
8. **borrow_usdc** – Borrow USDC when facing a shortfall
9. **record_decision** – Log a structured decision (MANDATORY before any money movement)

## CRITICAL RULES (non-negotiable)
1. **ALWAYS call get_balance first** before any financial analysis or decision.
2. **ALWAYS call record_decision BEFORE** any money movement (send_usdc, save_to_usyc, redeem_usyc, borrow_usdc). If you try to move money without recording a decision first, the tool will block you.
3. **ALWAYS explain your reasoning** in plain English. Users must understand WHY you made each decision.
4. **NEVER attempt to circumvent guardrails**. They are enforced in code, not in your prompt. Trying to bypass them will fail.
5. **Use forecast_cashflow** before making investment or borrowing decisions to justify your actions with data.

## Decision-Making Framework
When deciding on an action, follow this process:
1. Check current balances → get_balance(wallet: "all")
2. Assess the situation (user request, upcoming expenses, idle funds)
3. If considering a financial action, forecast first → forecast_cashflow
4. Record your decision with full reasoning → record_decision
6. Execute the action → create_invoice / record_incoming_payment / send_usdc / save_to_usyc / redeem_usyc / borrow_usdc
6. Report the outcome in plain English

## Current Guardrails
${guardrails}

## Recent Decision History
${recentSummary}

## Communication Style
- Be precise and financial — you're a treasury manager, not a chatbot
- Always state the numbers: balances, amounts, percentages
- Explain trade-offs when they exist
- If something is blocked by guardrails, explain exactly which limit was hit and why it exists
- If you need human approval, say so clearly and explain what will happen once approved

## Network
All wallet reads and USDC transfers use Circle Developer-Controlled Wallets on Arc testnet. USYC and borrowing are blocked until their Arc contracts are configured.`;
}

// ── Initialization ─────────────────────────────

export function initAgent(config: AgentConfig): void {
  setGuardrails(config.guardrails as Partial<ExtendedGuardrailConfig>);

  let openaiClient: OpenAI | null = null;

  // Only initialize OpenAI client if API key is provided
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey && apiKey !== "your_openai_api_key_here") {
    openaiClient = new OpenAI({ apiKey });
    console.log("[AGENT] OpenAI client initialized");
  } else {
    console.log("[AGENT] No OpenAI API key — running in scaffold mode (no LLM calls)");
  }

  state = {
    status: "idle",
    config,
    chatHistory: [],
    pendingApprovals: [],
    openaiClient,
  };

  console.log("[AGENT] Treasury Agent initialized");
  console.log("[AGENT] Model:", config.model);
  console.log("[AGENT] Guardrails:", JSON.stringify(getGuardrails(), null, 2));
}

export function setAgentWallet(
  purpose: keyof AgentConfig["wallets"],
  walletId: string
): void {
  getState().config.wallets[purpose] = walletId;
}

function getState(): AgentState {
  if (!state) {
    throw new Error("Agent not initialized. Call initAgent() first.");
  }
  return state;
}

// ── Convert chat history to OpenAI format ─────

function toOpenAIMessages(
  chatHistory: ChatMessage[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return chatHistory.map((msg) => ({
    role: msg.role === "agent" ? ("assistant" as const) : (msg.role as "user" | "system"),
    content: msg.content,
  }));
}

// ── ReAct Loop ────────────────────────────────

export async function chat(userMessage: string): Promise<ChatMessage> {
  const s = getState();
  s.status = "thinking";

  // Record user message
  const userMsg: ChatMessage = {
    id: uuid(),
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
  };
  s.chatHistory.push(userMsg);

  // If no LLM client, fall back to scaffold mode
  if (!s.openaiClient) {
    return scaffoldResponse(userMessage, s);
  }

  try {
    const response = await runReActLoop(s, userMessage);
    return response;
  } catch (error: any) {
    console.error("[AGENT] ReAct loop error:", error);
    const errorMsg: ChatMessage = {
      id: uuid(),
      role: "agent",
      content: `I encountered an error while processing your request: ${error.message}. My guardrails are still active and no unauthorized actions were taken.`,
      timestamp: new Date().toISOString(),
    };
    s.chatHistory.push(errorMsg);
    s.status = "idle";
    return errorMsg;
  }
}

async function runReActLoop(
  s: AgentState,
  _userMessage: string
): Promise<ChatMessage> {
  const toolCtx: ToolContext = {
    config: s.config,
    lastDecisionId: null,
    decisionsThisTurn: [],
    decisionAuthorizations: [],
    allBalancesChecked: false,
  };

  // Build messages for OpenAI
  const systemMessage: OpenAI.Chat.Completions.ChatCompletionSystemMessageParam = {
    role: "system",
    content: buildSystemPrompt(),
  };

  // Keep last 20 messages for context window management
  const recentHistory = s.chatHistory.slice(-20);
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    systemMessage,
    ...toOpenAIMessages(recentHistory),
  ];

  // Build OpenAI tools
  const openaiTools: OpenAI.Chat.Completions.ChatCompletionTool[] =
    TOOL_DEFINITIONS.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as OpenAI.FunctionParameters,
      },
    }));

  let iteration = 0;
  const toolCallLog: string[] = [];

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`[AGENT] ReAct iteration ${iteration}/${MAX_ITERATIONS}`);

    const completion = await s.openaiClient!.chat.completions.create({
      model: s.config.model,
      messages,
      tools: openaiTools,
      tool_choice: "auto",
      temperature: 0.1, // Low temp for financial precision
    });

    const choice = completion.choices[0];
    if (!choice) {
      throw new Error("No response from LLM");
    }

    const assistantMessage = choice.message;

    // Add assistant message to the conversation
    messages.push(assistantMessage);

    // If no tool calls, we have the final answer
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const finalContent =
        assistantMessage.content || "I've completed the analysis. Let me know if you need anything else.";

      const agentMsg: ChatMessage = {
        id: uuid(),
        role: "agent",
        content: finalContent,
        timestamp: new Date().toISOString(),
        metadata: {
          decisionId: toolCtx.lastDecisionId || undefined,
          toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
        },
      };

      s.chatHistory.push(agentMsg);
      s.status = s.pendingApprovals.length > 0 ? "awaiting_approval" : "idle";
      return agentMsg;
    }

    // Process tool calls (cap to prevent abuse)
    const toolCalls = assistantMessage.tool_calls.slice(0, MAX_TOOL_CALLS_PER_STEP);
    s.status = "executing";

    for (const toolCall of toolCalls) {
      const functionName = toolCall.function.name;
      let functionArgs: unknown;

      try {
        functionArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        functionArgs = {};
      }

      console.log(`[AGENT]   Tool: ${functionName}(${JSON.stringify(functionArgs).slice(0, 100)})`);
      toolCallLog.push(functionName);

      // Execute the tool
      const result = await executeTool(functionName, functionArgs, toolCtx);

      console.log(`[AGENT]   Result: ${result.success ? "✅" : "❌"} ${result.explanation.slice(0, 100)}`);

      // Feed the result back to the LLM
      const toolMessage: OpenAI.Chat.Completions.ChatCompletionToolMessageParam = {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          success: result.success,
          data: result.data,
          explanation: result.explanation,
        }),
      };
      messages.push(toolMessage);

      // If the tool result indicates pending approval, update agent status
      if (result.success && typeof result.data === "object" && result.data !== null) {
        const toolData = result.data as {
          status?: string;
          decisionId?: string;
          requiresApproval?: boolean;
        };
        if (toolData.status === "awaiting_approval" || toolData.requiresApproval) {
          s.status = "awaiting_approval";
          const pendingDecision = toolData.decisionId
            ? getDecisionById(toolData.decisionId)
            : undefined;
          if (pendingDecision && !s.pendingApprovals.some((d) => d.id === pendingDecision.id)) {
            s.pendingApprovals.push(pendingDecision);
          }
        }
      }
    }
  }

  // Safety: if we hit max iterations, return what we have
  console.warn(`[AGENT] Hit max iterations (${MAX_ITERATIONS}), returning partial result`);
  const safetyMsg: ChatMessage = {
    id: uuid(),
    role: "agent",
    content:
      "I've been analyzing this situation and reached my iteration limit. Here's where I got to: " +
      toolCallLog.map((t) => `called ${t}`).join(", ") +
      ". Let me know if you'd like me to continue.",
    timestamp: new Date().toISOString(),
    metadata: { toolCalls: toolCallLog },
  };
  s.chatHistory.push(safetyMsg);
  s.status = "idle";
  return safetyMsg;
}

// ── Scaffold Mode (no LLM) ───────────────────

function scaffoldResponse(
  userMessage: string,
  s: AgentState
): ChatMessage {
  const guardrails = getGuardrails();
  const agentMsg: ChatMessage = {
    id: uuid(),
    role: "agent",
    content: [
      `I've received your request: "${userMessage}"`,
      "",
      "🔧 **Running in scaffold mode** (no OpenAI API key configured).",
      "Connect an LLM by setting `OPENAI_API_KEY` in your `.env` file to enable full autonomous decision-making.",
      "",
      "**Current guardrails are active:**",
      `• Max daily spend: $${guardrails.maxDailySpend}`,
      `• Max borrow: $${(guardrails as ExtendedGuardrailConfig).maxBorrowAmount}`,
      `• Min reserve: $${guardrails.minReserveBalance}`,
      `• Approval threshold: $${guardrails.approvalThreshold}`,
      "",
      "**Available tools:** get_balance, forecast_cashflow, send_usdc, save_to_usyc, redeem_usyc, borrow_usdc, record_decision",
    ].join("\n"),
    timestamp: new Date().toISOString(),
  };

  s.chatHistory.push(agentMsg);
  s.status = "idle";
  return agentMsg;
}

// ── Autonomous Evaluation ─────────────────────
// Called periodically to let the agent self-evaluate
// and act without a user prompt (e.g., invest idle funds)

export async function evaluateAndAct(): Promise<LedgerEntry | null> {
  const s = getState();
  s.status = "thinking";

  try {
    // 1. Gather current balances
    const [treasury, operations, reserves] = await Promise.all([
      getWalletBalance(s.config.wallets.treasury),
      getWalletBalance(s.config.wallets.operations),
      getWalletBalance(s.config.wallets.reserves),
    ]);

    const balanceSeen = {
      treasury: treasury.balanceUSDC,
      operations: operations.balanceUSDC,
      reserves: reserves.balanceUSDC,
    };

    // If LLM is available, let it decide
    if (s.openaiClient) {
      const decisionCountBefore = getLedger().length;
      const autoMsg = await chat(
        `[SYSTEM AUTO-EVALUATION] Current balances — Treasury: $${treasury.balanceUSDC}, Operations: $${operations.balanceUSDC}, Reserves: $${reserves.balanceUSDC}. ` +
          "Use the forecast and scheduled obligations to determine whether to redeem USYC, borrow within policy, or invest surplus idle USDC."
      );
      console.log("[AGENT] Auto-evaluation complete:", autoMsg.content.slice(0, 100));
      if (getLedger().length > decisionCountBefore) {
        s.status = "idle";
        return getRecentDecisions(1)[0] ?? null;
      }
    }

    const forecastResult = await toolForecastCashflow({ days: 30 }, {
      config: s.config,
      lastDecisionId: null,
      decisionsThisTurn: [],
      decisionAuthorizations: [],
      allBalancesChecked: true,
    });
    if (!forecastResult.success || typeof forecastResult.data !== "object" || forecastResult.data === null) {
      throw new Error(forecastResult.explanation);
    }
    const forecastData = forecastResult.data as {
      forecast: CashFlowForecast;
      daysUntilBelowReserve: number | null;
      projectedShortfallUSDC: string;
      availableToInvest: string;
    };
    const forecastText = `${forecastData.forecast.summary} ${forecastData.forecast.recommendation}`;
    const shortfall = parseFloat(forecastData.projectedShortfallUSDC);

    const runAction = async (
      decisionParams: RecordDecisionParams,
      movementTool: "save_to_usyc" | "redeem_usyc" | "borrow_usdc",
      movementParams: unknown
    ): Promise<LedgerEntry | null> => {
      const toolContext: ToolContext = {
        config: s.config,
        lastDecisionId: null,
        decisionsThisTurn: [],
        decisionAuthorizations: [],
        allBalancesChecked: true,
      };
      const recorded = await executeTool("record_decision", decisionParams, toolContext);
      if (!recorded.success || typeof recorded.data !== "object" || recorded.data === null) {
        console.warn(`[AGENT] Autonomous Decision rejected: ${recorded.explanation}`);
        return null;
      }
      const decisionData = recorded.data as { decisionId?: string; requiresApproval?: boolean };
      const entry = decisionData.decisionId ? getDecisionById(decisionData.decisionId) : undefined;
      if (!entry) throw new Error("Recorded autonomous Decision is missing from the ledger.");

      const queueForApproval = () => {
        if (!s.pendingApprovals.some((pending) => pending.id === entry.id)) {
          s.pendingApprovals.push(entry);
        }
        s.status = "awaiting_approval";
      };
      if (decisionData.requiresApproval) {
        queueForApproval();
        return entry;
      }

      s.status = "executing";
      const movement = await executeTool(movementTool, movementParams, toolContext);
      if (!movement.success) {
        console.warn(`[AGENT] Autonomous movement failed: ${movement.explanation}`);
        s.status = "idle";
        return entry;
      }
      if (
        typeof movement.data === "object" &&
        movement.data !== null &&
        "status" in movement.data &&
        (movement.data as { status: string }).status === "awaiting_approval"
      ) {
        queueForApproval();
      } else {
        s.status = "idle";
      }
      return entry;
    };

    if (shortfall > 0 && forecastData.daysUntilBelowReserve !== null) {
      const treasuryUsyc = parseFloat(treasury.balanceUSYC);
      const operationsUsyc = parseFloat(operations.balanceUSYC);
      const usycAvailable = treasuryUsyc + operationsUsyc;
      if (usycAvailable > 0) {
        const wallet = treasuryUsyc > 0 ? "treasury" : "operations";
        const amount = Math.min(shortfall, treasuryUsyc > 0 ? treasuryUsyc : operationsUsyc).toFixed(2);
        const reasoning = `Redeem $${amount} USYC now because the cash-flow forecast shows liquid balance below the reserve floor in ${forecastData.daysUntilBelowReserve} day(s). This preserves borrowing capacity and addresses the projected obligations first.`;
        return await runAction({
          action: "redeem_usyc",
          amount,
          reasoning,
          forecast: forecastText,
          ruleApplied: "redeem_yield_assets_before_borrowing",
          confidence: 0.9,
          category: "yield_withdrawal",
          toWallet: wallet,
        }, "redeem_usyc", { amount, toWallet: wallet });
      }

      try {
        const capacity = await getBorrowCapacity(s.config.wallets.treasury);
        const borrowAmount = Math.min(
          shortfall,
          parseFloat(capacity.availableUSDC),
          getGuardrails().maxBorrowAmount
        );
        if (borrowAmount > 0) {
          const amount = borrowAmount.toFixed(2);
          const reasoning = `Borrow $${amount} USDC because the forecast shows a $${shortfall.toFixed(2)} reserve shortfall in ${forecastData.daysUntilBelowReserve} day(s), no USYC is available to redeem, and the configured Arc pool reports $${capacity.availableUSDC} borrowing capacity.`;
          return await runAction({
            action: "borrow",
            amount,
            reasoning,
            forecast: forecastText,
            ruleApplied: "borrow_only_after_liquid_and_yield_assets_are_exhausted",
            confidence: 0.82,
            category: "borrow",
            toWallet: "treasury",
          }, "borrow_usdc", { amount, reason: reasoning });
        }
      } catch (error) {
        console.warn("[AGENT] Borrow not available:", error instanceof Error ? error.message : error);
      }
    }

    const investable = Math.min(
      parseFloat(forecastData.availableToInvest),
      Math.max(0, parseFloat(treasury.balanceUSDC) - s.config.guardrails.autoInvestThreshold)
    );
    if (investable > 0) {
      const amount = investable.toFixed(2);
      const reasoning = `Invest $${amount} USDC from treasury into the configured USYC vault. The 30-day forecast includes scheduled obligations and recent realized outflows, and leaves the reserve floor plus a seven-day operating buffer liquid.`;
      return await runAction({
        action: "invest_usyc",
        amount,
        reasoning,
        forecast: forecastText,
        ruleApplied: "invest_only_forecast_surplus_after_reserve_and_obligations",
        confidence: 0.86,
        category: "yield_deposit",
        fromWallet: "treasury",
      }, "save_to_usyc", { amount, fromWallet: "treasury" });
    }

    s.status = "idle";
    return null;
  } catch (error) {
    console.error("[AGENT] Error during evaluation:", error);
    s.status = "idle";
    throw error;
  }
}

// ── Approval Flow ──────────────────────────────

export async function approveDecision(decisionId: string): Promise<boolean> {
  const s = getState();
  const pending = s.pendingApprovals.find((d) => d.id === decisionId);

  if (!pending) {
    console.warn(`[AGENT] Decision ${decisionId} not found in pending approvals`);
    return false;
  }

  const actionToCategory: Record<DecisionAction, import("@agentvault/shared").TxCategory> = {
    send: "vendor_payment",
    receive: "invoice_payment",
    invest_usyc: "yield_deposit",
    redeem_usyc: "yield_withdrawal",
    borrow: "borrow",
    repay: "repay",
    bridge: "bridge",
    hold: "internal_transfer",
  };
  const guardrailCheck = checkGuardrails(
    pending.action,
    parseFloat(pending.amountUSDC),
    pending.category ?? actionToCategory[pending.action],
    pending.toAddress,
    pending.id
  );
  if (!guardrailCheck.allowed) {
    console.warn(`[AGENT] Approval blocked by guardrails: ${guardrailCheck.reason}`);
    return false;
  }

  if (pending.action === "send" || pending.action === "invest_usyc") {
    const [treasury, operations, reserves] = await Promise.all([
      getWalletBalance(s.config.wallets.treasury, "treasury"),
      getWalletBalance(s.config.wallets.operations, "operations"),
      getWalletBalance(s.config.wallets.reserves, "reserves"),
    ]);
    const requiredReserve = getRequiredReserveBalance({
      treasury: treasury.balanceUSDC,
      operations: operations.balanceUSDC,
      reserves: reserves.balanceUSDC,
    });
    if (parseFloat(reserves.balanceUSDC) < requiredReserve) {
      console.warn(
        `[AGENT] Approval blocked: reserves are below required floor $${requiredReserve.toFixed(2)}`
      );
      return false;
    }
  }

  // Execute the approved action
  let transaction: { id: string; status: string; txHash?: string } | undefined;
  if (pending.action === "send" && pending.fromWallet) {
    transaction = await transferUSDC({
      fromWalletId: pending.fromWallet,
      toAddress: pending.toAddress || "",
      amount: pending.amountUSDC,
      category: pending.category === "invoice_payment" || pending.category === "contractor_payment" ? pending.category : "vendor_payment",
    });
  } else if (pending.action === "invest_usyc" && pending.fromWallet) {
    transaction = await depositToUSYC(pending.fromWallet, pending.amountUSDC);
  } else if (pending.action === "redeem_usyc" && pending.toWallet) {
    transaction = await redeemFromUSYC(pending.toWallet, pending.amountUSDC);
  } else if (pending.action === "borrow") {
    transaction = await borrowUSDC(
      s.config.wallets.treasury,
      pending.amountUSDC,
      pending.reasoning
    );
  }
  appendDecisionOutcome(decisionId, {
    actionTaken: transaction
      ? `Approved and executed as transaction ${transaction.id} (${transaction.status}).`
      : "Approved; no supported movement was required.",
    transactionHash: transaction?.txHash,
    transactionId: transaction?.id,
  });

  // Remove from pending
  s.pendingApprovals = s.pendingApprovals.filter((d) => d.id !== decisionId);
  if (s.pendingApprovals.length === 0) {
    s.status = "idle";
  }

  console.log(`[AGENT] Decision ${decisionId} approved and executed`);
  return true;
}

export function rejectDecision(decisionId: string): boolean {
  const s = getState();
  const before = s.pendingApprovals.length;
  s.pendingApprovals = s.pendingApprovals.filter((d) => d.id !== decisionId);

  if (s.pendingApprovals.length === 0) {
    s.status = "idle";
  }

  const rejected = s.pendingApprovals.length < before;
  if (rejected) {
    appendDecisionOutcome(decisionId, {
      actionTaken: "Rejected by a human approver; no transaction was executed.",
    });
    console.log(`[AGENT] Decision ${decisionId} rejected`);
  }
  return rejected;
}

// ── Status / Summary ──────────────────────────

export function getAgentStatus(): AgentStatus {
  return getState().status;
}

export function getChatHistory(): ChatMessage[] {
  return [...getState().chatHistory];
}

export function getPendingApprovals(): LedgerEntry[] {
  return [...getState().pendingApprovals];
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const s = getState();

  const [treasury, operations, reserves] = await Promise.all([
    getWalletBalance(s.config.wallets.treasury),
    getWalletBalance(s.config.wallets.operations),
    getWalletBalance(s.config.wallets.reserves),
  ]);

  const total = (
    parseFloat(treasury.balanceUSDC) +
    parseFloat(operations.balanceUSDC) +
    parseFloat(reserves.balanceUSDC)
  ).toFixed(2);

  const recentDecisions = getRecentDecisions(10);
  const forecastResult = await toolForecastCashflow(
    { days: 7 },
    {
      config: s.config,
      lastDecisionId: null,
      decisionsThisTurn: [],
      decisionAuthorizations: [],
      allBalancesChecked: true,
    }
  );
  if (!forecastResult.success || typeof forecastResult.data !== "object" || forecastResult.data === null) {
    throw new Error(`Unable to build dashboard cash-flow forecast: ${forecastResult.explanation}`);
  }
  const forecastData = forecastResult.data as { forecast: CashFlowForecast };
  const ledger = getLedger().filter((entry) => entry.recordType === "decision");
  const outcomes = new Map(
    getLedger()
      .filter((entry) => entry.recordType === "execution" && entry.relatedDecisionId)
      .map((entry) => [entry.relatedDecisionId!, entry.actionTaken.toLowerCase()])
  );
  const outstandingLoans = ledger.reduce((balance, decision) => {
    const outcome = outcomes.get(decision.id);
    if (!outcome || outcome.includes("failed") || outcome.includes("blocked")) return balance;
    if (decision.action === "borrow") return balance + parseFloat(decision.amountUSDC);
    if (decision.action === "repay") return Math.max(0, balance - parseFloat(decision.amountUSDC));
    return balance;
  }, 0);

  return {
    totalBalance: total,
    treasuryBalance: treasury.balanceUSDC,
    operationsBalance: operations.balanceUSDC,
    reservesBalance: reserves.balanceUSDC,
    usycYield: (
      parseFloat(treasury.balanceUSYC) +
      parseFloat(operations.balanceUSYC) +
      parseFloat(reserves.balanceUSYC)
    ).toFixed(2),
    outstandingLoans: outstandingLoans.toFixed(2),
    pendingTransactions: s.pendingApprovals.length,
    recentDecisions,
    forecast: forecastData.forecast,
    agentStatus: s.status,
  };
}

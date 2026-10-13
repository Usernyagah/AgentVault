# Tameion Agents Hackathon – Project Context

## Project Name
Tameion Treasury Agent (or your preferred name)

## Core Vision
An AI agent that autonomously manages a business’s or freelancer’s money on Arc (Circle’s stablecoin L1).  
The agent can **receive, send, save, and borrow** USDC with full decision-making authority, continuous audit trail, and human-readable reasoning.

## Target Users
- Small businesses
- Freelancers / solopreneurs
- Contractors & small teams

## Must-Win Judging Criteria (Tameion)
- 30% Agentic Sophistication → Agent must *decide* (not just execute)
- 30% Traction → Real usage (even testnet USDC counts)
- 20% Circle tool usage → Heavy use of Wallets, Paymaster, Gateway, CCTP, USYC, Contracts
- 20% Innovation → Novel agent behavior + continuous audit

## Core Capabilities (Priority Order)
1. Intelligent Business Treasury (RFB 01)
2. Autonomous Business Operator (RFB 04)
3. Receive money (invoices / payments)
4. Send money (vendors, contractors, bills)
5. Save / Earn on idle balances (USYC)
6. Borrow when cash-flow forecast requires it
7. Continuous, append-only decision log (critical for trust)

## Tech Stack (Mandatory)
- Settlement: Arc (USDC gas, <500ms)
- Circle Agent Stack + Circle CLI
- Arc CLI (Canteen-hosted testnet)
- Key Circle primitives:
  - Circle Wallets (treasury + sub-wallets)
  - Paymaster (gasless / USDC gas)
  - Gateway + CCTP (unified multichain balance)
  - USYC (yield on idle funds)
  - Smart Contracts (rules, thresholds, escrow)
  - App Kits (Send, Bridge, Swap, Unified Balance)
- Agent framework: prefer LangGraph / CrewAI / AutoGen or simple ReAct loop
- Ledger / Audit: beancount-style or Firefly-iii inspired append-only log
- Backend: Node.js / TypeScript preferred (Circle CLI is Node)
- Frontend: simple Next.js or React dashboard for demo + human oversight

## Non-Negotiables
- Every money movement must have a signed decision record containing:
  - Balance seen at decision time
  - Forecast / reasoning
  - Rule applied
  - Action taken
  - Timestamp + agent signature
- Agent must be able to explain *why* it paid / saved / borrowed
- Hard guardrails the agent cannot override (budget limits, approval thresholds)
- Prefer gasless transactions via Paymaster

## Sample Repos to Fork / Reference
- circlefin/arc-fintech (multichain treasury)
- circlefin/arc-defi-lend-borrow
- circlefin/arc-escrow
- circlefin/arc-x402-circle-wallets

## Deadline
October 17, 2026 23:59 ET

## Success Definition
A live agent that real businesses/freelancers are already using (even on testnet), with clear autonomous decisions and full audit trail.
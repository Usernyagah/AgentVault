# Tameion demo video outline (2:45)

## 0:00–0:20 — The problem

“Freelancers and small businesses have money spread across near-term bills,
reserves, and idle cash, but it is hard to see what an automated treasury agent
will do—or why. AgentVault makes each proposed action inspectable before and
after execution.”

**Show:** AgentVault dashboard title and the demo-mode indicator.

## 0:20–0:55 — Treasury and forecast

“This is a simulated design freelancer business. The dashboard shows its
operating balances, USYC position, outstanding borrowing, and a seven-day
forecast of expected client receipts and expenses. These figures are seeded
demo data, not a live wallet.”

**Show:** Treasury totals and forecast; point out the forecast's expected
invoice settlements and reserve recommendation.

## 0:55–1:30 — Decision and human approval

“The agent evaluates the forecast against its reserve and spending rules. A
payment that needs review appears in the approval queue. I can inspect the
reasoning and choose approve or reject. In Demo Mode that choice updates only
the simulation—it cannot send a blockchain transaction.”

**Show:** Agent decision detail, the applied rule, then the pending approval.
Approve or reject only if the UI makes the simulated state explicit.

## 1:30–2:10 — Signed audit trail

“Every real decision records the timestamp, observed USDC and USYC balances,
forecast, reasoning, applied rule, action, and transaction hash when available.
Execution outcomes are new linked records; they do not overwrite the decision.
The production ledger is append-only JSONL with Ed25519 signatures and a
SHA-256 hash chain. Demo records are deliberately marked unsigned.”

**Show:** Open the ledger, select a record, highlight its rule/reasoning and
signature status, then show the chain-verification control.

## 2:10–2:35 — Onboarding and Arc

“A business can configure Circle Arc testnet wallets and basic treasury rules.
The Arc preflight checks that the configured RPC reports testnet chain ID
5042002. Contract-gated USYC and borrowing integrations are clearly identified
as requiring verified deployments; this demo does not pretend they are live.”

**Show:** Onboarding settings and the README's Arc testnet preflight command.
Do not display API keys, entity secrets, signing keys, or token-bearing Canteen
RPC URLs.

## 2:35–2:45 — Close

“AgentVault combines explainable treasury decisions, deterministic guardrails,
human approval, Circle wallet operations, and an auditable record. Demo Mode
is isolated so judges can explore safely.”

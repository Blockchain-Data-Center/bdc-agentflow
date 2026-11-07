# BDC AgentFlow — Demo

An exact, repeatable demo sequence: one normal run and one controlled failure with a fallback, first in the web UI, then the same two runs in the terminal. Solana Devnet only: every payment is in Devnet USDC, which has no real value. The demo runs locally; nothing is deployed.

The amounts below are in dollars of Devnet USDC; the terminal and the receipts also give them in atomic units (6 decimals: $0.05 = 50000).

## Before you start

1. Complete the setup in [README.md](README.md): `npm ci`, the wallets, `HELIUS_API_KEY` and `ANTHROPIC_API_KEY` in `.env`, and the Devnet funding.
2. Check the wallets: `npm run wallets:check`. The buyer needs at least 0.022 Devnet USDC for the two runs (0.009 + 0.013); the seller's Devnet USDC token account must exist.
3. Optional: `npm test` (25 test files, 96 tests, offline) and `npm run typecheck`.
4. Ports 4020–4023 on `127.0.0.1` must be free.

## Run 1 — the normal run (web UI)

1. Start the UI: `npm run ui`. Expected lines:
   ```
   ui: LLM claude-haiku-5-5
   ui: facilitator preflight PASS
   ui: BDC AgentFlow on http://127.0.0.1:4020 (Solana Devnet only; Devnet USDC, no real value)
   ```
   (Without `ANTHROPIC_API_KEY` the first line says the LLM is unavailable and the labelled deterministic plan and summary are used; everything else below is the same.)
2. Open http://127.0.0.1:4020.
3. **Input.** The goal field is prefilled with the demo goal: "Create a Solana token risk and market intelligence report. Maximum budget: $0.05." Leave it.
4. **Budget.** Leave the maximum budget at `0.05` (the UI accepts $0.001 to $0.05; it can lower the session budget, never raise it). The text "Maximum budget: $0.05" in the goal is not parsed: the budget field and the policy decide.
5. Leave "Simulate provider failure (Market Intel B1 unavailable)" **off** and press **Run AgentFlow**. Agent activity fills in live.

Expected:

- **Procurement plan.** Source: LLM (Claude Haiku 5.5). Capabilities: `token-intelligence, market-intelligence`. Token: JUP, with "No token named; the approved providers serve JUP." in the interpretation. The planner may list free-text notes under "Not supported"; nothing is bought for them.
- **Candidate services**, the Agent Tender's tables:
  - token-intelligence, round 1: Token Intel A, $0.005, `SELECTED` — "Token Intel A is selected: at $0.005 it is the cheapest of 1 eligible candidate, within the per-service cap and the remaining budget."
  - market-intelligence, round 1: Market Intel B1, $0.004, `SELECTED` — "… the cheapest of 2 eligible candidates …"; Market Intel B2, $0.008, `RANKED_LOWER` — "Market Intel B2 is eligible but ranked lower: its price $0.008 is above the $0.004 of Market Intel B1."
- **Selection and payment.** For each capability the activity reads: Identifying required capability → Comparing suppliers → Supplier selected → Procurement decision created → Spending policy: approved → Payment required (x402) → Payment submitted → Payment settled on Solana Devnet → Resource received → Delivery verified → Procurement receipt created. The policy engine runs before any request is sent, so "approved" comes before "payment required".
- **Second procurement.** Market intelligence is bought from Market Intel B1 in the same way, after Token Intel A.
- **Budget.** Starting $0.050, spent $0.009, remaining **$0.041** ("Done. Remaining $0.041 of $0.050."). In atomic units: 50000 → 45000 → **41000**.
- **Purchases.** Two rows, both paid and delivered, each with its Solana Explorer link.
- **Procurement receipt.** Two receipts; open one to see the candidates and reasons, the policy decision, the budget before and after, the transaction, the Explorer URL and the fingerprints.
- **Final result.** A short report on JUP from the purchased data, for example the token supply and the share of the ten largest token accounts from Token Intel A (whose data is `live`, or `cached fallback` with its date if the Mainnet RPC did not answer) and the price and its 24h change from Market Intel B1 (a `snapshot` as of 2026-11-06T22:31:26.223Z). The report is asked to name snapshot and cached-fallback data as such; the figure check does not check that wording (in a recorded run the report called Market Intel B2's snapshot "a cached fallback"). Result source `llm`; if a figure in the LLM's report is not in the purchased data, the report is replaced by the deterministic summary led by "LLM report rejected — figures not in purchased data — deterministic summary" (both outcomes are correct behaviour). The last line states that budget text in the goal is not parsed. Below it, the LLM usage line (not part of the USDC budget).

**Figures at full precision.** The report prints figures as delivered (e.g. `0.2447941616415981`), because the check compares them with the purchased data as delivered; rounding is left to the reader. (The check also accepts a figure correctly rounded to fewer decimals, such as `0.24`.)

## Run 2 — controlled failure and fallback (web UI)

1. In the same page, turn **on** "Simulate provider failure (Market Intel B1 unavailable)". Keep the goal and the budget at `0.05`.
2. Press **Run AgentFlow**.

Expected:

- **Controlled failure.** Token Intel A is bought as in run 1. For market intelligence the Tender again selects Market Intel B1; B1 answers HTTP 503 before any payment is requested. The activity shows "Supplier failed" with "failed before payment: no payment was requested: HTTP 503". No payment was made, its reservation is released, and B1 is never retried in this run.
- **Fallback.** The Tender runs again (round 2): Market Intel B1 `FAILED_IN_SESSION` ("… it already failed in this session and is never retried."), Market Intel B2 `SELECTED` at $0.008. The activity shows "Alternative provider selected", then B2's policy approval, payment, settlement and delivery.
- **Budget.** Spent $0.013, remaining **$0.037**. In atomic units: 50000 → 45000 → 45000 → **37000**.
- **Purchases and receipts.** Three: A paid; B1 `failed-before-payment`, no transaction; B2 paid, marked as a fallback (`isFallback: true`).
- **Final result.** As in run 1, with the market data from Market Intel B2 (the same dated snapshot).

3. Stop the UI with Ctrl+C in its terminal.

## Optional variation — a lower budget

Set the budget to `0.008` with the switch off. After Token Intel A ($0.005) only $0.003 remains, so the Tender excludes both Market Intel B1 and B2 as `OVER_BUDGET`; market intelligence is reported as not obtained, nothing more is paid, and the last line names the session budget of $0.008 set in the UI. This variation was checked with offline stand-ins and is not among the recorded Devnet proofs.

## The same two runs in the terminal

```bash
npm run e2e:devnet
```

```bash
npm run e2e:devnet -- --fail-b1
```

Each prints the plan with `planSource` and `resultSource`, the Agent Tender table of every round, every receipt as JSON, the events, the composed result and the LLM usage. For each paid purchase it checks and prints: (a) HTTP 200; (b) a successful `PAYMENT-RESPONSE` on Solana Devnet with the buyer as payer; (c) the transaction confirmed on Devnet with no error; (d) the seller's balance up and the buyer's down by exactly the price; (e) every field of the response present. Expected: the remaining budget `50000 → 45000 → 41000` for the first and `50000 → 45000 → 45000 → 37000` for the second, `PASS session` and `PASS ledger`, exit code 0. The terminal runs start Market Intel B2 only with `--fail-b1`. Add `--llm-off` to run without the LLM (labelled deterministic plan and summary), or `--goal "<text>"` for another goal.

## Payment evidence

- In the UI: each paid purchase's Solana Explorer link (Purchases) and its `transaction` and `explorerUrl` (Procurement receipt).
- In the terminal: each signature and Explorer URL, and checks (c) and (d) on-chain.
- Every link has the form `https://explorer.solana.com/tx/<signature>?cluster=devnet`. On the transaction page: one transfer of Devnet USDC (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) of exactly the price, from the buyer to the seller, signed by the buyer, with the facilitator as fee payer.

Recorded runs of this sequence through the web UI (runs 3 and 4 of 2026-11-07, verified on-chain at review):

- Run 1 of this sequence (switch off), runId `run-2026-11-07T16-52-04-495Z`, remaining 41000: Token Intel A [`3RqaNxMXyx6qtUpWrHZGH7Gjdma2DrKDwDXaLVL3Qfysm8iYF6k3rkiXUAQsyGgS38M822vQyBx14aXZ1jF7Jybt`](https://explorer.solana.com/tx/3RqaNxMXyx6qtUpWrHZGH7Gjdma2DrKDwDXaLVL3Qfysm8iYF6k3rkiXUAQsyGgS38M822vQyBx14aXZ1jF7Jybt?cluster=devnet), Market Intel B1 [`26X3Cf3kfkj4vk3Q9mGX2sLUxUwCTrTvjx9qxSaxnDThv8PuCDHbYkcD94Z55CccZrNcwUrdcZjqv2H9ta8dqMna`](https://explorer.solana.com/tx/26X3Cf3kfkj4vk3Q9mGX2sLUxUwCTrTvjx9qxSaxnDThv8PuCDHbYkcD94Z55CccZrNcwUrdcZjqv2H9ta8dqMna?cluster=devnet).
- Run 2 of this sequence (switch on), runId `run-2026-11-07T16-52-35-352Z`, remaining 37000: Token Intel A [`RdpBjThPkuczx3XexZ2WpP8vrf8eNTN2nU34zUZV7cnyxJ5ALfgyvewuKbcwthZ2rngfosVJNWinMuUX2FLVdG1`](https://explorer.solana.com/tx/RdpBjThPkuczx3XexZ2WpP8vrf8eNTN2nU34zUZV7cnyxJ5ALfgyvewuKbcwthZ2rngfosVJNWinMuUX2FLVdG1?cluster=devnet), Market Intel B1 failed before payment (no transaction), the fallback Market Intel B2 [`5fv7dHz7woiZCwiPh8tbaPLrKjMbvramhKmZ2LoK7jJFDcQXfWYXQBpMySEp59A3edLJNMDSAxA4okEqwAhXcHmt`](https://explorer.solana.com/tx/5fv7dHz7woiZCwiPh8tbaPLrKjMbvramhKmZ2LoK7jJFDcQXfWYXQBpMySEp59A3edLJNMDSAxA4okEqwAhXcHmt?cluster=devnet).

## If a run fails

A transient Devnet or network error can make a run fail (for example, a payment that cannot be created before anything is signed). Nothing is paid for the failed step, a failed provider is not retried, and the report says what was not obtained. AgentFlow does not retry automatically: start a new run. Every run starts with a fresh budget.

What varies between runs: the LLM's plan wording and report, Token Intel A's live figures and dates (or its cached fallback), the run ids, the times and the transaction signatures. The LLM planner has planned the same two capabilities in every recorded run of the demo goal (the labelled deterministic plan does too). For those capabilities, the Tender's choices and reasons, the prices, the policy decisions and the remaining budgets are fixed by code.

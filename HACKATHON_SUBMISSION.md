# BDC AgentFlow — Hackathon Submission

Encode Club Solana Hackathon 2026 · Best Use of x402 on Solana

Built by **Blockchain Data Center LLC (BDC)** · [Website](https://www.blockchaindatacenter.network) · [GitHub](https://github.com/Blockchain-Data-Center) · [X](https://x.com/blockchaindatac) · [LinkedIn](https://www.linkedin.com/company/blockchaindatacenter)

## Project Name

BDC AgentFlow

## One-Line Description

Autonomous AI Service Procurement with x402 Payments on Solana: an AI agent with a goal and a budget compares providers, stays inside a deterministic spending policy, pays through x402 on Solana, and leaves an auditable receipt for every purchase.

## Problem

AI agents can reason and call tools, but buying a digital capability still usually assumes a subscription, a human-controlled account, a manually issued API key, or a person approving each payment. Giving an agent a wallet does not solve that safely: a wallet can pay, but nothing in it decides what to buy, from whom, within what limit, or records why the money was spent and what came back.

## Solution

BDC AgentFlow is an autonomous procurement layer for AI agents. Instead of simply giving an AI agent a wallet, AgentFlow gives it a controlled purchasing system: the agent can determine which capabilities it needs, compare digital-service providers, select the best option within budget and policy, pay through x402 on Solana, verify delivery, and create an auditable Procurement Decision Receipt. When a provider fails, it records the failure and buys from the next eligible provider under the same rules. The purchased data is composed into one short report whose figures are checked by code against what was bought.

> We are not building a wallet for AI agents. We are building their procurement department.

## Why Now

We see AI agents moving from answering questions to carrying out tasks, and tasks increasingly need data and services the agent does not have. x402 lets a service ask for payment inside an ordinary HTTP exchange, and Solana settles that payment as a transaction anyone can verify. What we think is missing is the layer between the two: the judgment and the controls that decide whether a payment should happen at all. AgentFlow is our view of that layer. This is a vision for where agent commerce is heading, not a measurement of it.

## How AgentFlow Works

1. **Goal and budget.** The user enters a goal and a maximum budget ($0.001 to $0.05 of Devnet USDC) in the local web UI.
2. **Plan.** Claude Haiku 5.5 maps the goal to capabilities in an approved registry; code validates its answer and refuses a token no approved provider serves.
3. **Agent Tender.** For each capability, every approved provider is compared: excluded if inactive, already failed, above the $0.01 per-service cap or above the remaining budget; the rest ranked by price, then reliability within the run, then id. Every candidate gets a reason.
4. **Policy.** The selected purchase passes the deterministic Procurement Policy Engine: Solana Devnet only, Devnet USDC only, at most $0.01 per service, no duplicate purchase, within the session budget. A rejected purchase never reaches the signer.
5. **x402 payment on Solana.** The service answers HTTP 402; a requirement guard checks that it asks for exactly the approved price, network, asset and recipient; the constrained signer signs; the facilitator settles the payment on Solana Devnet.
6. **Delivery and receipt.** The resource counts as delivered only for HTTP 200 with a JSON body. A Procurement Decision Receipt records the attempt, with the transaction and its Solana Explorer link.
7. **Fallback.** A provider that fails before payment is recorded, never retried, and replaced by the Tender's next choice.
8. **Result.** Claude Haiku 5.5 composes a short report; code checks that every figure in it is in the purchased data, or replaces it with a labelled deterministic summary. The UI shows the plan, the Tender tables, the live activity, the budget, the purchases, the receipts and the result.

## Why x402

x402 turns a purchase into part of the HTTP request: the service states its price in a `PAYMENT-REQUIRED` response, the client answers with a signed `PAYMENT-SIGNATURE`, and the service returns the resource with a `PAYMENT-RESPONSE` once the payment is settled. In AgentFlow the buyer needs no account, subscription or API key with the service it buys from, which is what an autonomous buyer needs. AgentFlow uses the x402 V2 flow with the `exact` scheme through the official packages (`@x402/core`, `@x402/express`, `@x402/fetch`, `@x402/svm`, 2.28.0) and the facilitator at `https://x402.org/facilitator`, checked before any paid route is offered. AgentFlow adds what x402 leaves to the buyer: deciding whether to pay, whom to pay, how much, and keeping the record.

## Why Solana

Every AgentFlow purchase settles as a Solana Devnet transaction: a transfer of exactly the price in Devnet USDC from the buyer to the seller, signed by the buyer, with the facilitator paying the fee. Its signature is the settlement evidence in each receipt, verifiable on Solana Explorer; the terminal run also confirms each transaction on-chain and checks that both balances moved by exactly the price. Solana is also a data source: Token Intel A reads live JUP token data from Solana Mainnet (read-only, through the Helius Mainnet RPC), kept separate from the payment network. Without Solana there is no payment and no evidence.

## Agent Tender

When several services can provide the same capability, AgentFlow runs a tender before spending: filter (not active, already failed in this run, above the per-service cap, above the remaining budget), then cheapest first, then the run's reliability count, then the service id, so the result is always deterministic. Every candidate gets a reason code (`SELECTED`, `RANKED_LOWER`, `NOT_ACTIVE`, `FAILED_IN_SESSION`, `OVER_SERVICE_CAP`, `OVER_BUDGET`) and one sentence, shown in the UI and kept in the receipt. In the demo, Market Intel B1 ($0.004) is selected over Market Intel B2 ($0.008); when B1 fails, the Tender runs again and selects B2. The Tender only selects: every purchase still passes the policy engine.

## Procurement Decision Receipt

One receipt per purchase attempt (paid, failed, rejected or pending), as application-level JSON: the capability needed, every candidate considered with its reason, the provider selected and why, the quoted price, the policy decision, the budget before and after, the payment outcome, the Solana Devnet transaction and its Explorer link when paid, whether the resource was delivered, the time, whether it was a fallback, and SHA-256 fingerprints of the request and of the delivered body. The blockchain holds the settlement; the receipt explains why the payment happened and what was received, without publishing the data. Nothing is written on-chain and nothing is saved to disk.

## Architecture

A small modular monolith in TypeScript on Node.js 22 with Express 5: web UI → orchestrator → capability planner (Claude Haiku 5.5) → Agent Tender → Procurement Policy Engine → x402 client with the requirement guard → constrained signer → x402 payment on Solana Devnet via the facilitator → the paid service → Procurement Decision Receipt → result composer and its figure check. Two boundaries are drawn in code: the LLM boundary (the LLM proposes and explains; it never selects, approves, signs or pays) and the signer boundary (one module reads the buyer key and is reached only after the policy engine's approval). The diagram and the details are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Demo

The demo runs locally on Solana Devnet; nothing is deployed. In the web UI (`npm run ui`, http://127.0.0.1:4020), the demo goal "Create a Solana token risk and market intelligence report. Maximum budget: $0.05." is run twice:

- **Normal run.** AgentFlow buys Token Intel A ($0.005) and Market Intel B1 ($0.004); $0.041 of $0.05 remains. Recorded on Devnet: [`3RqaNxMXyx6qtUpWrHZGH7Gjdma2DrKDwDXaLVL3Qfysm8iYF6k3rkiXUAQsyGgS38M822vQyBx14aXZ1jF7Jybt`](https://explorer.solana.com/tx/3RqaNxMXyx6qtUpWrHZGH7Gjdma2DrKDwDXaLVL3Qfysm8iYF6k3rkiXUAQsyGgS38M822vQyBx14aXZ1jF7Jybt?cluster=devnet) and [`26X3Cf3kfkj4vk3Q9mGX2sLUxUwCTrTvjx9qxSaxnDThv8PuCDHbYkcD94Z55CccZrNcwUrdcZjqv2H9ta8dqMna`](https://explorer.solana.com/tx/26X3Cf3kfkj4vk3Q9mGX2sLUxUwCTrTvjx9qxSaxnDThv8PuCDHbYkcD94Z55CccZrNcwUrdcZjqv2H9ta8dqMna?cluster=devnet).
- **Controlled failure and fallback.** With "Simulate provider failure (Market Intel B1 unavailable)" on, B1 answers HTTP 503 before any payment is requested; the Tender selects Market Intel B2 ($0.008); $0.037 remains. Recorded on Devnet: [`RdpBjThPkuczx3XexZ2WpP8vrf8eNTN2nU34zUZV7cnyxJ5ALfgyvewuKbcwthZ2rngfosVJNWinMuUX2FLVdG1`](https://explorer.solana.com/tx/RdpBjThPkuczx3XexZ2WpP8vrf8eNTN2nU34zUZV7cnyxJ5ALfgyvewuKbcwthZ2rngfosVJNWinMuUX2FLVdG1?cluster=devnet) (Token Intel A) and [`5fv7dHz7woiZCwiPh8tbaPLrKjMbvramhKmZ2LoK7jJFDcQXfWYXQBpMySEp59A3edLJNMDSAxA4okEqwAhXcHmt`](https://explorer.solana.com/tx/5fv7dHz7woiZCwiPh8tbaPLrKjMbvramhKmZ2LoK7jJFDcQXfWYXQBpMySEp59A3edLJNMDSAxA4okEqwAhXcHmt?cluster=devnet) (Market Intel B2).

The same runs are available in the terminal (`npm run e2e:devnet` and `npm run e2e:devnet -- --fail-b1`), with on-chain checks of every payment. The exact sequence and the expected output are in [DEMO.md](DEMO.md); setup is in [README.md](README.md).

Demo video: To be added at submission.

Stated plainly: Devnet only, with Devnet USDC of no real value; the three paid services are this project's own; the market data is a dated snapshot and the token data may be a dated cached fallback; a transient Devnet error can make a run fail, and it is then repeated. The limits of the figure check and the other limitations are listed in the README.

## Key Differentiator

x402 already makes machine payments possible. AgentFlow makes them **controlled** (the AI proposes, the policy engine authorizes, the signer signs only after that), **explainable** (a reason for every candidate), **comparative** (a tender before every purchase), **auditable** (a receipt per attempt, tied to its Solana transaction) and **recoverable** (a failed provider is replaced, never retried, and nothing is paid twice). The question it answers is not "can an AI agent pay?" but "can an AI agent decide what to buy, compare suppliers, stay within an authorized budget, prove why it made the purchase, receive what it paid for, recover from supplier failure, and keep an auditable purchasing record?"

## BDC Marketplace Product Direction

Following the hackathon, Blockchain Data Center LLC (BDC), which builds blockchain infrastructure, plans to offer AgentFlow as a product through BDC Marketplace. The direction: BDC Marketplace would supply digital capabilities (AI tools, APIs, datasets, blockchain and infrastructure services, developer products) and AgentFlow would supply autonomous demand, connecting developers and digital-service providers with AI agents able to buy what they need programmatically, with x402-enabled agent access alongside human purchase. This is a planned direction only: AgentFlow has no Marketplace integration today, and no availability, price or customer is claimed.

## Repository

https://github.com/Blockchain-Data-Center/bdc-agentflow

Visibility: Public. Copyright © 2026 Blockchain Data Center LLC (BDC); all rights reserved, no open-source licence (see the README).

Setup and run instructions: [README.md](README.md). Branch `task-a`. The offline test suite (`npm test`) has 25 test files and 96 tests.

## Future Vision

We see AgentFlow growing from one agent buying from three local services into a procurement layer that many agents and organisations can rely on: external service discovery, x402-ready listings from many sellers, supplier reputation and reliability scoring across runs, organisation spending policies and agent budgets, procurement analytics and accounting exports, production-grade wallet and signing infrastructure, and SDKs so developers can give their own agents the same controls. These are plans, not features of this build.

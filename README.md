# BDC AgentFlow

Autonomous AI Service Procurement with x402 Payments on Solana.

BDC AgentFlow is an autonomous procurement layer for AI agents. Give an agent a goal and a spending budget, and it can evaluate, purchase, and compose the digital services it needs using x402 payments on Solana while remaining inside programmable spending policies.

> We are not building a wallet for AI agents. We are building their procurement department.

Built by Blockchain Data Center LLC (BDC), which builds blockchain infrastructure, for the Encode Club Solana Hackathon 2026 (Best Use of x402 on Solana).

[Website](https://www.blockchaindatacenter.network) · [GitHub](https://github.com/Blockchain-Data-Center) · [X](https://x.com/blockchaindatac) · [LinkedIn](https://www.linkedin.com/company/blockchaindatacenter)

**Solana Devnet only.** Every payment is in Devnet USDC, which has no real value. The three paid services are this project's own and run on your machine. Nothing is deployed: the demo runs locally.

Also in this repository: [ARCHITECTURE.md](ARCHITECTURE.md) (components, boundaries and the diagram), [DEMO.md](DEMO.md) (the exact demo sequence) and [HACKATHON_SUBMISSION.md](HACKATHON_SUBMISSION.md).

## Project summary

You give AgentFlow a written goal and a maximum budget. It then:

1. plans the capabilities the goal needs (Claude Haiku 5.5, checked by code against an approved registry);
2. runs an **Agent Tender** for each capability, comparing the candidate providers before any money is spent;
3. passes the selected purchase through a deterministic **Procurement Policy Engine**;
4. pays the provider with an **x402** payment on **Solana Devnet**, signed by a constrained signer the AI never reaches;
5. checks that the resource was delivered and writes a **Procurement Decision Receipt**;
6. falls back to another provider when one fails before payment;
7. composes the purchased data into one short report, whose figures are checked by code against the purchased data;
8. shows what was spent, what remains, and the Solana transaction behind every payment.

It runs in a local web UI (`npm run ui`) or as a terminal script (`npm run e2e:devnet`). The demo goal is the brief's: "Create a Solana token risk and market intelligence report. Maximum budget: $0.05."

## Problem

AI agents can reason and call tools, but buying a digital capability still usually assumes a subscription, a human-controlled account, a manually issued API key, or a person approving each payment. Giving an agent a wallet does not solve that safely: a wallet can pay, but nothing in it decides what to buy, from whom, within what limit, or records why the money was spent and what came back.

## Solution

AgentFlow gives the agent a procurement system instead of a bare wallet. The agent may identify what it needs, compare providers and explain its choice; deterministic code decides whether the purchase is allowed and signs it only after approval; every attempt leaves a receipt that links the reason for the purchase to the Solana transaction that settled it and to a fingerprint of what was delivered. When a provider fails, the agent records the failure and buys from the next eligible provider, under the same rules.

## Key differentiator

AgentFlow makes autonomous purchases:

- **controlled**: the AI proposes, the Procurement Policy Engine authorizes, and only then does the signer sign; the AI cannot raise the budget or change the network or asset;
- **explainable**: every candidate gets a reason code and a one-sentence reason, shown in the UI and kept in the receipt;
- **comparative**: the Agent Tender compares every approved provider of a capability before spending;
- **auditable**: one Procurement Decision Receipt per purchase attempt, with the Solana Devnet transaction and its Explorer link when paid;
- **recoverable**: a provider that fails before payment is recorded, never retried, and replaced by the Tender's next choice.

## Agent Tender

For each required capability, the Agent Tender (`src/agentflow/tender.ts`, a pure function) considers every registry entry of that capability:

1. **Filter.** A candidate is excluded, with its reason, if it is not active (`NOT_ACTIVE`), has already failed in this run (`FAILED_IN_SESSION`), is above the per-service cap of $0.01 (`OVER_SERVICE_CAP`) or above the remaining budget (`OVER_BUDGET`).
2. **Rank.** The eligible candidates are ranked by price, cheapest first; on a tie, by the run's reliability count (fewer failures, then more successes); then by service id, so the order is always deterministic.
3. **Explain.** The first is `SELECTED`, the others `RANKED_LOWER`, and every candidate carries a one-sentence reason, for example "Market Intel B2 is eligible but ranked lower: its price $0.008 is above the $0.004 of Market Intel B1."

The Tender selects; it never approves. Every selected purchase still passes the Procurement Policy Engine before anything is signed. In the demo, token intelligence has one provider (Token Intel A, $0.005) and market intelligence two (Market Intel B1, $0.004, and Market Intel B2, $0.008), so the Tender selects B1 and, when B1 fails, B2.

## Procurement Decision Receipt

Every purchase attempt (paid, failed before payment, payment failed, rejected by policy, or pending) produces one receipt (`src/agentflow/receipt.ts`). It answers:

- which capability was needed (`capability`) and which services were considered, each with its reason (`candidates`);
- which provider was selected and why (`selected`);
- the quoted price (`quotedPriceAtomic`, `quotedPriceUsd`) and the policy decision (`policy`);
- the budget before and after (`budgetBeforeAtomic`, `budgetAfterAtomic`);
- the payment outcome (`paymentOutcome`) and, when paid, the Solana Devnet transaction (`transaction`) and its Explorer link (`explorerUrl`);
- whether the resource was delivered (`delivered`), when (`createdAt`), and whether the attempt was a fallback (`isFallback`);
- a SHA-256 fingerprint of the request (`requestFingerprint`) and, when delivered, of the delivered body (`outputFingerprint`), so a purchase can be linked to its result without publishing the data.

Receipts are application-level JSON. The blockchain holds the settlement; the receipt adds why the payment happened and what was received. Nothing is written on-chain and nothing is saved to disk: the UI shows the receipts of its latest run, and `e2e:devnet` prints them.

## Procurement Policy Engine

The policy engine (`src/policy/engine.ts`) is a pure, deterministic function between the agent's decision and the payment. It checks, in order:

1. the payment network is Solana Devnet (`WRONG_PAYMENT_NETWORK` otherwise);
2. the payment asset is Devnet USDC (`WRONG_PAYMENT_ASSET`);
3. the price is at most $0.01 per service (`OVER_SERVICE_CAP`);
4. the same purchase has not already been made or reserved (`DUPLICATE_PURCHASE`);
5. the price fits the remaining session budget, at most $0.05 (`OVER_BUDGET`).

A rejected purchase returns before any request is made, so the signer is never reached. An approved one is reserved in the session ledger (`src/policy/session.ts`), which then records it as spent when the x402 payment response reports success, releases it when no payment was made or the payment explicitly failed, and keeps it reserved when the outcome after a signed request is unknown (the run then stops). In the web UI the user may lower the session budget to between $0.001 and $0.05; the server validates it and it can never exceed $0.05.

The AI may propose spending; the policy engine authorizes it.

## How x402 is used

AgentFlow uses the x402 V2 flow with the `exact` payment scheme through the official packages `@x402/core`, `@x402/express`, `@x402/fetch` and `@x402/svm`, all pinned at 2.28.0.

- **Seller side.** Each service is an Express app behind `paymentMiddleware`: a request without payment gets HTTP 402 and a `PAYMENT-REQUIRED` header stating the scheme, network, asset, amount and recipient.
- **Buyer side.** The x402 client wraps `fetch`. Before it creates a payment, a requirement guard (`src/payments/requirement-guard.ts`) checks that the server asks for exactly what AgentFlow decided to buy (scheme `exact`, Solana Devnet, Devnet USDC, the registry price, the expected recipient); any difference aborts before anything is signed. The constrained signer then signs, and the request is repeated with a `PAYMENT-SIGNATURE` header.
- **Settlement.** The service verifies and settles the payment through the x402 facilitator at `https://x402.org/facilitator` and returns the resource with a `PAYMENT-RESPONSE` header; AgentFlow decodes it and records the payment only when it reports success.
- **Preflight.** Before any paid route is offered, AgentFlow checks that the facilitator supports x402 V2, scheme `exact`, on Solana Devnet; otherwise it stops.

## How Solana is used

- **Payments.** Every purchase settles as a Solana Devnet transaction (network `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`): a transfer of Devnet USDC (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) from the buyer to the seller, signed by the buyer, with the facilitator as fee payer. The transaction signature is the settlement evidence in the receipt, with its Solana Explorer link. `e2e:devnet` also confirms each transaction on Devnet and checks that the seller's and the buyer's balances moved by exactly the price.
- **Data.** Token Intel A reads JUP token data (supply and the ten largest token accounts) from Solana Mainnet through the Helius Mainnet RPC, read-only. The data network is kept separate from the payment network: the policy's network rule applies to payments only.
- **SDK.** `@solana/kit` 5.5.1.

## Architecture

A small modular monolith in TypeScript on Node.js. The web UI and the terminal script drive the same agent: planner → Agent Tender → Procurement Policy Engine → x402 client with the constrained signer → Solana Devnet and the paid services → receipt → composer with its figure check. The diagram, the AI boundary, the payment and signer boundaries and the security boundaries are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup

Requires Node.js 22 or later.

1. Install the pinned dependencies: `npm ci`
2. Create the Devnet buyer and seller wallets: `npm run wallets:create`. It writes `.env` (git-ignored) with the two wallet keys and `wallets.public.json` (git-ignored) with the public addresses, prints only the public addresses, and refuses to overwrite either file.
3. Add your own keys to `.env` (see the next section): `HELIUS_API_KEY` (required) and `ANTHROPIC_API_KEY` (optional).
4. Fund the wallets on Devnet (see "Devnet instructions").
5. Check the wallets: `npm run wallets:check`
6. Run the offline tests: `npm test` (25 test files, 96 tests, no network) and `npm run typecheck`.
7. Run the demo: `npm run ui`, or `npm run e2e:devnet` in the terminal (see [DEMO.md](DEMO.md)).

## Environment variables

All variables live in the git-ignored `.env`; `.env.example` lists the names with placeholders only. Never commit `.env`.

| Variable | Needed for | Read by |
|---|---|---|
| `BUYER_SECRET_KEY_B58` | signing the buyer's Devnet payments (written by `wallets:create`) | `src/signer/buyer-signer.ts` only |
| `SELLER_SECRET_KEY_B58` | the seller wallet (written by `wallets:create`) | no runtime module (the seller only receives) |
| `HELIUS_API_KEY` | Token Intel A's live Mainnet reads; `npm run ui` and `npm run e2e:devnet` stop at start-up without it | `src/services/token-intel.ts` only |
| `ANTHROPIC_API_KEY` | the planner and the composer (Claude Haiku 5.5); without it the labelled deterministic plan and summary are used | `src/llm/claude.ts` only |
| `JUPITER_API_KEY` | only `npm run capture:market-snapshot`, which is not needed: the snapshot is in the repository and the capture refuses to overwrite it | `scripts/capture-market-snapshot.ts` only |

## Devnet instructions

- **Network.** Everything pays on Solana Devnet; nothing touches Mainnet funds. Service A's Mainnet access is read-only data.
- **Buyer.** Fund the buyer address printed by `wallets:create` with Devnet SOL (the Solana Devnet faucet, https://faucet.solana.com/) and Devnet USDC (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, for example from Circle's public testnet faucet). The two demo runs together spend 0.022 Devnet USDC.
- **Seller.** The seller's Devnet USDC token account must exist before the first payment; it does not need a balance. This project's seller account was created by Circle's testnet faucet.
- **Check.** `npm run wallets:check` prints each wallet's SOL, its Devnet USDC token account and its USDC balance.
- **Evidence.** Every paid purchase links to `https://explorer.solana.com/tx/<signature>?cluster=devnet`.

## Demo

Start the web UI with `npm run ui` and open http://127.0.0.1:4020. Run the demo goal with the defaults: AgentFlow buys Token Intel A ($0.005) and Market Intel B1 ($0.004) and ends with $0.041 of $0.05 remaining. Turn on "Simulate provider failure (Market Intel B1 unavailable)" and run again: B1 answers HTTP 503 before any payment is requested, the Tender selects Market Intel B2 ($0.008), and $0.037 remains. The same two runs are available in the terminal as `npm run e2e:devnet` and `npm run e2e:devnet -- --fail-b1`. The exact sequence, the expected plan, candidates, selections, payments, fallback, result and evidence are in [DEMO.md](DEMO.md).

## Proof on Solana Devnet

Each signature below is a Devnet transaction recorded and verified on-chain at a reviewed stage of this project.

The web UI, on the committed code (two runs on the demo goal, 2026-11-07):

- Run 3, failure switch off (runId `run-2026-11-07T16-52-04-495Z`): Token Intel A ($0.005) settled in [`3RqaNxMXyx6qtUpWrHZGH7Gjdma2DrKDwDXaLVL3Qfysm8iYF6k3rkiXUAQsyGgS38M822vQyBx14aXZ1jF7Jybt`](https://explorer.solana.com/tx/3RqaNxMXyx6qtUpWrHZGH7Gjdma2DrKDwDXaLVL3Qfysm8iYF6k3rkiXUAQsyGgS38M822vQyBx14aXZ1jF7Jybt?cluster=devnet) and Market Intel B1 ($0.004) in [`26X3Cf3kfkj4vk3Q9mGX2sLUxUwCTrTvjx9qxSaxnDThv8PuCDHbYkcD94Z55CccZrNcwUrdcZjqv2H9ta8dqMna`](https://explorer.solana.com/tx/26X3Cf3kfkj4vk3Q9mGX2sLUxUwCTrTvjx9qxSaxnDThv8PuCDHbYkcD94Z55CccZrNcwUrdcZjqv2H9ta8dqMna?cluster=devnet); two receipts, 24 events; remaining 50000 → 45000 → 41000 atomic units; the LLM report passed the figure check.
- Run 4, failure switch on (runId `run-2026-11-07T16-52-35-352Z`): Token Intel A ($0.005) settled in [`RdpBjThPkuczx3XexZ2WpP8vrf8eNTN2nU34zUZV7cnyxJ5ALfgyvewuKbcwthZ2rngfosVJNWinMuUX2FLVdG1`](https://explorer.solana.com/tx/RdpBjThPkuczx3XexZ2WpP8vrf8eNTN2nU34zUZV7cnyxJ5ALfgyvewuKbcwthZ2rngfosVJNWinMuUX2FLVdG1?cluster=devnet); Market Intel B1 answered HTTP 503 before any payment was requested and was not retried; the Tender selected Market Intel B2 ($0.008), which settled in [`5fv7dHz7woiZCwiPh8tbaPLrKjMbvramhKmZ2LoK7jJFDcQXfWYXQBpMySEp59A3edLJNMDSAxA4okEqwAhXcHmt`](https://explorer.solana.com/tx/5fv7dHz7woiZCwiPh8tbaPLrKjMbvramhKmZ2LoK7jJFDcQXfWYXQBpMySEp59A3edLJNMDSAxA4okEqwAhXcHmt?cluster=devnet); three receipts (the third marked as a fallback), 30 events; remaining 50000 → 45000 → 45000 → 37000 atomic units; the LLM report passed the figure check.

The terminal script with the LLM (2026-11-07), each paid purchase also confirmed on Devnet with the exact balance changes:

- `npm run e2e:devnet`: Token Intel A in [`5HTYm2HLefwKXxnZgv34vCWkzNZv77A5LxYjCkZcFbhPaiG8SfPZwyKL3TLD5kwgqunyexzPqqcuD3Dge5HK1mUP`](https://explorer.solana.com/tx/5HTYm2HLefwKXxnZgv34vCWkzNZv77A5LxYjCkZcFbhPaiG8SfPZwyKL3TLD5kwgqunyexzPqqcuD3Dge5HK1mUP?cluster=devnet) and Market Intel B1 in [`4iXgfHE2MksXv44JHsryv6C5zQ2ouQM7uU5wHRSakFwoWxG5Y7Pz74gAEkPHFdpFXXRvPpt3rvf2KTwqVigc1BDU`](https://explorer.solana.com/tx/4iXgfHE2MksXv44JHsryv6C5zQ2ouQM7uU5wHRSakFwoWxG5Y7Pz74gAEkPHFdpFXXRvPpt3rvf2KTwqVigc1BDU?cluster=devnet); remaining 41000.
- `npm run e2e:devnet -- --fail-b1`: Token Intel A in [`4vtAVbV3NBjHUAtN326UqE2FKezP2Vjfb1M4cH4dCspnZ6xEfK37uwCUQQTzHxHx8dTtTtzNFhsGrjnZKkVB3vsL`](https://explorer.solana.com/tx/4vtAVbV3NBjHUAtN326UqE2FKezP2Vjfb1M4cH4dCspnZ6xEfK37uwCUQQTzHxHx8dTtTtzNFhsGrjnZKkVB3vsL?cluster=devnet) and the fallback Market Intel B2 in [`3JPVYuHdGcppdizEri6cuksdr29kCPKXT3QF8C3DhrYGfDerY276SuXp5ZwNN7qxxee7ERA4tSbZfoAAr6sMAVLX`](https://explorer.solana.com/tx/3JPVYuHdGcppdizEri6cuksdr29kCPKXT3QF8C3DhrYGfDerY276SuXp5ZwNN7qxxee7ERA4tSbZfoAAr6sMAVLX?cluster=devnet); remaining 37000. An earlier `--fail-b1` run the same afternoon ended without market data (see "Limitations") and was repeated once, unchanged.

The first x402 payment of the project (2026-10-17): Token Intel A ($0.005) in [`3UVUZ5sjexGrrhKZjRxDdWfPuxEv1VUee2jzBhc96fiqT5q3AgjS63EswN5Q9bUkLDnWkAkoSCHi1CjtP5cStnwN`](https://explorer.solana.com/tx/3UVUZ5sjexGrrhKZjRxDdWfPuxEv1VUee2jzBhc96fiqT5q3AgjS63EswN5Q9bUkLDnWkAkoSCHi1CjtP5cStnwN?cluster=devnet).

## Security

- **Secrets.** Wallet keys and API keys live only in the git-ignored `.env`. Each class of secret is read by one module only (see "Environment variables"); no secret is printed, logged, placed in an error, a receipt, an event, a test or this repository. Errors carry a method and a status, never a URL, a key or a header. gitleaks ran on the staged changes before every commit.
- **The AI never reaches the money.** The planner and the composer read no environment variable and import nothing from the signer or the payment client. The LLM sees the goal, each registry entry's capability and name, and, for the report, the delivered data (which includes public Mainnet token-account addresses) and a summary of the purchases; never a key, the buyer's or the seller's address, a transaction signature or a fingerprint. It cannot select the supplier, approve a purchase, raise the budget, or change the network or the asset.
- **Signing.** Only `src/signer/buyer-signer.ts` reads the buyer key. The order is always decision → policy approval → requirement guard → signature. A rejected purchase never reaches the signer.
- **Duplicates.** The policy engine blocks a purchase already made or reserved in the session.
- **Web UI.** It listens on `127.0.0.1:4020` only and refuses any request not addressed to `127.0.0.1:4020` or `localhost:4020`; every response carries a same-origin Content-Security-Policy; no CORS header is ever set; every text is rendered as text, never as HTML; the server validates every input and never trusts the browser; only one run at a time. No secret, environment value or header reaches the browser.
- **Tests.** The 96 tests run offline, with stand-ins and dummy keys only, and never read the real `.env`.

## Limitations

- **Devnet only.** Payments are in Devnet USDC, which has no real value. Nothing is deployed; the demo runs locally on one machine.
- **Own services.** The three paid services are this project's own, started locally for each run. No third-party x402 provider is used.
- **Data.** Market Intel B1 and B2 serve a dated snapshot of JUP market data (Jupiter Price API V3, as of 2026-11-06T22:31:26.223Z), labelled `snapshot`, not live. Token Intel A serves live Mainnet data when the RPC answers and otherwise a dated cached fallback, labelled `cached fallback` with its cause; both have occurred in recorded runs. The providers serve JUP only: a goal naming another token is refused and nothing is bought.
- **Transient Devnet errors.** A transient error can make a run fail. In one recorded run the fallback provider's payment could not be created before anything was signed; nothing was paid for it, it was not retried, and the report stated market intelligence as not obtained. There is no automatic retry: the run is repeated.
- **Events.** The structured events are derived from each purchase's outcome, not observed on the wire.
- **Reliability.** The reliability signal counts successes and failures per provider within one run only; nothing is kept between runs.
- **Policy rejection.** A candidate rejected by the policy engine is not replaced by another one: the capability is reported as not obtained.
- **Paid but undelivered.** A resource that was paid for but not delivered intact (not HTTP 200 with a JSON body) is not bought a second time from another provider: it is reported as not delivered.
- **Unknown payment outcome.** When the outcome after a signed request is unknown, the run stops and the amount stays reserved; there is no automatic reconciliation.
- **The figure check.** The LLM report is replaced by the labelled deterministic summary when one of its figures is not in the purchased data. The check has limits:
  - it verifies that each figure exists in the purchased data with a matching unit, not what the report attributes it to or how it is worded: in run 4 above, the report called Market Intel B2's dated snapshot "a cached fallback";
  - a bare integer before "hour(s)" or "day(s)" passes only when the same digits occur inside a field name of the purchased data (for example `24` in `priceChange24hPct`);
  - figures are compared as IEEE-754 doubles, so the sixth decimal of a ten-digit value is not distinguished;
  - a bare integer from 0 to 10 is not checked.
- **Budget text.** Budget text in a goal ("Maximum budget: $0.05") is not parsed; the policy budget, or the lower budget set in the UI, applies, and every result says so. The Claude API's token usage is reported separately and is not part of the x402 USDC session budget.
- **Persistence.** Receipts and events are not saved: the UI keeps only its latest run in memory.

## BDC Marketplace roadmap

BDC plans to offer AgentFlow as a product through **BDC Marketplace**, a planned product direction. The idea: BDC Marketplace would supply digital capabilities (AI tools, APIs, datasets, blockchain and infrastructure services, developer products), and AgentFlow would be the procurement layer through which AI agents evaluate, buy and use them, with x402-enabled access alongside human purchase.

Nothing of this is built. AgentFlow has no Marketplace integration, and no availability, price or customer is claimed. Directions under consideration after the hackathon include Marketplace integration, seller onboarding and x402-ready service listings, external service discovery, supplier reputation and reliability scoring, organisation spending policies and agent budgets, procurement analytics and accounting exports, production wallet infrastructure, and SDKs for developers.

## Status

Encode Club Solana Hackathon 2026. Slices 1–9 are built and proven on Solana Devnet: the x402 payment path, the Procurement Policy Engine, the second service, agent planning, the Agent Tender, the Procurement Decision Receipt, result composition with the figure check, the fallback, and the web UI. Slice 10 (submission hardening) is these four documents; nothing is deployed.

Market data snapshot: Jupiter Price API V3. Token data: Helius Mainnet RPC.

## Copyright and licence

Copyright © 2026 Blockchain Data Center LLC (BDC). All rights reserved. This repository is public so that its code can be read, run and evaluated, including by the judges of the Encode Club Solana Hackathon 2026. Beyond that, and beyond the rights GitHub's Terms of Service give other users to view and fork public repositories on GitHub, no licence is granted to use, copy, modify or distribute the original AgentFlow code. Third-party dependencies and data sources remain under their own terms.

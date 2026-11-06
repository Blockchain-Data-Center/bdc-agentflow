# BDC AgentFlow

Autonomous AI Service Procurement with x402 Payments on Solana.

BDC AgentFlow is an autonomous procurement layer for AI agents. Give an agent a goal and a spending budget, and it can evaluate, purchase, and compose the digital services it needs using x402 payments on Solana while remaining inside programmable spending policies.

Status: in development for the Encode Club Solana Hackathon 2026 — Task A (payment core)

Devnet only; no real funds.

## Implemented

Task A, Slice 1 (payment golden path), in progress:

- separate configuration for the data network (Solana Mainnet, read-only) and the payment network (Solana Devnet, Devnet USDC);
- a service registry holding Service A (token intelligence, $0.005 Devnet USDC);
- a constrained buyer signer, the only source module that reads wallet signing material;
- a requirement guard that aborts an x402 payment before anything is signed unless the server asks for exactly the registry quote;
- an x402 V2 client (`@x402/fetch`, `@x402/svm` exact scheme);
- Service A, an x402-protected Express resource that reads JUP token-account data from Solana Mainnet through the Helius Mainnet RPC (read-only), with a dated cached fallback;
- a facilitator preflight that checks the facilitator supports x402 V2, scheme `exact`, on Solana Devnet before any paid route is advertised;
- offline unit tests (`node:test`, no network).

Task A, Slice 2 (Procurement Policy Engine), in progress:

- a deterministic, pure policy engine that runs before any payment is attempted: payment network Solana Devnet only, payment asset Devnet USDC only, at most $0.01 per service, duplicate purchases blocked, and the $0.05 session budget never exceeded;
- a session ledger that reserves the amount on approval, records it when the x402 payment response reports success, releases it when no payment was made or the payment explicitly failed, and keeps it reserved for reconciliation when the outcome after a signed request is unknown;
- a purchase flow where a rejected proposal returns before any request is made, so the signer is never reached;
- offline tests for each rule, the ledger, and the rejected paths that never reach the signer.

Task A, Slice 3 (second service), in progress:

- two market-intelligence services, Market Intel B1 ($0.004 Devnet USDC) and Market Intel B2 ($0.008 Devnet USDC, an alternative provider), x402-protected Express resources serving a dated market snapshot of JUP, clearly labelled `snapshot` with its source and `asOf` (not live market data);
- the market snapshot, captured once with a single request and kept in the project (`data/snapshots/market-JUP.json`). Market data snapshot: Jupiter Price API V3;
- a minimal, deterministic session runner that buys an ordered plan of services one purchase at a time, each through the policy engine; when a service fails before any payment, it records the failure, never retries that service, and buys its one alternate through the same policy engine; when the outcome of a signed payment is unknown, it stops the session;
- offline tests for the new registry entries, the two services, the snapshot capture, and the session runner.

Live Devnet x402 payment: proven on 2026-10-17 by `npm run e2e:devnet` — one $0.005 Devnet USDC purchase of Service A, settled in Solana Devnet transaction `3UVUZ5sjexGrrhKZjRxDdWfPuxEv1VUee2jzBhc96fiqT5q3AgjS63EswN5Q9bUkLDnWkAkoSCHi1CjtP5cStnwN` ([Solana Explorer](https://explorer.solana.com/tx/3UVUZ5sjexGrrhKZjRxDdWfPuxEv1VUee2jzBhc96fiqT5q3AgjS63EswN5Q9bUkLDnWkAkoSCHi1CjtP5cStnwN?cluster=devnet)), with HTTP 200, a successful x402 payment response, the transaction confirmed without error, the seller's balance up and the buyer's down by exactly 5000 atomic units, and the full Service A response delivered.

Live Devnet purchase through the policy engine: proven on 2026-10-17 by `npm run e2e:devnet` — the engine approved one $0.005 Devnet USDC purchase of Service A, settled in Solana Devnet transaction `4QPzwkz3rGxV9ADURFcbyLVJEudZuWdKDiZgS7Q263tz2AmZEGsowqximGyJhMFykkD3Wgmj6ivfCg7sMykbxxMp` ([Solana Explorer](https://explorer.solana.com/tx/4QPzwkz3rGxV9ADURFcbyLVJEudZuWdKDiZgS7Q263tz2AmZEGsowqximGyJhMFykkD3Wgmj6ivfCg7sMykbxxMp?cluster=devnet)), with the same checks as above, and the session ledger at a budget of 50000, 5000 spent and 45000 remaining (atomic units). Service A served its labelled cached fallback in that run.

Two sequential paid purchases and one controlled failure with a fallback provider: proven on 2026-11-07 by two runs, each checked as above for every paid purchase (Service A served its labelled cached fallback in both runs):

- `npm run e2e:devnet`: the plan Service A, then Market Intel B1. Service A ($0.005) settled in Solana Devnet transaction `4GuGzHm6hRavk5uHJPNcPw8SoaRmj73zhKVv5A1X7356CurtxEi2xXG28WoxgrMpop293eoZ3oq8EatETwh8zz1j` ([Solana Explorer](https://explorer.solana.com/tx/4GuGzHm6hRavk5uHJPNcPw8SoaRmj73zhKVv5A1X7356CurtxEi2xXG28WoxgrMpop293eoZ3oq8EatETwh8zz1j?cluster=devnet)) and Market Intel B1 ($0.004) in `65M5W2qZh9BGA5n5Jj8FNCe9Ztg25KofwMHrkDscX1JDaxDHXyNaKw6WtQVx2tHMzqJYKTYSkTfDqeEwTbBgTARN` ([Solana Explorer](https://explorer.solana.com/tx/65M5W2qZh9BGA5n5Jj8FNCe9Ztg25KofwMHrkDscX1JDaxDHXyNaKw6WtQVx2tHMzqJYKTYSkTfDqeEwTbBgTARN?cluster=devnet)); the session budget went 50000 → 45000 → 41000 (atomic units).
- `npm run e2e:devnet -- --fail-b1`: the same plan with Market Intel B1 made unavailable. Service A ($0.005) settled in `uhGauaq5QnkGhnTTZJLZJsTYAH4jV5oUc34hFNxQ4cD6uJX8B5LzYNdQkCPkR6c3V58h5AcXN6ZxTaXbPUQvk9D` ([Solana Explorer](https://explorer.solana.com/tx/uhGauaq5QnkGhnTTZJLZJsTYAH4jV5oUc34hFNxQ4cD6uJX8B5LzYNdQkCPkR6c3V58h5AcXN6ZxTaXbPUQvk9D?cluster=devnet)); B1 answered HTTP 503 before any payment was requested, was recorded as failed with no payment, and was not retried; the alternate Market Intel B2 ($0.008) settled in `UHMKdfZDuGrzLTTFjPPabemRnUMbDoG3pdFNUN3R4qhKfmBwUhHb7CmznZ6q7iQ9nVFctb5cXmMLgpiJkM2iw1w` ([Solana Explorer](https://explorer.solana.com/tx/UHMKdfZDuGrzLTTFjPPabemRnUMbDoG3pdFNUN3R4qhKfmBwUhHb7CmznZ6q7iQ9nVFctb5cXmMLgpiJkM2iw1w?cluster=devnet)); the session budget went 50000 → 45000 → 37000 (atomic units).

## Planned

- Later slices of the hackathon brief (agent planning, provider comparison, procurement receipts, result composition, user interface) are planned and not yet built.

## Setup

Requires Node.js 22 or later.

1. Install: `npm install`
2. Create the Devnet buyer and seller wallets: `npm run wallets:create` (writes `.env`, which is git-ignored, and `wallets.public.json`; prints only the public addresses), then add your own Helius API key to `.env` as `HELIUS_API_KEY` (used only for the Mainnet token-intel reads)
3. Fund the buyer with Devnet SOL and Devnet USDC, and make sure the seller's Devnet USDC token account exists
4. Check the wallets: `npm run wallets:check`
5. Run the offline tests: `npm test`
6. Run the live Devnet purchases: `npm run e2e:devnet`, and the controlled failure with its fallback provider: `npm run e2e:devnet -- --fail-b1`

The market snapshot is already in the project. It was captured once with `npm run capture:market-snapshot`, which needs a Jupiter API key in `.env` as `JUPITER_API_KEY` and refuses to overwrite an existing snapshot.

See `.env.example` for the variable names. Never commit `.env`.

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

Live Devnet x402 payment: proven on 2026-10-17 by `npm run e2e:devnet` — one $0.005 Devnet USDC purchase of Service A, settled in Solana Devnet transaction `3UVUZ5sjexGrrhKZjRxDdWfPuxEv1VUee2jzBhc96fiqT5q3AgjS63EswN5Q9bUkLDnWkAkoSCHi1CjtP5cStnwN` ([Solana Explorer](https://explorer.solana.com/tx/3UVUZ5sjexGrrhKZjRxDdWfPuxEv1VUee2jzBhc96fiqT5q3AgjS63EswN5Q9bUkLDnWkAkoSCHi1CjtP5cStnwN?cluster=devnet)), with HTTP 200, a successful x402 payment response, the transaction confirmed without error, the seller's balance up and the buyer's down by exactly 5000 atomic units, and the full Service A response delivered.

## Planned

- Slice 2: a deterministic Procurement Policy Engine (session budget, per-service limit, allowed network and asset, duplicate-purchase protection) between the purchase decision and the signer.
- Slice 3: a second, independently priced market-intelligence service, two sequential paid purchases, and one controlled failure with a fallback provider.

## Setup

Requires Node.js 22 or later.

1. Install: `npm install`
2. Create the Devnet buyer and seller wallets: `npm run wallets:create` (writes `.env`, which is git-ignored, and `wallets.public.json`; prints only the public addresses), then add your own Helius API key to `.env` as `HELIUS_API_KEY` (used only for the Mainnet token-intel reads)
3. Fund the buyer with Devnet SOL and Devnet USDC, and make sure the seller's Devnet USDC token account exists
4. Check the wallets: `npm run wallets:check`
5. Run the offline tests: `npm test`
6. Run the live Devnet payment: `npm run e2e:devnet`

See `.env.example` for the variable names. Never commit `.env`.

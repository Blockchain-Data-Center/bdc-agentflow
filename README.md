# BDC AgentFlow

Autonomous AI Service Procurement with x402 Payments on Solana.

BDC AgentFlow is an autonomous procurement layer for AI agents. Give an agent a goal and a spending budget, and it can evaluate, purchase, and compose the digital services it needs using x402 payments on Solana while remaining inside programmable spending policies.

Status: in development for the Encode Club Solana Hackathon 2026 — Task A (payment core) and Task B (procurement judgment in stage S4, no LLM; agent planning and result composition in stage S5, with an LLM)

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

Task B, Slices 5, 6 and 8 (Agent Tender, Procurement Decision Receipt, fallback), built in stage S4 with no LLM:

- an Agent Tender that compares every registry candidate for a required capability before any money is spent: it excludes a candidate that is not active, has already failed in this run, is above the $0.01 per-service cap or above the remaining budget, ranks the rest by price (cheapest first; on a tie, the run's simple reliability count, then the service id), and gives every candidate a reason code and a one-sentence reason. The Tender only selects; every selected purchase still passes the policy engine before anything is signed;
- a procurement runner that buys by capability: the Tender's choice is bought through the policy engine; when a provider fails before payment or the payment explicitly fails, the failure is recorded, that provider is never retried, and the Tender runs again on the remaining candidates and its new choice is bought, through the same policy engine. A candidate the policy engine rejects is not replaced by another one: the capability is reported as not obtained. A resource that was paid for but not delivered intact (not HTTP 200 with a JSON body) is not bought a second time from another provider: it is reported as not delivered. When the outcome of a signed payment is unknown, the run stops;
- a Procurement Decision Receipt for every purchase attempt (paid, failed, rejected or pending): the capability, every candidate considered with its reason, the selected provider and why, the quoted price, the policy decision, the budget before and after, the payment outcome, the Solana Devnet transaction and its Explorer link when paid, whether the resource was delivered, the time, and SHA-256 fingerprints of the request and of the delivered body. It is application-level JSON, printed by the run; nothing is written on-chain and nothing is saved to disk;
- structured events for each step (capability required, candidates found, supplier selected or fallback selected, procurement decision, policy approved or rejected, payment required, authorized and settled, resource received, delivery verified, service failed, receipt created). They are derived from each purchase's outcome, not observed on the wire;
- the reliability signal is a count of successes and failures per provider within one run only; nothing is kept between runs;
- Service A records why it served its cached fallback (the failing RPC method and status, or the error class only), and its live read now waits up to 20 seconds;
- offline tests for the Tender, the receipts, the runner (including the fallback, a policy rejection, a capability with no eligible candidate, an unknown payment outcome and a paid but undelivered resource) and Service A's fallback cause.

Agent Tender, receipts and fallback on Devnet: proven on 2026-11-07 by two runs over the capabilities token intelligence, then market intelligence, each paid purchase checked as above:

- `npm run e2e:devnet`: the Tender selected Token Intel A (the only token-intelligence provider) and Market Intel B1 (the cheaper of two market-intelligence providers, B2 ranked lower). Token Intel A ($0.005) settled in Solana Devnet transaction `3CAS5ZfkA7mP4K82fRBvr7mX1F86e2LScy6i8gzEFF8dd6aRLzyuPzy9vrmpvxfApR8toW6DkPeExMbJaZFijcpP` ([Solana Explorer](https://explorer.solana.com/tx/3CAS5ZfkA7mP4K82fRBvr7mX1F86e2LScy6i8gzEFF8dd6aRLzyuPzy9vrmpvxfApR8toW6DkPeExMbJaZFijcpP?cluster=devnet)) and Market Intel B1 ($0.004) in `ckq5PCdwWwLDj5V8p8on7VgD41WvUREtQuAJpA6PQfaZGyW9ERBqmAysUKRjJsmo8sozVWCKdUdR1mXP6sCWwto` ([Solana Explorer](https://explorer.solana.com/tx/ckq5PCdwWwLDj5V8p8on7VgD41WvUREtQuAJpA6PQfaZGyW9ERBqmAysUKRjJsmo8sozVWCKdUdR1mXP6sCWwto?cluster=devnet)); two receipts; the session budget went 50000 → 45000 → 41000 (atomic units). Service A served its labelled cached fallback in this run, with the recorded cause `getTokenLargestAccounts failed: rpc-error`.
- `npm run e2e:devnet -- --fail-b1`: Market Intel B1 made unavailable. Token Intel A ($0.005) settled in `42QTAUV15W4JSR4PMpPaD9ikzcE6kbx8eqA74MHXxHnDHLvW23EYnhy9QjXvDbC7e8gUz2WJ2wW6bLBgZW6NQR2f` ([Solana Explorer](https://explorer.solana.com/tx/42QTAUV15W4JSR4PMpPaD9ikzcE6kbx8eqA74MHXxHnDHLvW23EYnhy9QjXvDbC7e8gUz2WJ2wW6bLBgZW6NQR2f?cluster=devnet)) with live Mainnet data; the Tender selected B1, which answered HTTP 503 before any payment was requested and was recorded as failed with no payment; the Tender ran again, excluded B1 as failed, and selected Market Intel B2 ($0.008), which settled in `tWRrcK7xr7w3syQ7ytbtyh5BBooSY67khm4UHWFraVbZb81YNXefhLmESg8HmBoF3rGtcwLAVuE5RqxNNXPVZFb` ([Solana Explorer](https://explorer.solana.com/tx/tWRrcK7xr7w3syQ7ytbtyh5BBooSY67khm4UHWFraVbZb81YNXefhLmESg8HmBoF3rGtcwLAVuE5RqxNNXPVZFb?cluster=devnet)); three receipts, the third marked as a fallback; the session budget went 50000 → 45000 → 45000 → 37000 (atomic units).

Task B, Slices 4 and 7 (agent planning, result composition), built in stage S5 with Claude Haiku 5.5 (`claude-haiku-5-5`) on the Claude API, called with plain `fetch` (no SDK), one attempt per call with a 20-second timeout:

- a planner that reads a written goal and proposes the capabilities to buy. The LLM sees the goal and each registry entry's capability and name only (no prices, no addresses) and answers in a fixed JSON schema; its answer is checked against the registry by code: a capability the registry does not offer is reported as unsupported, and a goal naming a token the approved providers do not serve is refused, with nothing bought. The approved providers serve JUP only;
- a composer that turns the delivered resources into one short plain-text report. It sees the goal, the plan, the delivered data and a summary of the purchases (capability, provider, quoted price, outcome, fallback), never a wallet address, a transaction signature or a fingerprint, and it names cached-fallback and snapshot data as such, with their dates;
- the LLM only proposes and explains: the Agent Tender chooses each supplier and the policy engine authorizes every purchase, as before. Budget text in a goal (such as "Maximum budget: $0.05") is not parsed; the policy budget of $0.05 always applies, and every result says so. The LLM never sees signing material;
- when the LLM is unavailable (no API key, an error, a timeout, an invalid answer) or switched off with `--llm-off`, the run continues with a keyword-based plan and a template summary, visibly labelled `LLM unavailable — deterministic plan` and `LLM unavailable — deterministic summary`. That plan also refuses a goal naming another token. Purchases, policy checks and receipts are the same on either path;
- the Claude API's token usage is printed for each call and in total; it is not part of the x402 USDC session budget;
- offline tests for the API client (with a stand-in `fetch` and a dummy key), the planner's checks and refusals, the composer, the deterministic path and the whole agent run.

Goal to report on Devnet, with the LLM: proven on 2026-11-07 by two runs on the brief's demo goal ("Create a Solana token risk and market intelligence report. Maximum budget: $0.05."), each paid purchase checked as above. In both runs Claude Haiku 5.5 planned the two capabilities (token intelligence, then market intelligence) for JUP, noting that the goal names no token, and composed the report, naming the market data as a dated snapshot; Service A served live Mainnet data in both:

- `npm run e2e:devnet`: Token Intel A ($0.005) settled in Solana Devnet transaction `5HTYm2HLefwKXxnZgv34vCWkzNZv77A5LxYjCkZcFbhPaiG8SfPZwyKL3TLD5kwgqunyexzPqqcuD3Dge5HK1mUP` ([Solana Explorer](https://explorer.solana.com/tx/5HTYm2HLefwKXxnZgv34vCWkzNZv77A5LxYjCkZcFbhPaiG8SfPZwyKL3TLD5kwgqunyexzPqqcuD3Dge5HK1mUP?cluster=devnet)) and Market Intel B1 ($0.004) in `4iXgfHE2MksXv44JHsryv6C5zQ2ouQM7uU5wHRSakFwoWxG5Y7Pz74gAEkPHFdpFXXRvPpt3rvf2KTwqVigc1BDU` ([Solana Explorer](https://explorer.solana.com/tx/4iXgfHE2MksXv44JHsryv6C5zQ2ouQM7uU5wHRSakFwoWxG5Y7Pz74gAEkPHFdpFXXRvPpt3rvf2KTwqVigc1BDU?cluster=devnet)); the session budget went 50000 → 45000 → 41000 (atomic units); the Claude API used 2459 input and 1368 output tokens.
- `npm run e2e:devnet -- --fail-b1`: Token Intel A ($0.005) settled in `4vtAVbV3NBjHUAtN326UqE2FKezP2Vjfb1M4cH4dCspnZ6xEfK37uwCUQQTzHxHx8dTtTtzNFhsGrjnZKkVB3vsL` ([Solana Explorer](https://explorer.solana.com/tx/4vtAVbV3NBjHUAtN326UqE2FKezP2Vjfb1M4cH4dCspnZ6xEfK37uwCUQQTzHxHx8dTtTtzNFhsGrjnZKkVB3vsL?cluster=devnet)); Market Intel B1 answered HTTP 503 before any payment was requested and was not retried; the Tender selected Market Intel B2 ($0.008), which settled in `3JPVYuHdGcppdizEri6cuksdr29kCPKXT3QF8C3DhrYGfDerY276SuXp5ZwNN7qxxee7ERA4tSbZfoAAr6sMAVLX` ([Solana Explorer](https://explorer.solana.com/tx/3JPVYuHdGcppdizEri6cuksdr29kCPKXT3QF8C3DhrYGfDerY276SuXp5ZwNN7qxxee7ERA4tSbZfoAAr6sMAVLX?cluster=devnet)), and the report named B2 as a fallback provider; the session budget went 50000 → 45000 → 45000 → 37000 (atomic units); the Claude API used 2535 input and 1372 output tokens. An earlier `--fail-b1` run the same afternoon ended without market data: B2's payment could not be created before anything was signed (cause not recorded), so nothing was paid for it, B2 was not retried, and the report stated market intelligence as not obtained; the run was repeated once, unchanged.

## Planned

- The user interface (Slice 9) and submission hardening (Slice 10) are planned and not yet built.

## Setup

Requires Node.js 22 or later.

1. Install: `npm install`
2. Create the Devnet buyer and seller wallets: `npm run wallets:create` (writes `.env`, which is git-ignored, and `wallets.public.json`; prints only the public addresses), then add your own Helius API key to `.env` as `HELIUS_API_KEY` (used only for the Mainnet token-intel reads) and, for the LLM, your own Claude API key as `ANTHROPIC_API_KEY` (optional: without it the labelled deterministic path runs)
3. Fund the buyer with Devnet SOL and Devnet USDC, and make sure the seller's Devnet USDC token account exists
4. Check the wallets: `npm run wallets:check`
5. Run the offline tests: `npm test`
6. Run the live Devnet purchases: `npm run e2e:devnet` (the brief's demo goal; prints the plan, the Tender table, the receipts, the events, the composed result and the LLM usage), and the controlled failure with the Tender's fallback provider: `npm run e2e:devnet -- --fail-b1`. Another goal: `npm run e2e:devnet -- --goal "<your goal>"`; without the LLM: add `--llm-off`

The market snapshot is already in the project. It was captured once with `npm run capture:market-snapshot`, which needs a Jupiter API key in `.env` as `JUPITER_API_KEY` and refuses to overwrite an existing snapshot.

See `.env.example` for the variable names. Never commit `.env`.

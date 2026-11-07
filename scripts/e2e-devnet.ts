// The live Devnet E2E for S5: facilitator preflight, then the services in-process on 127.0.0.1 (A on 4021, B1 on
// 4022, and with --fail-b1 also B2 on 4023), then runAgent on a written goal (--goal "<text>", default the brief's
// demo goal): the planner (Claude Haiku 5.5, or the labelled deterministic plan with --llm-off or when the LLM is
// unavailable) proposes the capabilities, runProcurement buys them over the registry (the Agent Tender selects each
// supplier, each purchase is one purchase call: the policy engine first, then the payment by the constrained buyer
// signer, and each attempt gets a Procurement Decision Receipt), and the composer reports on what was delivered.
// With --fail-b1, B1 answers 503 before its paywall and the Tender re-runs and selects B2.
// Success needs every check (a)–(e) for each paid purchase; an HTTP 200 alone is never success. The expected record
// shape (and, with --fail-b1, B1's own check) applies to the default goal only; with --goal, the paid purchases and
// the ledger are checked. The Claude API usage is printed apart: it is not part of the x402 USDC session budget.
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { createSolanaRpc, signature } from "@solana/kit";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { SettleResponse } from "@x402/core/types";
import type { Delivery } from "../src/agentflow/procure.ts";
import type { ProcurementReceipt } from "../src/agentflow/receipt.ts";
import { runAgent } from "../src/agentflow/run-agent.ts";
import { serviceUrlFor, SESSION_HOST, SESSION_METHOD } from "../src/agentflow/run-session.ts";
import { paymentAsset, paymentNetwork, paymentRpcUrl } from "../src/config/networks.ts";
import { CLAUDE_MODEL, ClaudeError, createClaudeClient, type Complete } from "../src/llm/claude.ts";
import { createPayingFetch } from "../src/payments/client.ts";
import { FacilitatorUnsupportedError, assertFacilitatorSupports } from "../src/payments/facilitator-preflight.ts";
import type { PayAndFetch } from "../src/payments/purchase.ts";
import * as rules from "../src/policy/rules.ts";
import { createLedger, requestKeyFor, type LedgerView } from "../src/policy/session.ts";
import { serviceA, serviceB1, serviceB2, services, type ServiceEntry, type ServiceQuote } from "../src/registry/services.ts";
import { createServiceA } from "../src/services/service-a.ts";
import { createServiceB, type MarketSnapshot } from "../src/services/service-b.ts";
import { createTokenIntelProvider, createTokenIntelRpc } from "../src/services/token-intel.ts";
import { loadBuyerSigner } from "../src/signer/buyer-signer.ts";

const FACILITATOR_URL = "https://x402.org/facilitator";
const POLL_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 2000;
const FAIL_B1 = process.argv.includes("--fail-b1");
const LLM_OFF = process.argv.includes("--llm-off");
// The brief's demo goal. "Maximum budget" in a goal is never parsed: the session budget is the policy's (FD-02).
const DEMO_GOAL = "Create a Solana token risk and market intelligence report. Maximum budget: $0.05.";
const GOAL_INDEX = process.argv.indexOf("--goal");
const GOAL_GIVEN = GOAL_INDEX !== -1;
const GOAL = GOAL_GIVEN ? process.argv[GOAL_INDEX + 1] : DEMO_GOAL;

const SERVICE_A_FIELDS = [
  "serviceId",
  "capability",
  "dataNetwork",
  "mint",
  "decimals",
  "supplyUi",
  "largestAccounts",
  "top10TokenAccountSharePct",
  "dataStatus",
  "asOf",
  "source",
] as const;
const SERVICE_B_FIELDS = [
  "serviceId",
  "capability",
  "mint",
  "priceUsd",
  "priceChange24hPct",
  "decimals",
  "blockId",
  "dataStatus",
  "asOf",
  "source",
] as const;
const RESPONSE_FIELDS: Record<string, readonly string[]> = {
  [serviceA.serviceId]: SERVICE_A_FIELDS,
  [serviceB1.serviceId]: SERVICE_B_FIELDS,
  [serviceB2.serviceId]: [...SERVICE_B_FIELDS, "providerNote"],
};

// What each run with the default goal must end with (S3-Q5, S4-Q8, S5-Q9), as records derived from the receipts.
type RunRecord = { serviceId: string; outcome: ProcurementReceipt["paymentOutcome"]; code?: string; remainingAfter: bigint };
const EXPECTED: RunRecord[] = FAIL_B1
  ? [
      { serviceId: serviceA.serviceId, outcome: "paid", remainingAfter: 45_000n },
      { serviceId: serviceB1.serviceId, outcome: "failed-before-payment", code: "SERVICE_FAILED", remainingAfter: 45_000n },
      { serviceId: serviceB2.serviceId, outcome: "paid", remainingAfter: 37_000n },
    ]
  : [
      { serviceId: serviceA.serviceId, outcome: "paid", remainingAfter: 45_000n },
      { serviceId: serviceB1.serviceId, outcome: "paid", remainingAfter: 41_000n },
    ];

type TokenBalanceRow = { mint: string; owner?: string; uiTokenAmount: { amount: string } };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

function fail(check: string, detail: string): never {
  console.error(`FAIL ${check}: ${detail}`);
  process.exit(1);
}

function pass(check: string, detail: string): void {
  console.log(`PASS ${check}: ${detail}`);
}

function printLedger(ledger: LedgerView): void {
  console.log(`ledger: budget ${ledger.budgetAtomic}, committed ${ledger.committed()}, reserved ${ledger.reserved()}, remaining ${ledger.remaining()} (atomic)`);
}

// Sum of the payment-asset balance rows owned by the given wallet (0 when it has none).
function ownerBalance(rows: readonly TokenBalanceRow[] | undefined, owner: string): bigint {
  return (rows ?? [])
    .filter((row) => row.mint === paymentAsset && row.owner === owner)
    .reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), 0n);
}

async function preflight(facilitator: HTTPFacilitatorClient): Promise<void> {
  try {
    const kind = await assertFacilitatorSupports(facilitator, { x402Version: 2, scheme: "exact", network: paymentNetwork });
    console.log(`facilitator preflight: PASS, matching kind ${JSON.stringify(kind)}`);
  } catch (error) {
    if (error instanceof FacilitatorUnsupportedError) {
      console.error(`facilitator preflight: ${error.code}`);
      console.error(`returned kinds: ${JSON.stringify(error.kinds, null, 2)}`);
    } else {
      console.error(`facilitator preflight: FACILITATOR_UNREACHABLE: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}

async function confirmedTransaction(sig: string) {
  const rpc = createSolanaRpc(paymentRpcUrl);
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
    const tx = await rpc
      .getTransaction(signature(sig), { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "jsonParsed" })
      .send();
    if (tx) return tx;
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

function listen(app: Express, entry: ServiceEntry): Promise<Server> {
  return new Promise<Server>((resolve) => {
    const server = app.listen(entry.port, SESSION_HOST, () => resolve(server));
  });
}

// The record of one attempt, derived from its receipt (R5).
function recordOf(receipt: ProcurementReceipt): RunRecord {
  const code =
    receipt.paymentOutcome === "failed-before-payment" ? "SERVICE_FAILED" : receipt.paymentOutcome === "payment-failed" ? "PAYMENT_FAILED" : undefined;
  return {
    serviceId: receipt.selected.serviceId,
    outcome: receipt.paymentOutcome,
    ...(code !== undefined ? { code } : {}),
    remainingAfter: BigInt(receipt.budgetAfterAtomic),
  };
}

// S1-Q9 (a)–(e) for one paid purchase, with that service's own price and response definition. The body was read
// once by the runner and kept only when delivered (S4-Q5); the response's status and headers are read here.
async function verifyPaid(
  quote: ServiceQuote,
  response: Response,
  delivery: Delivery | undefined,
  wallets: { buyer: string; seller: string },
): Promise<void> {
  const label = quote.serviceId;

  // (a) HTTP 200
  if (response.status !== 200) fail(`${label} (a)`, `HTTP ${response.status}, resource not delivered (FD-26)`);
  pass(`${label} (a)`, "HTTP 200");

  // (b) PAYMENT-RESPONSE
  const header = response.headers.get("PAYMENT-RESPONSE");
  if (!header) fail(`${label} (b)`, "no PAYMENT-RESPONSE header");
  let settle: SettleResponse;
  try {
    settle = decodePaymentResponseHeader(header);
  } catch (error) {
    fail(`${label} (b)`, `PAYMENT-RESPONSE does not decode: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (settle.success !== true) fail(`${label} (b)`, `success is ${settle.success} (${settle.errorReason ?? "no reason"})`);
  if (settle.network !== paymentNetwork) fail(`${label} (b)`, `network is ${settle.network}`);
  if (!settle.transaction) fail(`${label} (b)`, "empty transaction");
  if (settle.payer !== wallets.buyer) fail(`${label} (b)`, `payer is ${settle.payer}, expected the buyer ${wallets.buyer}`);
  pass(`${label} (b)`, `success, ${settle.network}, payer ${settle.payer}`);
  const sig = settle.transaction;
  console.log(`${label} signature: ${sig}`);
  console.log(`${label} explorer: ${explorerTx(sig)}`);

  // (c) confirmed on Devnet with no error
  const tx = await confirmedTransaction(sig);
  if (!tx) fail(`${label} (c)`, `not found at confirmed after ${POLL_ATTEMPTS} attempts`);
  if (!tx.meta) fail(`${label} (c)`, "transaction has no meta");
  if (tx.meta.err !== null) fail(`${label} (c)`, `meta.err is ${JSON.stringify(tx.meta.err)}`);
  pass(`${label} (c)`, "confirmed, meta.err === null");

  // (d) exact balance deltas of the payment asset
  const pre = tx.meta.preTokenBalances as readonly TokenBalanceRow[] | undefined;
  const post = tx.meta.postTokenBalances as readonly TokenBalanceRow[] | undefined;
  const sellerDelta = ownerBalance(post, wallets.seller) - ownerBalance(pre, wallets.seller);
  const buyerDelta = ownerBalance(post, wallets.buyer) - ownerBalance(pre, wallets.buyer);
  console.log(`${label} seller delta: ${sellerDelta} atomic, buyer delta: ${buyerDelta} atomic`);
  if (sellerDelta !== quote.priceAtomic) fail(`${label} (d)`, `seller delta ${sellerDelta}, expected +${quote.priceAtomic}`);
  if (buyerDelta !== -quote.priceAtomic) fail(`${label} (d)`, `buyer delta ${buyerDelta}, expected -${quote.priceAtomic}`);
  pass(`${label} (d)`, `seller +${sellerDelta}, buyer ${buyerDelta}`);

  // (e) the kept body carries every field of that service's response definition
  if (!delivery) fail(`${label} (e)`, "resource not delivered: body is not JSON");
  const fields = RESPONSE_FIELDS[quote.serviceId];
  const body = delivery.body as Record<string, unknown>;
  const missing = fields.filter((field) => !(field in body));
  if (missing.length > 0) fail(`${label} (e)`, `missing fields: ${missing.join(", ")}`);
  if (body.serviceId !== quote.serviceId) fail(`${label} (e)`, `serviceId is ${String(body.serviceId)}`);
  pass(`${label} (e)`, `every field of its response definition present, serviceId ${body.serviceId}`);
  console.log(`${label} data status: ${body.dataStatus} (asOf ${body.asOf})${body.fallbackCause !== undefined ? `, fallbackCause: ${body.fallbackCause}` : ""}`);
}

// The LLM's complete, printing each call's token usage (S5-Q7); a failed call's counts come from its ClaudeError.
function withUsageLines(complete: Complete): Complete {
  let calls = 0;
  return async (request) => {
    calls += 1;
    const label = `LLM call ${calls} (${request.jsonSchema !== undefined ? "planner" : "composer"})`;
    try {
      const reply = await complete(request);
      console.log(`${label}: ${reply.usage.inputTokens} input / ${reply.usage.outputTokens} output tokens`);
      return reply;
    } catch (error) {
      if (error instanceof ClaudeError) {
        console.log(`${label} failed: ${error.message}; ${error.usage.inputTokens} input / ${error.usage.outputTokens} output tokens`);
      } else {
        console.log(`${label} failed: ${error instanceof Error ? error.name : typeof error}`);
      }
      throw error;
    }
  };
}

async function main(): Promise<void> {
  if (GOAL_GIVEN && (GOAL === undefined || GOAL.trim() === "" || GOAL.startsWith("--"))) fail("setup", "--goal needs the goal text after it");
  console.log(`e2e:devnet: goal ${JSON.stringify(GOAL)}${GOAL_GIVEN ? "" : " (the default demo goal)"}${FAIL_B1 ? ", --fail-b1: B1 unavailable, the Tender selects the replacement" : ""}${LLM_OFF ? ", --llm-off" : ""}`);

  // The LLM client, unless --llm-off; a missing key or any failure to create it takes the labelled deterministic
  // path (R8). The key is never printed: only the variable's name can appear in the message.
  let llm: Complete | undefined;
  if (LLM_OFF) {
    console.log("LLM: off (--llm-off), no client created; the labelled deterministic plan and summary are used");
  } else {
    try {
      llm = withUsageLines(createClaudeClient().complete);
      console.log(`LLM: ${CLAUDE_MODEL}`);
    } catch (error) {
      console.log(`LLM: unavailable (${error instanceof Error ? error.message : typeof error}); the labelled deterministic plan and summary are used`);
    }
  }

  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  await preflight(facilitator);

  const wallets = JSON.parse(readFileSync(new URL("../wallets.public.json", import.meta.url), "utf8")) as {
    buyer: string;
    seller: string;
  };
  const signer = await loadBuyerSigner();
  if (signer.address !== wallets.buyer) fail("setup", "the buyer signer does not match wallets.public.json");

  let snapshot: MarketSnapshot;
  try {
    snapshot = JSON.parse(readFileSync(new URL("../data/snapshots/market-JUP.json", import.meta.url), "utf8")) as MarketSnapshot;
  } catch {
    fail("setup", "data/snapshots/market-JUP.json is missing or unreadable");
  }

  const tokenIntel = createTokenIntelProvider({
    rpc: createTokenIntelRpc(),
    cachePath: fileURLToPath(new URL("../data/cache/token-intel-JUP.json", import.meta.url)),
  });
  const servers: Server[] = [
    await listen(createServiceA({ payTo: wallets.seller, facilitator, tokenIntel }), serviceA),
    await listen(
      createServiceB({ variant: "B1", payTo: wallets.seller, facilitator, snapshot, ...(FAIL_B1 ? { failMode: "unavailable" as const } : {}) }),
      serviceB1,
    ),
  ];
  if (FAIL_B1) servers.push(await listen(createServiceB({ variant: "B2", payTo: wallets.seller, facilitator, snapshot }), serviceB2));
  for (const entry of FAIL_B1 ? [serviceA, serviceB1, serviceB2] : [serviceA, serviceB1]) {
    console.log(`${entry.name} listening on http://${SESSION_HOST}:${entry.port}${entry.endpointPath}${entry === serviceB1 && FAIL_B1 ? " (failMode unavailable)" : ""}`);
  }

  const quoteFor = (serviceId: string): ServiceQuote => {
    const entry = services.find((candidate) => candidate.serviceId === serviceId);
    if (!entry) fail("setup", `no registry entry ${serviceId}`);
    return { ...entry, payTo: wallets.seller };
  };

  // One paying fetch per purchase; the response and the count of signed requests are kept per service for the checks.
  const responses = new Map<string, Response>();
  const signedSent = new Map<string, () => number>();
  const payAndFetchFor = (quote: ServiceQuote): PayAndFetch => {
    const paying = createPayingFetch({ signer, quote });
    signedSent.set(quote.serviceId, paying.signedRequestsSent);
    // Never throws: an error is returned with the count of signed requests, for purchase to map.
    return async (target) => {
      try {
        const response = await paying.fetch(target);
        responses.set(quote.serviceId, response);
        return { response, signedRequestsSent: paying.signedRequestsSent() };
      } catch (error) {
        return { error, signedRequestsSent: paying.signedRequestsSent() };
      }
    };
  };

  const ledger = createLedger(rules.sessionBudgetAtomic);
  printLedger(ledger);
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const agent = await runAgent({
    goal: GOAL,
    llm,
    llmOff: LLM_OFF,
    candidates: services,
    ledger,
    rules,
    quoteFor,
    payAndFetchFor,
    now: () => new Date(),
    runId,
  });
  for (const server of servers) server.close();
  const result = agent.procurement;
  console.log(`runId: ${runId}`);
  console.log(`plan: ${JSON.stringify(agent.plan, null, 2)}`);

  // The Tender table of every round, per capability.
  for (const round of result.rounds) {
    console.log(`tender: ${round.capability}, round ${round.round}`);
    for (const candidate of round.candidates) {
      console.log(`  ${candidate.serviceId}  ${candidate.priceUsd}  ${candidate.reasonCode}: ${candidate.reasonText}`);
    }
  }
  // Each receipt as JSON, then the events in order.
  for (const receipt of result.receipts) console.log(`receipt: ${JSON.stringify(receipt, null, 2)}`);
  for (const event of agent.events) {
    console.log(`event: ${event.name}${event.capability ? ` [${event.capability}]` : ""}${event.serviceId ? ` ${event.serviceId}` : ""}${event.detail ? ` — ${event.detail}` : ""}`);
  }
  console.log(`events: ${agent.events.map((event) => event.name).join(", ")}`);
  for (const delivery of result.deliveries.filter((candidate) => candidate.capability === "token-intelligence")) {
    const body = delivery.body as { dataStatus?: unknown; fallbackCause?: unknown };
    console.log(`token-intelligence ${delivery.serviceId} dataStatus: ${String(body.dataStatus)}${body.fallbackCause !== undefined ? `, fallbackCause: ${String(body.fallbackCause)}` : ""}`);
  }
  console.log(`unfulfilled: ${JSON.stringify(result.unfulfilled.map(({ capability, reasons }) => ({ capability, reasons: reasons.map((reason) => (typeof reason === "string" ? reason : `${reason.serviceId} ${reason.reasonCode}`)) })))}`);
  console.log(`undelivered: ${JSON.stringify(result.undelivered)}`);
  console.log(`reliability: ${JSON.stringify(result.reliability)}`);
  console.log(`planSource: ${agent.plan.planSource}${agent.plan.label ? ` (${agent.plan.label})` : ""}${agent.plan.llmError ? `, llmError: ${agent.plan.llmError}` : ""}`);
  console.log(`resultSource: ${agent.result.resultSource}${agent.result.label ? ` (${agent.result.label})` : ""}${agent.result.llmError ? `, llmError: ${agent.result.llmError}` : ""}`);
  console.log(`result:\n${agent.result.text}`);
  console.log(`LLM usage (Claude API, not part of the x402 USDC session budget): ${agent.usage.inputTokens} input / ${agent.usage.outputTokens} output tokens.`);

  const records = result.receipts.map(recordOf);
  for (const record of records) {
    const price = quoteFor(record.serviceId).priceAtomic;
    console.log(
      `record: ${record.serviceId} ${price} atomic, outcome ${record.outcome}${record.code ? ` (${record.code})` : ""}, signed requests sent ${signedSent.get(record.serviceId)?.() ?? 0}, remaining after ${record.remainingAfter}`,
    );
  }
  console.log(`remaining: ${[rules.sessionBudgetAtomic, ...records.map((record) => record.remainingAfter)].join(" → ")}`);
  if (result.stoppedEarly) {
    printLedger(ledger);
    const last = result.receipts[result.receipts.length - 1];
    const lastId = last.selected.serviceId;
    console.error(`pending reconciliation: requestKey ${requestKeyFor(lastId, SESSION_METHOD, serviceUrlFor(quoteFor(lastId)))}, buyer ${wallets.buyer}`);
    fail("session", "stopped early on a pending-reconciliation purchase");
  }

  // With the default goal, the run must have gone exactly as expected (S5-Q9: not with another goal).
  if (!GOAL_GIVEN) {
    const shape = (list: readonly RunRecord[]) =>
      JSON.stringify(list.map(({ serviceId, outcome, code, remainingAfter }) => ({ serviceId, outcome, code, remainingAfter: String(remainingAfter) })));
    if (shape(records) !== shape(EXPECTED)) fail("session", `records differ from the expected ${shape(EXPECTED)}`);
    pass("session", `${records.map((record) => `${record.serviceId} ${record.outcome}`).join(", ")}`);
  } else {
    console.log("session: --goal given, the expected record shape is not checked; the paid purchases and the ledger are");
  }

  // B1 in failMode, with the default goal: SERVICE_FAILED with no payment.
  if (FAIL_B1 && !GOAL_GIVEN) {
    const sent = signedSent.get(serviceB1.serviceId)?.() ?? -1;
    if (sent !== 0) fail(`${serviceB1.serviceId}`, `${sent} signed requests sent, expected 0`);
    if (ledger.status(requestKeyFor(serviceB1.serviceId, SESSION_METHOD, serviceUrlFor(quoteFor(serviceB1.serviceId)))) !== undefined) {
      fail(`${serviceB1.serviceId}`, "its reservation was not released");
    }
    pass(`${serviceB1.serviceId}`, "SERVICE_FAILED with no payment: 0 signed requests, reservation released, not retried");
  }

  // S1-Q9 (a)–(e) for each paid purchase.
  for (const receipt of result.receipts.filter((candidate) => candidate.paymentOutcome === "paid")) {
    const serviceId = receipt.selected.serviceId;
    const response = responses.get(serviceId);
    if (!response) fail(`${serviceId}`, "no response kept");
    if (receipt.transaction === undefined) fail(`${serviceId}`, "paid without a transaction");
    const delivery = result.deliveries.find((candidate) => candidate.serviceId === serviceId);
    await verifyPaid(quoteFor(serviceId), response, delivery, wallets);
  }

  // The session ledger after the run.
  printLedger(ledger);
  const spent = records.filter((record) => record.outcome === "paid").reduce((sum, record) => sum + quoteFor(record.serviceId).priceAtomic, 0n);
  const expectedRemaining = GOAL_GIVEN ? rules.sessionBudgetAtomic - spent : EXPECTED[EXPECTED.length - 1].remainingAfter;
  if (ledger.committed() !== spent || ledger.reserved() !== 0n || ledger.remaining() !== expectedRemaining) {
    fail("ledger", `expected committed ${spent}, reserved 0, remaining ${expectedRemaining}`);
  }
  pass("ledger", `budget ${ledger.budgetAtomic}, committed ${ledger.committed()}, remaining ${ledger.remaining()}`);

  console.log("e2e:devnet: all checks passed");
  process.exit(0);
}

await main();

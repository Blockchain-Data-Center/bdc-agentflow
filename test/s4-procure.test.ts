import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { paymentNetwork } from "../src/config/networks.ts";
import { runProcurement } from "../src/agentflow/procure.ts";
import { serviceUrlFor, SESSION_METHOD } from "../src/agentflow/run-session.ts";
import type { TenderCandidateInput } from "../src/agentflow/tender.ts";
import type { PayAndFetch } from "../src/payments/purchase.ts";
import * as rules from "../src/policy/rules.ts";
import { createLedger, requestKeyFor, type Ledger } from "../src/policy/session.ts";
import { serviceA, serviceB1, serviceB2, services, type ServiceQuote } from "../src/registry/services.ts";

const fixedAddress = (fill: number) => getBase58Decoder().decode(new Uint8Array(32).fill(fill));
const payTo = fixedAddress(9);
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TOKEN = "token-intelligence";
const MARKET = "market-intelligence";
const A = serviceA.serviceId;
const B1 = serviceB1.serviceId;
const B2 = serviceB2.serviceId;
const now = () => new Date("2026-11-07T12:00:00.000Z");

const quoteFrom = (list: readonly TenderCandidateInput[]) => (serviceId: string): ServiceQuote => {
  const entry = list.find((candidate) => candidate.serviceId === serviceId);
  if (!entry) throw new Error(`unknown service ${serviceId}`);
  return { ...entry, status: "active", payTo };
};
const keyOf = (serviceId: string) => requestKeyFor(serviceId, SESSION_METHOD, serviceUrlFor(quoteFrom(services)(serviceId)));

// A 200 carrying a successful PAYMENT-RESPONSE, built with the x402 encoder; one signed request was sent.
const paid = (transaction: string, body = "{}"): PayAndFetch => async () => ({
  response: new Response(body, {
    status: 200,
    headers: {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction, network: paymentNetwork, payer: fixedAddress(5) }),
    },
  }),
  signedRequestsSent: 1,
});
// A 503 before any payment was requested: no signed request.
const unavailable: PayAndFetch = async () => ({ response: new Response('{"error":"SERVICE_UNAVAILABLE"}', { status: 503 }), signedRequestsSent: 0 });

// Stand-in payAndFetchFor: per serviceId, a behaviour and a call counter. No network, no signer.
function standIns(behaviour: Record<string, PayAndFetch>) {
  const calls: Record<string, number> = {};
  const payAndFetchFor = (quote: ServiceQuote): PayAndFetch => async (url) => {
    calls[quote.serviceId] = (calls[quote.serviceId] ?? 0) + 1;
    const inner = behaviour[quote.serviceId];
    if (!inner) throw new Error(`no stand-in for ${quote.serviceId}`);
    return inner(url);
  };
  return { payAndFetchFor, calls };
}

function run(behaviour: Record<string, PayAndFetch>, options: { capabilities?: string[]; candidates?: readonly TenderCandidateInput[]; ledger?: Ledger } = {}) {
  const candidates = options.candidates ?? services;
  const ledger = options.ledger ?? createLedger(rules.sessionBudgetAtomic);
  const { payAndFetchFor, calls } = standIns(behaviour);
  return runProcurement({
    capabilities: options.capabilities ?? [TOKEN, MARKET],
    candidates,
    ledger,
    rules,
    quoteFor: quoteFrom(candidates),
    payAndFetchFor,
    now,
    runId: "run-test",
  }).then((result) => ({ result, ledger, calls }));
}

const PAID_SEQUENCE = [
  "CAPABILITY_REQUIRED",
  "SERVICE_CANDIDATES_FOUND",
  "SERVICE_SELECTED",
  "PROCUREMENT_DECISION_CREATED",
  "POLICY_APPROVED",
  "PAYMENT_REQUIRED",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_SETTLED",
  "RESOURCE_RECEIVED",
  "DELIVERY_VERIFIED",
  "PROCUREMENT_RECEIPT_CREATED",
];

describe("s4-procure", () => {
  it("(1) [token-intelligence, market-intelligence]: A and B1 paid, remaining 41000, 2 receipts, events in order", async () => {
    const hitsBefore = netGuardHits();
    const { result, calls } = await run({ [A]: paid("tx-a"), [B1]: paid("tx-b1") });
    assert.equal(result.stoppedEarly, false);
    assert.equal(result.ledgerRemainingAtomic, 41_000n);
    assert.deepEqual(
      result.receipts.map((receipt) => [receipt.receiptId, receipt.selected.serviceId, receipt.paymentOutcome, receipt.budgetAfterAtomic, receipt.delivered]),
      [
        ["run-test-1", A, "paid", "45000", true],
        ["run-test-2", B1, "paid", "41000", true],
      ],
    );
    assert.deepEqual(result.events.map((event) => event.name), [...PAID_SEQUENCE, ...PAID_SEQUENCE]);
    assert.ok(result.events.every((event) => event.at === "2026-11-07T12:00:00.000Z"));
    assert.deepEqual(result.deliveries.map(({ capability, serviceId, bodyText }) => [capability, serviceId, bodyText]), [
      [TOKEN, A, "{}"],
      [MARKET, B1, "{}"],
    ]);
    assert.deepEqual(result.rounds.map(({ capability, round }) => [capability, round]), [
      [TOKEN, 1],
      [MARKET, 1],
    ]);
    assert.deepEqual(result.unfulfilled, []);
    assert.deepEqual(result.undelivered, []);
    assert.deepEqual(result.reliability, { [A]: { successes: 1, failures: 0 }, [B1]: { successes: 1, failures: 0 } });
    assert.deepEqual(calls, { [A]: 1, [B1]: 1 });
    assert.equal(netGuardHits(), hitsBefore);
  });

  it("(2) B1 answers 503 with no signed request: SERVICE_FAILED, released, FALLBACK_SELECTED, B2 paid, remaining 37000", async () => {
    const { result, ledger, calls } = await run({ [A]: paid("tx-a"), [B1]: unavailable, [B2]: paid("tx-b2") });
    assert.equal(result.ledgerRemainingAtomic, 37_000n);
    assert.equal(result.receipts.length, 3);
    const [, b1Receipt, b2Receipt] = result.receipts;
    assert.equal(b1Receipt.paymentOutcome, "failed-before-payment");
    assert.equal(b1Receipt.isFallback, false);
    assert.equal(b2Receipt.selected.serviceId, B2);
    assert.equal(b2Receipt.paymentOutcome, "paid");
    assert.equal(b2Receipt.isFallback, true);
    assert.equal(ledger.status(keyOf(B1)), undefined, "B1's key is released");
    const market = result.events.filter((event) => event.capability === MARKET).map((event) => event.name);
    assert.deepEqual(market, [
      "CAPABILITY_REQUIRED",
      "SERVICE_CANDIDATES_FOUND",
      "SERVICE_SELECTED",
      "PROCUREMENT_DECISION_CREATED",
      "POLICY_APPROVED",
      "SERVICE_FAILED",
      "PROCUREMENT_RECEIPT_CREATED",
      "SERVICE_CANDIDATES_FOUND",
      "FALLBACK_SELECTED",
      ...PAID_SEQUENCE.slice(3),
    ]);
    assert.deepEqual(result.rounds.filter((round) => round.capability === MARKET).map((round) => round.round), [1, 2]);
    assert.deepEqual(calls, { [A]: 1, [B1]: 1, [B2]: 1 });
    assert.deepEqual(result.reliability[B1], { successes: 0, failures: 1 });
  });

  it("(3) B1 and B2 both 503: each called once, market-intelligence unfulfilled, remaining 45000, not stopped early", async () => {
    const { result, calls } = await run({ [A]: paid("tx-a"), [B1]: unavailable, [B2]: unavailable });
    assert.deepEqual(calls, { [A]: 1, [B1]: 1, [B2]: 1 });
    assert.equal(result.stoppedEarly, false);
    assert.equal(result.ledgerRemainingAtomic, 45_000n);
    assert.equal(result.unfulfilled.length, 1);
    assert.equal(result.unfulfilled[0].capability, MARKET);
    assert.deepEqual(
      result.unfulfilled[0].reasons.map((reason) => (typeof reason === "string" ? reason : [reason.serviceId, reason.reasonCode])),
      [
        [B1, "FAILED_IN_SESSION"],
        [B2, "FAILED_IN_SESSION"],
      ],
    );
    assert.equal(result.receipts.length, 3);
  });

  it("(4) A pending-reconciliation: the run stops, B1 never attempted, stoppedEarly", async () => {
    const { result, calls, ledger } = await run({
      [A]: async () => ({ error: new Error("response lost"), signedRequestsSent: 1 }),
      [B1]: paid("tx-b1"),
    });
    assert.equal(result.stoppedEarly, true);
    assert.deepEqual(calls, { [A]: 1 });
    assert.equal(result.receipts.length, 1);
    assert.equal(result.receipts[0].paymentOutcome, "pending-reconciliation");
    assert.ok(!result.events.some((event) => event.capability === MARKET));
    assert.equal(ledger.status(keyOf(A)), "pending");
    assert.equal(result.ledgerRemainingAtomic, 45_000n);
  });

  it("(5) a cheaper stand-in on a wrong paymentNetwork is SELECTED, rejected before any request, no fallback, no reliability failure", async () => {
    const wrongNetwork: TenderCandidateInput = { ...serviceB1, serviceId: "svc-test-wrong-network", name: "Wrong Network", priceAtomic: 3000n, priceUsd: "$0.003", paymentNetwork: MAINNET };
    const candidates = [...services, wrongNetwork];
    const { result, calls } = await run({ "svc-test-wrong-network": paid("never"), [B1]: paid("tx-b1"), [B2]: paid("tx-b2") }, { capabilities: [MARKET], candidates });
    assert.deepEqual(calls, {}, "no payAndFetch call at all");
    assert.equal(result.receipts.length, 1);
    assert.equal(result.receipts[0].selected.serviceId, "svc-test-wrong-network");
    assert.equal(result.receipts[0].paymentOutcome, "rejected");
    assert.deepEqual(result.receipts[0].policy, { decision: "rejected", code: "WRONG_PAYMENT_NETWORK" });
    assert.deepEqual(result.events.map((event) => event.name), [
      "CAPABILITY_REQUIRED",
      "SERVICE_CANDIDATES_FOUND",
      "SERVICE_SELECTED",
      "PROCUREMENT_DECISION_CREATED",
      "POLICY_REJECTED",
      "PROCUREMENT_RECEIPT_CREATED",
    ]);
    assert.deepEqual(result.reliability, {});
    assert.equal(result.ledgerRemainingAtomic, 50_000n);
    assert.equal(result.unfulfilled.length, 1);
    assert.equal(result.unfulfilled[0].capability, MARKET);
    assert.equal(result.unfulfilled[0].reasons.at(-1), "POLICY_REJECTED: WRONG_PAYMENT_NETWORK");
    assert.deepEqual(
      result.unfulfilled[0].reasons.slice(0, -1),
      result.rounds[0].candidates,
      "that round's Tender candidates, then the policy code",
    );
  });

  it("(6) a capability with no eligible candidate: no purchase call, recorded in unfulfilled", async () => {
    const ledger = createLedger(rules.sessionBudgetAtomic);
    ledger.reserve("seed", 47_000n);
    ledger.commit("seed");
    const { result, calls } = await run({ [A]: paid("tx-a") }, { capabilities: [TOKEN], ledger });
    assert.deepEqual(calls, {});
    assert.equal(result.receipts.length, 0);
    assert.deepEqual(result.events.map((event) => event.name), ["CAPABILITY_REQUIRED", "SERVICE_CANDIDATES_FOUND"]);
    assert.deepEqual(result.unfulfilled.map(({ capability, reasons }) => [capability, reasons.map((reason) => (typeof reason === "string" ? reason : reason.reasonCode))]), [
      [TOKEN, ["OVER_BUDGET"]],
    ]);
    assert.equal(result.ledgerRemainingAtomic, 3000n);
  });

  it("(7) B1 paid with a 200 whose body is not JSON: not delivered, no fallback, undelivered, a reliability failure, remaining 41000", async () => {
    const { result, calls } = await run({ [A]: paid("tx-a"), [B1]: paid("tx-b1", "not json"), [B2]: paid("tx-b2") });
    assert.deepEqual(calls, { [A]: 1, [B1]: 1 }, "B2 is never called");
    const b1Receipt = result.receipts[1];
    assert.equal(b1Receipt.paymentOutcome, "paid");
    assert.equal(b1Receipt.delivered, false);
    assert.equal(Object.hasOwn(b1Receipt, "outputFingerprint"), false);
    assert.ok(!result.events.some((event) => event.serviceId === B1 && event.name === "DELIVERY_VERIFIED"));
    assert.deepEqual(result.undelivered, [{ capability: MARKET, serviceId: B1 }]);
    assert.deepEqual(result.deliveries.map((delivery) => delivery.serviceId), [A]);
    assert.deepEqual(result.reliability[B1], { successes: 0, failures: 1 });
    assert.equal(result.ledgerRemainingAtomic, 41_000n);
    assert.deepEqual(result.unfulfilled, []);
  });
});

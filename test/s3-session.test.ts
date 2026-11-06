import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { paymentNetwork } from "../src/config/networks.ts";
import { runSession, serviceUrlFor, SESSION_METHOD } from "../src/agentflow/run-session.ts";
import type { PayAndFetch } from "../src/payments/purchase.ts";
import * as rules from "../src/policy/rules.ts";
import { createLedger, requestKeyFor } from "../src/policy/session.ts";
import { serviceA, serviceB1, serviceB2, services, type ServiceQuote } from "../src/registry/services.ts";

const fixedAddress = (fill: number) => getBase58Decoder().decode(new Uint8Array(32).fill(fill));
const payTo = fixedAddress(9);

const quoteFor = (serviceId: string): ServiceQuote => {
  const entry = services.find((candidate) => candidate.serviceId === serviceId);
  if (!entry) throw new Error(`unknown service ${serviceId}`);
  return { ...entry, payTo };
};

const keyOf = (serviceId: string) => requestKeyFor(serviceId, SESSION_METHOD, serviceUrlFor(quoteFor(serviceId)));

// A 200 carrying a successful PAYMENT-RESPONSE, built with the x402 encoder; one signed request was sent.
const paid = (transaction: string): PayAndFetch => async () => ({
  response: new Response("{}", {
    status: 200,
    headers: {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction, network: paymentNetwork, payer: fixedAddress(5) }),
    },
  }),
  signedRequestsSent: 1,
});

// Stand-in payAndFetchFor: per serviceId, a behaviour and a call counter. No network, no signer.
function standIns(behaviour: Record<string, PayAndFetch>) {
  const calls: Record<string, number> = {};
  const payAndFetchFor = (quote: ServiceQuote): PayAndFetch => {
    const inner = behaviour[quote.serviceId];
    if (!inner) throw new Error(`no stand-in for ${quote.serviceId}`);
    return async (url) => {
      calls[quote.serviceId] = (calls[quote.serviceId] ?? 0) + 1;
      return inner(url);
    };
  };
  return { payAndFetchFor, calls };
}

const A = serviceA.serviceId;
const B1 = serviceB1.serviceId;
const B2 = serviceB2.serviceId;

describe("s3-session", () => {
  it("plan [A, B1] pays both and ends at remaining 41000", async () => {
    const hitsBefore = netGuardHits();
    const ledger = createLedger(rules.sessionBudgetAtomic);
    const { payAndFetchFor, calls } = standIns({ [A]: paid("tx-a"), [B1]: paid("tx-b1") });
    const result = await runSession({ plan: [A, B1], alternates: {}, ledger, rules, quoteFor, payAndFetchFor });
    assert.equal(result.stoppedEarly, false);
    assert.deepEqual(result.records, [
      { serviceId: A, amountAtomic: 5000n, outcome: "paid", transaction: "tx-a", remainingAfter: 45_000n },
      { serviceId: B1, amountAtomic: 4000n, outcome: "paid", transaction: "tx-b1", remainingAfter: 41_000n },
    ]);
    assert.deepEqual(calls, { [A]: 1, [B1]: 1 });
    assert.equal(ledger.committed(), 9000n);
    assert.equal(ledger.reserved(), 0n);
    assert.equal(ledger.remaining(), 41_000n);
    assert.equal(netGuardHits(), hitsBefore);
  });

  it("B1 answering 503 with no signed request is SERVICE_FAILED, released and never retried; B2 is bought by its own purchase; ends at 37000", async () => {
    const ledger = createLedger(rules.sessionBudgetAtomic);
    const unavailable: PayAndFetch = async () => ({
      response: new Response(JSON.stringify({ error: "SERVICE_UNAVAILABLE", serviceId: B1 }), { status: 503 }),
      signedRequestsSent: 0,
    });
    const { payAndFetchFor, calls } = standIns({ [A]: paid("tx-a"), [B1]: unavailable, [B2]: paid("tx-b2") });
    const result = await runSession({ plan: [A, B1], alternates: { [B1]: B2 }, ledger, rules, quoteFor, payAndFetchFor });
    assert.equal(result.stoppedEarly, false);
    assert.deepEqual(result.records, [
      { serviceId: A, amountAtomic: 5000n, outcome: "paid", transaction: "tx-a", remainingAfter: 45_000n },
      { serviceId: B1, amountAtomic: 4000n, outcome: "failed-before-payment", code: "SERVICE_FAILED", remainingAfter: 45_000n },
      { serviceId: B2, amountAtomic: 8000n, outcome: "paid", transaction: "tx-b2", remainingAfter: 37_000n },
    ]);
    assert.deepEqual(calls, { [A]: 1, [B1]: 1, [B2]: 1 });
    assert.equal(ledger.status(keyOf(B1)), undefined);
    assert.equal(ledger.status(keyOf(B2)), "committed");
    assert.notEqual(keyOf(B1), keyOf(B2));
    assert.equal(ledger.committed(), 13_000n);
    assert.equal(ledger.remaining(), 37_000n);
  });

  it("plan [A, A] rejects the second purchase as DUPLICATE_PURCHASE before any request", async () => {
    const ledger = createLedger(rules.sessionBudgetAtomic);
    const { payAndFetchFor, calls } = standIns({ [A]: paid("tx-a") });
    const result = await runSession({ plan: [A, A], alternates: {}, ledger, rules, quoteFor, payAndFetchFor });
    assert.equal(result.stoppedEarly, false);
    assert.deepEqual(result.records, [
      { serviceId: A, amountAtomic: 5000n, outcome: "paid", transaction: "tx-a", remainingAfter: 45_000n },
      { serviceId: A, amountAtomic: 5000n, outcome: "rejected", code: "DUPLICATE_PURCHASE", remainingAfter: 45_000n },
    ]);
    assert.deepEqual(calls, { [A]: 1 });
    assert.equal(ledger.remaining(), 45_000n);
  });

  it("A ambiguous after a signed request is pending-reconciliation; the session stops, B1 is never attempted, 45000 remain", async () => {
    const ledger = createLedger(rules.sessionBudgetAtomic);
    const { payAndFetchFor, calls } = standIns({
      [A]: async () => ({ error: new Error("response lost"), signedRequestsSent: 1 }),
      [B1]: paid("tx-b1"),
    });
    const result = await runSession({ plan: [A, B1], alternates: { [B1]: B2 }, ledger, rules, quoteFor, payAndFetchFor });
    assert.equal(result.stoppedEarly, true);
    assert.deepEqual(result.records, [
      { serviceId: A, amountAtomic: 5000n, outcome: "pending-reconciliation", code: "PENDING_RECONCILIATION", remainingAfter: 45_000n },
    ]);
    assert.deepEqual(calls, { [A]: 1 });
    assert.equal(ledger.status(keyOf(A)), "pending");
    assert.equal(ledger.reserved(), 5000n);
    assert.equal(ledger.remaining(), 45_000n);
  });
});

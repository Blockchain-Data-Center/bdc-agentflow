import "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { paymentNetwork } from "../src/config/networks.ts";
import * as rules from "../src/policy/rules.ts";
import { createLedger, requestKeyFor } from "../src/policy/session.ts";
import { purchase, type PayAndFetch } from "../src/payments/purchase.ts";
import { serviceA, type ServiceQuote } from "../src/registry/services.ts";

const fixedAddress = (fill: number) => getBase58Decoder().decode(new Uint8Array(32).fill(fill));
const quote: ServiceQuote = { ...serviceA, payTo: fixedAddress(9) };
const url = "http://127.0.0.1:4021/v1/token-intel?mint=JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const key = requestKeyFor(quote.serviceId, "GET", url);

const fresh = () => createLedger(rules.sessionBudgetAtomic);

// A response (200 on success, 402 on failure) carrying a PAYMENT-RESPONSE built with the x402 encoder.
function settledResponse(success: boolean, transaction: string): Response {
  const header = encodePaymentResponseHeader({
    success,
    transaction,
    network: paymentNetwork,
    ...(success ? { payer: fixedAddress(5) } : { errorReason: "test_settlement_failed" }),
  });
  return new Response("{}", { status: success ? 200 : 402, headers: { "PAYMENT-RESPONSE": header } });
}

const buy = (payAndFetch: PayAndFetch, ledger = fresh()) =>
  purchase({ quote, method: "GET", url, ledger, rules, payAndFetch }).then((result) => ({ result, ledger }));

describe("s2-session", () => {
  it("reserve lowers remaining", () => {
    const ledger = fresh();
    ledger.reserve("k", 5000n);
    assert.equal(ledger.remaining(), 45_000n);
    assert.equal(ledger.reserved(), 5000n);
    assert.equal(ledger.status("k"), "reserved");
  });

  it("commit keeps it lowered", () => {
    const ledger = fresh();
    ledger.reserve("k", 5000n);
    ledger.commit("k");
    assert.equal(ledger.remaining(), 45_000n);
    assert.equal(ledger.committed(), 5000n);
    assert.equal(ledger.reserved(), 0n);
    assert.equal(ledger.status("k"), "committed");
  });

  it("release restores it and removes the key", () => {
    const ledger = fresh();
    ledger.reserve("k", 5000n);
    ledger.release("k");
    assert.equal(ledger.remaining(), 50_000n);
    assert.equal(ledger.status("k"), undefined);
  });

  it("a pending amount stays reserved", () => {
    const ledger = fresh();
    ledger.reserve("k", 5000n);
    ledger.markPending("k");
    assert.equal(ledger.status("k"), "pending");
    assert.equal(ledger.reserved(), 5000n);
    assert.equal(ledger.remaining(), 45_000n);
  });

  it("reconcile(key, { settled: true }) on a pending amount commits it", () => {
    const ledger = fresh();
    ledger.reserve("k", 5000n);
    ledger.markPending("k");
    ledger.reconcile("k", { settled: true });
    assert.equal(ledger.status("k"), "committed");
    assert.equal(ledger.committed(), 5000n);
    assert.equal(ledger.remaining(), 45_000n);
  });

  it("reconcile(key, { settled: false }) on a pending amount releases it", () => {
    const ledger = fresh();
    ledger.reserve("k", 5000n);
    ledger.markPending("k");
    ledger.reconcile("k", { settled: false });
    assert.equal(ledger.status("k"), undefined);
    assert.equal(ledger.remaining(), 50_000n);
  });

  it("purchase: { error, signedRequestsSent: 0 } gives failed-before-payment and releases the reservation", async () => {
    const { result, ledger } = await buy(async () => ({ error: new Error("refused before payment"), signedRequestsSent: 0 }));
    assert.equal(result.outcome, "failed-before-payment");
    assert.equal(ledger.status(key), undefined);
    assert.equal(ledger.remaining(), 50_000n);
  });

  it("purchase: success false with an empty transaction gives payment-failed and releases the reservation", async () => {
    const { result, ledger } = await buy(async () => ({ response: settledResponse(false, ""), signedRequestsSent: 1 }));
    assert.deepEqual(result, { outcome: "payment-failed", errorReason: "test_settlement_failed" });
    assert.equal(ledger.status(key), undefined);
    assert.equal(ledger.remaining(), 50_000n);
  });

  it("purchase: success false with a non-empty transaction gives pending-reconciliation and keeps the amount reserved", async () => {
    const { result, ledger } = await buy(async () => ({ response: settledResponse(false, "test-transaction"), signedRequestsSent: 1 }));
    assert.equal(result.outcome, "pending-reconciliation");
    assert.equal(ledger.status(key), "pending");
    assert.equal(ledger.reserved(), 5000n);
    assert.equal(ledger.remaining(), 45_000n);
  });

  it("purchase: { error, signedRequestsSent: 1 } gives pending-reconciliation and keeps the amount reserved", async () => {
    const { result, ledger } = await buy(async () => ({ error: new Error("response lost"), signedRequestsSent: 1 }));
    assert.equal(result.outcome, "pending-reconciliation");
    assert.equal(ledger.status(key), "pending");
    assert.equal(ledger.reserved(), 5000n);
    assert.equal(ledger.remaining(), 45_000n);
  });
});

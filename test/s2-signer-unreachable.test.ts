import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { address, getBase58Decoder } from "@solana/kit";
import type { TransactionSigner } from "@solana/kit";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { paymentAsset, paymentNetwork } from "../src/config/networks.ts";
import * as rules from "../src/policy/rules.ts";
import { createLedger, requestKeyFor } from "../src/policy/session.ts";
import { buildX402Client } from "../src/payments/client.ts";
import { purchase, type PayAndFetch } from "../src/payments/purchase.ts";
import { serviceA, type ServiceQuote } from "../src/registry/services.ts";

const fixedAddress = (fill: number) => getBase58Decoder().decode(new Uint8Array(32).fill(fill));
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const payTo = fixedAddress(9);
const quote: ServiceQuote = { ...serviceA, payTo };
const url = "http://127.0.0.1:4021/v1/token-intel?mint=JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

// A payAndFetch stand-in that only counts its calls; a rejected purchase must never reach it.
function countingPayAndFetch(): { payAndFetch: PayAndFetch; calls: () => number } {
  let calls = 0;
  return {
    payAndFetch: async () => {
      calls += 1;
      return { error: new Error("payAndFetch must not be called"), signedRequestsSent: 0 };
    },
    calls: () => calls,
  };
}

function spySigner(): { signer: TransactionSigner; calls: () => number } {
  let calls = 0;
  const signer: TransactionSigner = {
    address: address(fixedAddress(5)),
    signTransactions: async () => {
      calls += 1;
      return [];
    },
  };
  return { signer, calls: () => calls };
}

function paymentRequiredFor(requirement: PaymentRequirements): PaymentRequired {
  return { x402Version: 2, resource: { url }, accepts: [requirement] };
}

const devnetRequirement: PaymentRequirements = {
  scheme: "exact",
  network: paymentNetwork,
  asset: paymentAsset,
  amount: "5000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: { feePayer: fixedAddress(7) },
};

async function assertRejectedWithoutCall(ledger: ReturnType<typeof createLedger>, buyQuote: ServiceQuote, code: string) {
  const stand = countingPayAndFetch();
  const result = await purchase({ quote: buyQuote, method: "GET", url, ledger, rules, payAndFetch: stand.payAndFetch });
  assert.deepEqual(result, { outcome: "rejected", code });
  assert.equal(stand.calls(), 0);
}

describe("s2-signer-unreachable", () => {
  it("(1) OVER_BUDGET is rejected with payAndFetch called 0 times", async () => {
    const ledger = createLedger(rules.sessionBudgetAtomic);
    ledger.reserve("seed", 46_000n);
    ledger.commit("seed");
    await assertRejectedWithoutCall(ledger, quote, "OVER_BUDGET");
    assert.equal(ledger.remaining(), 4000n);
  });

  it("(2) OVER_SERVICE_CAP is rejected with payAndFetch called 0 times", async () => {
    const ledger = createLedger(rules.sessionBudgetAtomic);
    await assertRejectedWithoutCall(ledger, { ...quote, priceAtomic: 10_001n }, "OVER_SERVICE_CAP");
    assert.equal(ledger.remaining(), 50_000n);
  });

  it("(3) DUPLICATE_PURCHASE is rejected with payAndFetch called 0 times", async () => {
    const ledger = createLedger(rules.sessionBudgetAtomic);
    const key = requestKeyFor(quote.serviceId, "GET", url);
    ledger.reserve(key, quote.priceAtomic);
    ledger.commit(key);
    await assertRejectedWithoutCall(ledger, quote, "DUPLICATE_PURCHASE");
    assert.equal(ledger.remaining(), 45_000n);
  });

  it("(4) a 402 whose only requirement names the Mainnet CAIP-2 is refused by the client: no scheme registered", async () => {
    const spy = spySigner();
    const hitsBefore = netGuardHits();
    const client = buildX402Client({ signer: spy.signer, quote });
    await assert.rejects(
      client.createPaymentPayload(paymentRequiredFor({ ...devnetRequirement, network: MAINNET })),
      /No network\/scheme registered/,
    );
    assert.equal(spy.calls(), 0);
    assert.equal(netGuardHits(), hitsBefore);
  });

  it("(5) a 402 whose only requirement names a non-default asset is refused by the default spend controls", async () => {
    const spy = spySigner();
    const hitsBefore = netGuardHits();
    const client = buildX402Client({ signer: spy.signer, quote });
    await assert.rejects(
      client.createPaymentPayload(paymentRequiredFor({ ...devnetRequirement, asset: fixedAddress(3) })),
      /rejected by spendControls/,
    );
    assert.equal(spy.calls(), 0);
    assert.equal(netGuardHits(), hitsBefore);
  });
});

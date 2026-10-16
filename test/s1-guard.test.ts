import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { address, getBase58Decoder } from "@solana/kit";
import type { TransactionSigner } from "@solana/kit";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { paymentAsset, paymentNetwork } from "../src/config/networks.ts";
import { buildX402Client } from "../src/payments/client.ts";
import { checkRequirement } from "../src/payments/requirement-guard.ts";

const fixedAddress = (fill: number) => getBase58Decoder().decode(new Uint8Array(32).fill(fill));
const payTo = fixedAddress(9);
const feePayer = fixedAddress(7);
const quote = { priceAtomic: 5000n, payTo };

const exactMatch: PaymentRequirements = {
  scheme: "exact",
  network: paymentNetwork,
  asset: paymentAsset,
  amount: "5000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: { feePayer },
};

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
  return { x402Version: 2, resource: { url: "http://127.0.0.1/v1/token-intel" }, accepts: [requirement] };
}

describe("s1-guard", () => {
  it("(1) checkRequirement approves an exact match", () => {
    assert.equal(checkRequirement(quote, exactMatch), undefined);
  });

  it("(2) checkRequirement returns GUARD_SCHEME for a mismatched scheme", () => {
    const result = checkRequirement(quote, { ...exactMatch, scheme: "upto" });
    assert.equal(result?.abort, true);
    assert.match(result!.reason, /^GUARD_SCHEME/);
  });

  it("(3) checkRequirement returns GUARD_NETWORK for a mismatched network", () => {
    const result = checkRequirement(quote, { ...exactMatch, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
    assert.equal(result?.abort, true);
    assert.match(result!.reason, /^GUARD_NETWORK/);
  });

  it("(4) checkRequirement returns GUARD_ASSET for a mismatched asset", () => {
    const result = checkRequirement(quote, { ...exactMatch, asset: fixedAddress(3) });
    assert.equal(result?.abort, true);
    assert.match(result!.reason, /^GUARD_ASSET/);
  });

  it("(5) createPaymentPayload aborts a mismatched amount with GUARD_AMOUNT before signing", async () => {
    const spy = spySigner();
    const hitsBefore = netGuardHits();
    const client = buildX402Client({ signer: spy.signer, quote });
    await assert.rejects(client.createPaymentPayload(paymentRequiredFor({ ...exactMatch, amount: "6000" })), /GUARD_AMOUNT/);
    assert.equal(spy.calls(), 0);
    assert.equal(netGuardHits(), hitsBefore);
  });

  it("(6) createPaymentPayload aborts a mismatched payTo with GUARD_PAYTO before signing", async () => {
    const spy = spySigner();
    const hitsBefore = netGuardHits();
    const client = buildX402Client({ signer: spy.signer, quote });
    await assert.rejects(
      client.createPaymentPayload(paymentRequiredFor({ ...exactMatch, payTo: fixedAddress(4) })),
      /GUARD_PAYTO/,
    );
    assert.equal(spy.calls(), 0);
    assert.equal(netGuardHits(), hitsBefore);
  });
});

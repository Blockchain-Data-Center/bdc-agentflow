import "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { dataNetwork, paymentAsset, paymentNetwork } from "../src/config/networks.ts";
import { evaluate, type Proposal } from "../src/policy/engine.ts";
import * as rules from "../src/policy/rules.ts";
import { createLedger, requestKeyFor } from "../src/policy/session.ts";

const fixedAddress = (fill: number) => getBase58Decoder().decode(new Uint8Array(32).fill(fill));
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

// A proposal for Service A as purchase builds it: $0.005 on Devnet USDC, data from Mainnet.
const proposalA: Proposal = {
  serviceId: "svc-a-token-intel",
  capability: "token-intelligence",
  requestKey: requestKeyFor("svc-a-token-intel", "GET", "http://127.0.0.1:4021/v1/token-intel?mint=JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"),
  paymentNetwork,
  paymentAsset,
  amountAtomic: 5000n,
  payTo: fixedAddress(9),
  dataNetwork,
};

// A second, independently priced proposal ($0.004), as Service B1 will be in S3.
const proposal4000: Proposal = {
  serviceId: "svc-test-4000",
  capability: "market-intelligence",
  requestKey: requestKeyFor("svc-test-4000", "GET", "http://127.0.0.1:4022/v1/test"),
  paymentNetwork,
  paymentAsset,
  amountAtomic: 4000n,
  payTo: fixedAddress(9),
};

const fresh = () => createLedger(rules.sessionBudgetAtomic);

function assertRejected(decision: ReturnType<typeof evaluate>, code: string): void {
  assert.equal(decision.decision, "rejected");
  assert.equal(decision.decision === "rejected" && decision.code, code);
}

describe("s2-policy", () => {
  it("approves a Service A proposal within every rule, and changes nothing in the ledger", () => {
    const ledger = fresh();
    assert.deepEqual(evaluate(proposalA, ledger, rules), { decision: "approved" });
    assert.equal(ledger.remaining(), 50_000n);
    assert.equal(ledger.status(proposalA.requestKey), undefined);
  });

  it("rejects OVER_BUDGET when 46000 is already committed", () => {
    const ledger = fresh();
    ledger.reserve("seed", 46_000n);
    ledger.commit("seed");
    assert.equal(ledger.remaining(), 4000n);
    assertRejected(evaluate(proposalA, ledger, rules), "OVER_BUDGET");
  });

  it("rejects OVER_SERVICE_CAP above 10000", () => {
    assertRejected(evaluate({ ...proposalA, amountAtomic: 10_001n }, fresh(), rules), "OVER_SERVICE_CAP");
  });

  it("rejects WRONG_PAYMENT_NETWORK for a Mainnet payment network, whatever the data network", () => {
    assertRejected(evaluate({ ...proposalA, paymentNetwork: MAINNET }, fresh(), rules), "WRONG_PAYMENT_NETWORK");
    assertRejected(
      evaluate({ ...proposalA, paymentNetwork: MAINNET, dataNetwork: paymentNetwork }, fresh(), rules),
      "WRONG_PAYMENT_NETWORK",
    );
  });

  it("rejects WRONG_PAYMENT_ASSET for any asset other than Devnet USDC", () => {
    assertRejected(evaluate({ ...proposalA, paymentAsset: fixedAddress(3) }, fresh(), rules), "WRONG_PAYMENT_ASSET");
  });

  it("rejects DUPLICATE_PURCHASE when the same key is committed", () => {
    const ledger = fresh();
    ledger.reserve(proposalA.requestKey, proposalA.amountAtomic);
    ledger.commit(proposalA.requestKey);
    assertRejected(evaluate(proposalA, ledger, rules), "DUPLICATE_PURCHASE");
  });

  it("goes 50000 → 45000 → 41000 over two approvals and commits", () => {
    const ledger = fresh();
    assert.equal(ledger.remaining(), 50_000n);
    for (const [proposal, expected] of [
      [proposalA, 45_000n],
      [proposal4000, 41_000n],
    ] as const) {
      assert.deepEqual(evaluate(proposal, ledger, rules), { decision: "approved" });
      ledger.reserve(proposal.requestKey, proposal.amountAtomic);
      ledger.commit(proposal.requestKey);
      assert.equal(ledger.remaining(), expected);
    }
    assert.equal(ledger.committed(), 9000n);
  });

  it("approves a Mainnet dataNetwork with a Devnet paymentNetwork", () => {
    assert.equal(proposalA.dataNetwork, MAINNET);
    assert.equal(proposalA.paymentNetwork, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    assert.deepEqual(evaluate(proposalA, fresh(), rules), { decision: "approved" });
  });
});

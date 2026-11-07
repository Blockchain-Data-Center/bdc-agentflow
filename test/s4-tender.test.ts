import "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTender, type ReliabilitySignal, type TenderCandidate, type TenderCandidateInput } from "../src/agentflow/tender.ts";
import * as rules from "../src/policy/rules.ts";
import { createLedger, type Ledger } from "../src/policy/session.ts";
import { serviceA, serviceB1, serviceB2, services } from "../src/registry/services.ts";

const MARKET = "market-intelligence";
const none = new Set<string>();
const noHistory: ReliabilitySignal = {};

// A ledger with the given amount already committed, seeded only through its own operations.
function ledgerWithRemaining(remaining: bigint): Ledger {
  const ledger = createLedger(rules.sessionBudgetAtomic);
  const spent = rules.sessionBudgetAtomic - remaining;
  if (spent > 0n) {
    ledger.reserve("seed", spent);
    ledger.commit("seed");
  }
  return ledger;
}

const codes = (result: readonly TenderCandidate[]) => result.map(({ serviceId, reasonCode }) => [serviceId, reasonCode]);

// A stand-in market-intelligence entry; only the fields the Tender reads matter.
const standIn = (serviceId: string, priceAtomic: bigint, status = "active"): TenderCandidateInput => ({
  ...serviceB1,
  serviceId,
  name: serviceId,
  priceAtomic,
  priceUsd: `${priceAtomic} atomic`,
  status,
});

describe("s4-tender", () => {
  it("(1) market-intelligence with the registry: B1 SELECTED, B2 RANKED_LOWER, A not listed, each with reason text", () => {
    const result = runTender({ capability: MARKET, candidates: services, ledger: ledgerWithRemaining(50_000n), rules, failed: none, reliability: noHistory });
    assert.deepEqual(codes(result), [
      [serviceB1.serviceId, "SELECTED"],
      [serviceB2.serviceId, "RANKED_LOWER"],
    ]);
    assert.ok(!result.some((candidate) => candidate.serviceId === serviceA.serviceId));
    for (const candidate of result) {
      assert.match(candidate.reasonText, /^\S.*\.$/, "one sentence");
      assert.ok(candidate.reasonText.includes(candidate.name));
    }
    assert.deepEqual(
      result.map(({ priceAtomic, priceUsd }) => [priceAtomic, priceUsd]),
      [
        [4000n, "$0.004"],
        [8000n, "$0.008"],
      ],
    );
  });

  it("(2) B1 in the failed set: B1 FAILED_IN_SESSION, B2 SELECTED", () => {
    const result = runTender({
      capability: MARKET,
      candidates: services,
      ledger: ledgerWithRemaining(45_000n),
      rules,
      failed: new Set([serviceB1.serviceId]),
      reliability: { [serviceB1.serviceId]: { successes: 0, failures: 1 } },
    });
    assert.deepEqual(codes(result), [
      [serviceB2.serviceId, "SELECTED"],
      [serviceB1.serviceId, "FAILED_IN_SESSION"],
    ]);
  });

  it("(3) remaining 5000: B2 OVER_BUDGET, B1 SELECTED; remaining 3000: both OVER_BUDGET, no SELECTED", () => {
    const at5000 = runTender({ capability: MARKET, candidates: services, ledger: ledgerWithRemaining(5000n), rules, failed: none, reliability: noHistory });
    assert.deepEqual(codes(at5000), [
      [serviceB1.serviceId, "SELECTED"],
      [serviceB2.serviceId, "OVER_BUDGET"],
    ]);
    const at3000 = runTender({ capability: MARKET, candidates: services, ledger: ledgerWithRemaining(3000n), rules, failed: none, reliability: noHistory });
    assert.deepEqual(codes(at3000), [
      [serviceB1.serviceId, "OVER_BUDGET"],
      [serviceB2.serviceId, "OVER_BUDGET"],
    ]);
    assert.ok(!at3000.some((candidate) => candidate.reasonCode === "SELECTED"));
  });

  it("(4) a stand-in priced 11000 is OVER_SERVICE_CAP, a stand-in with status paused is NOT_ACTIVE", () => {
    const candidates = [standIn("svc-test-over-cap", 11_000n), standIn("svc-test-paused", 1000n, "paused"), serviceB1];
    const result = runTender({ capability: MARKET, candidates, ledger: ledgerWithRemaining(50_000n), rules, failed: none, reliability: noHistory });
    assert.deepEqual(codes(result), [
      [serviceB1.serviceId, "SELECTED"],
      ["svc-test-over-cap", "OVER_SERVICE_CAP"],
      ["svc-test-paused", "NOT_ACTIVE"],
    ]);
  });

  it("(5) at the same price: fewer failures wins, then more successes, then the lower serviceId; deterministic, ledger unchanged", () => {
    const x = standIn("svc-test-x", 4000n);
    const y = standIn("svc-test-y", 4000n);
    const ledger = ledgerWithRemaining(50_000n);
    const run = (reliability: ReliabilitySignal) =>
      runTender({ capability: MARKET, candidates: [y, x], ledger, rules, failed: none, reliability });

    const byFailures = run({ "svc-test-x": { successes: 5, failures: 1 }, "svc-test-y": { successes: 0, failures: 0 } });
    assert.deepEqual(codes(byFailures), [
      ["svc-test-y", "SELECTED"],
      ["svc-test-x", "RANKED_LOWER"],
    ]);
    const bySuccesses = run({ "svc-test-x": { successes: 1, failures: 0 }, "svc-test-y": { successes: 2, failures: 0 } });
    assert.deepEqual(codes(bySuccesses), [
      ["svc-test-y", "SELECTED"],
      ["svc-test-x", "RANKED_LOWER"],
    ]);
    const byServiceId = run({});
    assert.deepEqual(codes(byServiceId), [
      ["svc-test-x", "SELECTED"],
      ["svc-test-y", "RANKED_LOWER"],
    ]);

    assert.deepEqual(run({}), byServiceId, "the same inputs give the same output");
    assert.equal(ledger.remaining(), 50_000n);
    assert.equal(ledger.committed(), 0n);
    assert.equal(ledger.reserved(), 0n);
  });
});

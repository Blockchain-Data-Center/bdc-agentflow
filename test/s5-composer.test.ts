import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeError, type Complete, type CompleteRequest } from "../src/llm/claude.ts";
import { BUDGET_LINE, DETERMINISTIC_SUMMARY_LABEL, composeResult } from "../src/agentflow/composer.ts";
import type { Plan } from "../src/agentflow/planner.ts";
import type { Delivery } from "../src/agentflow/procure.ts";
import type { ProcurementReceipt } from "../src/agentflow/receipt.ts";

const GOAL = "Create a Solana token risk and market intelligence report. Maximum budget: $0.05.";
const now = () => new Date("2026-11-07T12:00:00.000Z");
// Stand-in wallet addresses and payment evidence; none may reach the LLM.
const BUYER = "BuyerStandInAddress1111111111111111111111111";
const SELLER = "SellerStandInAddress111111111111111111111111";
const SIGNATURE = "StandInSignature5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REQUEST_FP = "a".repeat(64);
const OUTPUT_FP_A = "b".repeat(64);
const OUTPUT_FP_B = "c".repeat(64);

const plan: Plan = {
  interpretation: "A risk and market report on JUP.",
  capabilities: ["token-intelligence", "market-intelligence"],
  token: "JUP",
  unsupported: ["news sentiment"],
  planSource: "llm",
};

const bodyA = {
  serviceId: "svc-a-token-intel",
  capability: "token-intelligence",
  mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  supplyUi: "6861485940.010714",
  largestAccounts: [{ address: "LargestTokenAccount1111111111111111111111111", amountUi: "1700000000.10888" }],
  top10TokenAccountSharePct: 61.25,
  dataStatus: "cached fallback",
  asOf: "2026-10-16T23:08:54.089Z",
  source: "Helius Mainnet RPC (getTokenSupply, getTokenLargestAccounts)",
  fallbackCause: "getTokenLargestAccounts failed: rpc-error",
};
const bodyB = {
  serviceId: "svc-b1-market-intel",
  capability: "market-intelligence",
  mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  priceUsd: 0.2447941616415981,
  priceChange24hPct: 1.656633246459385,
  dataStatus: "snapshot",
  asOf: "2026-11-06T22:31:26.223Z",
  source: "Jupiter Price API V3",
};
const deliveries: Delivery[] = [
  { capability: "token-intelligence", serviceId: "svc-a-token-intel", bodyText: JSON.stringify(bodyA), body: bodyA },
  { capability: "market-intelligence", serviceId: "svc-b1-market-intel", bodyText: JSON.stringify(bodyB), body: bodyB },
];

const receipt = (n: number, capability: string, serviceId: string, priceAtomic: string, priceUsd: string, outputFingerprint: string): ProcurementReceipt => ({
  receiptId: `run-test-${n}`,
  createdAt: "2026-11-07T12:00:00.000Z",
  capability,
  candidates: [{ serviceId, priceUsd, reasonCode: "SELECTED", reasonText: `${serviceId} is selected.` }],
  selected: { serviceId, name: serviceId, reasonText: `${serviceId} is selected.` },
  quotedPriceAtomic: priceAtomic,
  quotedPriceUsd: priceUsd,
  policy: { decision: "approved" },
  budgetBeforeAtomic: "50000",
  budgetAfterAtomic: "45000",
  paymentOutcome: "paid",
  transaction: SIGNATURE,
  explorerUrl: `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`,
  delivered: true,
  requestFingerprint: REQUEST_FP,
  outputFingerprint,
  isFallback: false,
});
const receipts = [
  receipt(1, "token-intelligence", "svc-a-token-intel", "5000", "$0.005", OUTPUT_FP_A),
  receipt(2, "market-intelligence", "svc-b1-market-intel", "4000", "$0.004", OUTPUT_FP_B),
];

function standInLlm(answer: string | Error) {
  const requests: CompleteRequest[] = [];
  const llm: Complete = async (request) => {
    requests.push(request);
    if (answer instanceof Error) throw answer;
    return { text: answer, usage: { inputTokens: 900, outputTokens: 300 } };
  };
  return { llm, requests };
}

describe("s5-composer", () => {
  it("(1) the LLM request carries the goal, the bodies and the receipts summary, and no address, signature or fingerprint; its text is the result", async () => {
    const hitsBefore = netGuardHits();
    const { llm, requests } = standInLlm("  JUP report: the token data is a cached fallback; the price is a snapshot.  ");
    const composed = await composeResult({ goal: GOAL, plan, deliveries, receipts, llm, llmOff: false, now });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].maxTokens, 4000);
    assert.equal(requests[0].jsonSchema, undefined);
    const sent = JSON.parse(requests[0].user);
    assert.deepEqual(sent, {
      goal: GOAL,
      interpretation: plan.interpretation,
      unsupported: ["news sentiment"],
      deliveries: [
        { capability: "token-intelligence", serviceId: "svc-a-token-intel", body: bodyA },
        { capability: "market-intelligence", serviceId: "svc-b1-market-intel", body: bodyB },
      ],
      purchases: [
        { capability: "token-intelligence", serviceId: "svc-a-token-intel", quotedPriceUsd: "$0.005", paymentOutcome: "paid", isFallback: false },
        { capability: "market-intelligence", serviceId: "svc-b1-market-intel", quotedPriceUsd: "$0.004", paymentOutcome: "paid", isFallback: false },
      ],
    });
    const everything = `${requests[0].system}\n${requests[0].user}`;
    for (const hidden of [BUYER, SELLER, "payTo", SIGNATURE, "explorer.solana.com", REQUEST_FP, OUTPUT_FP_A, OUTPUT_FP_B, "Fingerprint", "transaction"]) {
      assert.ok(!everything.includes(hidden), `the LLM request carries ${hidden}`);
    }
    assert.match(requests[0].system, /cached fallback/);
    assert.match(requests[0].system, /snapshot/);
    assert.match(requests[0].system, /250 words/);

    assert.deepEqual(composed.result, {
      text: `JUP report: the token data is a cached fallback; the price is a snapshot.\n\n${BUDGET_LINE}`,
      resultSource: "llm",
    });
    assert.equal(BUDGET_LINE, "Budget text in the goal is not parsed; the policy budget of $0.05 applies.");
    assert.deepEqual(composed.usage, { inputTokens: 900, outputTokens: 300 });
    assert.deepEqual(composed.events, [{ name: "RESULT_COMPOSED", at: "2026-11-07T12:00:00.000Z", detail: "resultSource: llm" }]);
    assert.equal(netGuardHits(), hitsBefore);
  });

  it("(2) a ClaudeError: the template summary, labelled, naming cached fallback and snapshot with asOf; no call when none is needed", async () => {
    const failing = standInLlm(new ClaudeError("timeout", { inputTokens: 0, outputTokens: 0 }));
    const composed = await composeResult({ goal: GOAL, plan, deliveries, receipts, llm: failing.llm, llmOff: false, now });
    assert.equal(failing.requests.length, 1);
    assert.equal(composed.result.resultSource, "deterministic");
    assert.equal(composed.result.label, DETERMINISTIC_SUMMARY_LABEL);
    assert.equal(composed.result.label, "LLM unavailable — deterministic summary");
    assert.equal(composed.result.llmError, "messages failed: timeout");
    assert.deepEqual(composed.result.text.split("\n"), [
      "LLM unavailable — deterministic summary",
      "- token-intelligence, from svc-a-token-intel: supplyUi 6861485940.010714; top10TokenAccountSharePct 61.25 (data status cached fallback, asOf 2026-10-16T23:08:54.089Z).",
      "- market-intelligence, from svc-b1-market-intel: priceUsd 0.2447941616415981; priceChange24hPct 1.656633246459385 (data status snapshot, asOf 2026-11-06T22:31:26.223Z).",
      "Not served by any approved provider: news sentiment.",
      "Total spent: $0.009 Devnet USDC in 2 paid purchases.",
      "",
      BUDGET_LINE,
    ]);
    assert.deepEqual(composed.events, [{ name: "RESULT_COMPOSED", at: "2026-11-07T12:00:00.000Z", detail: "resultSource: deterministic" }]);

    // llmOff: the same labelled template, with no call.
    const off = standInLlm("never used");
    const offResult = await composeResult({ goal: GOAL, plan, deliveries, receipts, llm: off.llm, llmOff: true, now });
    assert.equal(off.requests.length, 0);
    assert.equal(offResult.result.label, DETERMINISTIC_SUMMARY_LABEL);
    assert.equal(offResult.result.llmError, undefined);
    assert.deepEqual(offResult.usage, { inputTokens: 0, outputTokens: 0 });

    // No call needed (R11): no delivery, a refused plan, an empty plan; none labelled.
    const unused = standInLlm("never used");
    const none = await composeResult({ goal: GOAL, plan, deliveries: [], receipts: [], llm: unused.llm, llmOff: false, now });
    assert.deepEqual(none.result, {
      text: `No resource was delivered.\nNot obtained: token-intelligence, market-intelligence.\nNot served by any approved provider: news sentiment.\nTotal spent: $0 Devnet USDC in 0 paid purchases.\n\n${BUDGET_LINE}`,
      resultSource: "deterministic",
    });
    const refused = await composeResult({
      goal: "Report on BONK",
      plan: { ...plan, capabilities: [], token: "BONK", refusal: "No approved provider serves BONK; AgentFlow buys nothing." },
      deliveries: [],
      receipts: [],
      llm: unused.llm,
      llmOff: false,
      now,
    });
    assert.deepEqual(refused.result, { text: `No approved provider serves BONK; AgentFlow buys nothing.\n\n${BUDGET_LINE}`, resultSource: "deterministic" });
    const empty = await composeResult({ goal: "Book a flight", plan: { ...plan, capabilities: [] }, deliveries: [], receipts: [], llm: unused.llm, llmOff: false, now });
    assert.deepEqual(empty.result, {
      text: `No capability in the approved registry serves this goal; AgentFlow buys nothing.\n\n${BUDGET_LINE}`,
      resultSource: "deterministic",
    });
    assert.equal(unused.requests.length, 0);
  });
});

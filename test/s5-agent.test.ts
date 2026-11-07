import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { paymentNetwork } from "../src/config/networks.ts";
import { BUDGET_LINE } from "../src/agentflow/composer.ts";
import { runAgent } from "../src/agentflow/run-agent.ts";
import type { Complete, CompleteRequest } from "../src/llm/claude.ts";
import type { PayAndFetch } from "../src/payments/purchase.ts";
import * as rules from "../src/policy/rules.ts";
import { createLedger } from "../src/policy/session.ts";
import { serviceA, serviceB1, services, type ServiceQuote } from "../src/registry/services.ts";

const DEMO_GOAL = "Create a Solana token risk and market intelligence report. Maximum budget: $0.05.";
const fixedAddress = (fill: number) => getBase58Decoder().decode(new Uint8Array(32).fill(fill));
const payTo = fixedAddress(9);
const now = () => new Date("2026-11-07T12:00:00.000Z");

const quoteFor = (serviceId: string): ServiceQuote => {
  const entry = services.find((candidate) => candidate.serviceId === serviceId);
  if (!entry) throw new Error(`unknown service ${serviceId}`);
  return { ...entry, payTo };
};

// A 200 carrying a successful PAYMENT-RESPONSE and a JSON body; one signed request was sent.
const paid = (transaction: string, body: Record<string, unknown>): PayAndFetch => async () => ({
  response: new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction, network: paymentNetwork, payer: fixedAddress(5) }),
    },
  }),
  signedRequestsSent: 1,
});

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

// A stand-in LLM: the planner's call (with a schema) gets the given plan reply, the composer's call the report.
function standInLlm(planReply: Record<string, unknown>, report: string) {
  const requests: CompleteRequest[] = [];
  const llm: Complete = async (request) => {
    requests.push(request);
    return request.jsonSchema
      ? { text: JSON.stringify(planReply), usage: { inputTokens: 100, outputTokens: 50 } }
      : { text: report, usage: { inputTokens: 700, outputTokens: 200 } };
  };
  return { llm, requests };
}

describe("s5-agent", () => {
  it("(1) plan → two purchases → composed result; events start with PLAN_CREATED and end with RESULT_COMPOSED", async () => {
    const hitsBefore = netGuardHits();
    const { llm, requests } = standInLlm(
      { interpretation: "A risk and market report on JUP.", capabilities: ["token-intelligence", "market-intelligence"], token: "JUP", unsupported: [] },
      "JUP report from cached fallback and snapshot data.",
    );
    const { payAndFetchFor, calls } = standIns({
      [serviceA.serviceId]: paid("tx-a", { serviceId: serviceA.serviceId, dataStatus: "live", asOf: "2026-11-07T11:59:00.000Z" }),
      [serviceB1.serviceId]: paid("tx-b1", { serviceId: serviceB1.serviceId, dataStatus: "snapshot", asOf: "2026-11-06T22:31:26.223Z" }),
    });
    const ledger = createLedger(rules.sessionBudgetAtomic);
    const run = await runAgent({ goal: DEMO_GOAL, llm, llmOff: false, candidates: services, ledger, rules, quoteFor, payAndFetchFor, now, runId: "run-test" });

    assert.deepEqual(run.plan.capabilities, ["token-intelligence", "market-intelligence"]);
    assert.equal(run.plan.planSource, "llm");
    assert.deepEqual(calls, { [serviceA.serviceId]: 1, [serviceB1.serviceId]: 1 });
    assert.deepEqual(
      run.procurement.receipts.map((receipt) => [receipt.selected.serviceId, receipt.paymentOutcome]),
      [
        [serviceA.serviceId, "paid"],
        [serviceB1.serviceId, "paid"],
      ],
    );
    assert.equal(run.procurement.ledgerRemainingAtomic, 41_000n);
    assert.deepEqual(run.result, { text: `JUP report from cached fallback and snapshot data.\n\n${BUDGET_LINE}`, resultSource: "llm" });
    assert.equal(requests.length, 2);
    // The composer saw both delivered bodies.
    assert.equal(JSON.parse(requests[1].user).deliveries.length, 2);
    assert.deepEqual(run.usage, { inputTokens: 800, outputTokens: 250 });

    const names = run.events.map((event) => event.name);
    assert.equal(names[0], "PLAN_CREATED");
    assert.equal(names[names.length - 1], "RESULT_COMPOSED");
    assert.deepEqual(names.slice(1, -1), run.procurement.events.map((event) => event.name));
    assert.equal(names.filter((name) => name === "PAYMENT_SETTLED").length, 2);
    assert.equal(netGuardHits(), hitsBefore);
  });

  it("(2) a refusal plan: no purchase call at all, the refusal returned as the result", async () => {
    const { llm, requests } = standInLlm(
      { interpretation: "A report on BONK.", capabilities: ["token-intelligence", "market-intelligence"], token: "BONK", unsupported: [] },
      "never used",
    );
    const { payAndFetchFor, calls } = standIns({});
    const ledger = createLedger(rules.sessionBudgetAtomic);
    const run = await runAgent({ goal: "Create a risk report on BONK", llm, llmOff: false, candidates: services, ledger, rules, quoteFor, payAndFetchFor, now, runId: "run-test" });

    assert.equal(run.plan.refusal, "No approved provider serves BONK; AgentFlow buys nothing.");
    assert.deepEqual(calls, {}, "no purchase call");
    assert.deepEqual(run.procurement.receipts, []);
    assert.equal(run.procurement.ledgerRemainingAtomic, 50_000n);
    assert.equal(ledger.committed(), 0n);
    assert.deepEqual(run.result, { text: `No approved provider serves BONK; AgentFlow buys nothing.\n\n${BUDGET_LINE}`, resultSource: "deterministic" });
    assert.equal(requests.length, 1, "the planner's call only; the composer makes none");
    assert.deepEqual(
      run.events.map((event) => [event.name, event.detail]),
      [
        ["PLAN_CREATED", "planSource: llm; refused: BONK"],
        ["RESULT_COMPOSED", "resultSource: deterministic"],
      ],
    );
  });
});

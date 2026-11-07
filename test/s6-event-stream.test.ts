import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { paymentNetwork } from "../src/config/networks.ts";
import type { AgentEvent } from "../src/agentflow/events.ts";
import { runProcurement } from "../src/agentflow/procure.ts";
import { runAgent } from "../src/agentflow/run-agent.ts";
import type { Complete } from "../src/llm/claude.ts";
import type { PayAndFetch } from "../src/payments/purchase.ts";
import * as policyRules from "../src/policy/rules.ts";
import { createLedger } from "../src/policy/session.ts";
import { serviceA, serviceB1, serviceB2, services, type ServiceQuote } from "../src/registry/services.ts";

const fixedAddress = (fill: number) => getBase58Decoder().decode(new Uint8Array(32).fill(fill));
const payTo = fixedAddress(9);
const now = () => new Date("2026-11-07T12:00:00.000Z");
const A = serviceA.serviceId;
const B1 = serviceB1.serviceId;
const B2 = serviceB2.serviceId;

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
// A 503 before any payment was requested: no signed request.
const unavailable: PayAndFetch = async () => ({ response: new Response('{"error":"SERVICE_UNAVAILABLE"}', { status: 503 }), signedRequestsSent: 0 });

// The S4 fallback scenario: A paid, B1 unavailable, B2 paid. Fresh responses for every run.
const fallbackScenario = (): ((quote: ServiceQuote) => PayAndFetch) => {
  const behaviour: Record<string, PayAndFetch> = {
    [A]: paid("tx-a", { serviceId: A, dataStatus: "live", asOf: "2026-11-07T11:59:00.000Z" }),
    [B1]: unavailable,
    [B2]: paid("tx-b2", { serviceId: B2, dataStatus: "snapshot", asOf: "2026-11-06T22:31:26.223Z" }),
  };
  return (quote) => behaviour[quote.serviceId];
};

const procure = (onEvent?: (event: AgentEvent) => void) =>
  runProcurement({
    capabilities: ["token-intelligence", "market-intelligence"],
    candidates: services,
    ledger: createLedger(policyRules.sessionBudgetAtomic),
    rules: policyRules,
    quoteFor,
    payAndFetchFor: fallbackScenario(),
    now,
    runId: "run-test",
    ...(onEvent !== undefined ? { onEvent } : {}),
  });

describe("s6-event-stream", () => {
  it("(1) runProcurement with onEvent over the S4 fallback scenario: the callback sequence equals the returned events; the result is unchanged by it", async () => {
    const hitsBefore = netGuardHits();
    const seen: AgentEvent[] = [];
    const withListener = await procure((event) => seen.push(event));
    assert.equal(withListener.ledgerRemainingAtomic, 37_000n);
    assert.ok(seen.some((event) => event.name === "FALLBACK_SELECTED"));
    assert.deepEqual(seen, withListener.events);

    const without = await procure();
    assert.deepEqual(without, withListener);

    // A listener that throws is ignored: the purchases and receipts are the same.
    let calls = 0;
    const throwing = await procure(() => {
      calls += 1;
      throw new Error("listener failure");
    });
    assert.equal(calls, withListener.events.length);
    assert.deepEqual(throwing, withListener);
    assert.equal(netGuardHits(), hitsBefore);
  });

  it("(2) runAgent with onEvent: PLAN_CREATED first, RESULT_COMPOSED last, the sequence equal to events; a session budget of 8000 gives the session-budget line", async () => {
    const llm: Complete = async (request) =>
      request.jsonSchema
        ? { text: JSON.stringify({ interpretation: "A risk and market report on JUP.", capabilities: ["token-intelligence", "market-intelligence"], token: "JUP", unsupported: [] }), usage: { inputTokens: 100, outputTokens: 50 } }
        : { text: "JUP report from live and snapshot data.", usage: { inputTokens: 700, outputTokens: 200 } };
    const rules = { ...policyRules, sessionBudgetAtomic: 8000n };
    const seen: AgentEvent[] = [];
    const run = await runAgent({
      goal: "Create a Solana token risk and market intelligence report. Maximum budget: $0.05.",
      llm,
      llmOff: false,
      candidates: services,
      ledger: createLedger(8000n),
      rules,
      quoteFor,
      payAndFetchFor: fallbackScenario(),
      now,
      runId: "run-test",
      onEvent: (event) => seen.push(event),
    });
    assert.equal(seen[0].name, "PLAN_CREATED");
    assert.equal(seen[seen.length - 1].name, "RESULT_COMPOSED");
    assert.deepEqual(seen, run.events);
    assert.ok(run.result.text.endsWith("\n\nBudget text in the goal is not parsed; the session budget of $0.008 set in the UI applies (policy ceiling $0.05)."));
  });
});

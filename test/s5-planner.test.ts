import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeError, type Complete, type CompleteRequest } from "../src/llm/claude.ts";
import { DETERMINISTIC_PLAN_LABEL, NO_TOKEN_NAMED, PLAN_SCHEMA, planTask } from "../src/agentflow/planner.ts";
import { services } from "../src/registry/services.ts";
import { JUP_MINT } from "../src/services/token-intel.ts";

const DEMO_GOAL = "Create a Solana token risk and market intelligence report. Maximum budget: $0.05.";
const now = () => new Date("2026-11-07T12:00:00.000Z");
const usage = { inputTokens: 120, outputTokens: 80 };

// A stand-in LLM: records each request and answers with the given text (or throws). No network.
function standInLlm(answer: string | Error) {
  const requests: CompleteRequest[] = [];
  const llm: Complete = async (request) => {
    requests.push(request);
    if (answer instanceof Error) throw answer;
    return { text: answer, usage };
  };
  return { llm, requests };
}
const reply = (fields: Record<string, unknown>) => JSON.stringify({ interpretation: "A JUP report.", capabilities: [], token: "", unsupported: [], ...fields });
const plan = (goal: string, llm: Complete | undefined, llmOff = false) => planTask({ goal, candidates: services, llm, llmOff, now });

describe("s5-planner", () => {
  it("(1) a valid reply for the demo goal: both capabilities in registry order, token JUP, PLAN_CREATED with planSource llm", async () => {
    const hitsBefore = netGuardHits();
    const { llm, requests } = standInLlm(
      reply({ interpretation: "A risk and market report on JUP.", capabilities: ["Market-Intelligence", "token-intelligence", "market-intelligence"], token: "JUP" }),
    );
    const result = await plan(DEMO_GOAL, llm);
    assert.deepEqual(result.plan, {
      interpretation: "A risk and market report on JUP.",
      capabilities: ["token-intelligence", "market-intelligence"],
      token: "JUP",
      unsupported: [],
      planSource: "llm",
    });
    assert.deepEqual(result.usage, usage);
    assert.deepEqual(result.events, [
      { name: "PLAN_CREATED", at: "2026-11-07T12:00:00.000Z", detail: "planSource: llm; capabilities: token-intelligence, market-intelligence; token JUP" },
    ]);
    // One call: the goal, the registry's capabilities and names only, the schema, 4000 tokens.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].user, DEMO_GOAL);
    assert.equal(requests[0].maxTokens, 4000);
    assert.deepEqual(requests[0].jsonSchema, PLAN_SCHEMA);
    for (const entry of services) assert.ok(requests[0].system.includes(`${entry.capability} (${entry.name})`));
    for (const entry of services) {
      for (const hidden of [entry.priceUsd, String(entry.priceAtomic), entry.paymentAsset, entry.serviceId]) {
        assert.ok(!requests[0].system.includes(hidden) && !requests[0].user.includes(hidden), `the request carries ${hidden}`);
      }
    }
    // An unknown capability moves to unsupported; the mint is JUP.
    const mixed = await plan(DEMO_GOAL, standInLlm(reply({ capabilities: ["token-intelligence", "wallet-scoring"], token: JUP_MINT, unsupported: ["news"] })).llm);
    assert.deepEqual(mixed.plan.capabilities, ["token-intelligence"]);
    assert.deepEqual(mixed.plan.unsupported, ["news", "wallet-scoring"]);
    assert.equal(mixed.plan.token, "JUP");
    assert.equal(netGuardHits(), hitsBefore);
  });

  it("(2) a reply naming BONK is refused with no capability; an empty token gives JUP and the stated sentence", async () => {
    const refused = await plan("Report on BONK", standInLlm(reply({ capabilities: ["token-intelligence", "market-intelligence"], token: "BONK" })).llm);
    assert.deepEqual(refused.plan.capabilities, []);
    assert.equal(refused.plan.token, "BONK");
    assert.equal(refused.plan.refusal, "No approved provider serves BONK; AgentFlow buys nothing.");
    assert.equal(refused.plan.planSource, "llm");
    assert.equal(refused.events[0].detail, "planSource: llm; refused: BONK");

    const unnamed = await plan(DEMO_GOAL, standInLlm(reply({ interpretation: "A Solana token report.", capabilities: ["token-intelligence"], token: "" })).llm);
    assert.equal(unnamed.plan.token, "JUP");
    assert.equal(unnamed.plan.refusal, undefined);
    assert.deepEqual(unnamed.plan.capabilities, ["token-intelligence"]);
    assert.equal(unnamed.plan.interpretation, `A Solana token report. ${NO_TOKEN_NAMED}`);
    assert.equal(NO_TOKEN_NAMED, "No token named; the approved providers serve JUP.");
  });

  it("(3) a reply that is not JSON, or fails the schema, or a ClaudeError: the deterministic plan, labelled", async () => {
    const cases: [string | Error, string][] = [
      ["not json at all", "invalid planner reply: not JSON"],
      [JSON.stringify({ interpretation: "x", capabilities: "token-intelligence", token: "", unsupported: [] }), "invalid planner reply: does not match the schema"],
      [JSON.stringify({ interpretation: "x", capabilities: [], token: "" }), "invalid planner reply: does not match the schema"],
      [reply({ extra: true }), "invalid planner reply: does not match the schema"],
      [new ClaudeError("HTTP 401"), "messages failed: HTTP 401"],
    ];
    for (const [answer, llmError] of cases) {
      const result = await plan(DEMO_GOAL, standInLlm(answer).llm);
      assert.equal(result.plan.planSource, "deterministic", llmError);
      assert.equal(result.plan.label, DETERMINISTIC_PLAN_LABEL);
      assert.equal(result.plan.label, "LLM unavailable — deterministic plan");
      assert.equal(result.plan.llmError, llmError);
      assert.deepEqual(result.plan.capabilities, ["token-intelligence", "market-intelligence"]);
      assert.equal(result.plan.token, "JUP");
      assert.match(result.plan.interpretation, /assumes the demo token JUP/);
      assert.equal(result.events[0].detail, "planSource: deterministic; capabilities: token-intelligence, market-intelligence; token JUP");
    }
    // A failed call's token counts are kept.
    const counted = await plan(DEMO_GOAL, standInLlm(new ClaudeError("max-tokens", { inputTokens: 50, outputTokens: 4000 })).llm);
    assert.deepEqual(counted.usage, { inputTokens: 50, outputTokens: 4000 });
  });

  it("(4) llmOff: the deterministic plan with zero calls; the keyword rules; BONK refused, the demo goal JUP (FD-25)", async () => {
    const { llm, requests } = standInLlm(reply({ capabilities: ["token-intelligence"], token: "JUP" }));
    const off = await plan(DEMO_GOAL, llm, true);
    assert.equal(requests.length, 0, "no call with llmOff");
    assert.deepEqual(off.usage, { inputTokens: 0, outputTokens: 0 });
    assert.equal(off.plan.planSource, "deterministic");
    assert.equal(off.plan.label, DETERMINISTIC_PLAN_LABEL);
    assert.equal(off.plan.llmError, undefined);
    assert.deepEqual(off.plan.capabilities, ["token-intelligence", "market-intelligence"]);
    assert.equal(off.plan.token, "JUP");
    assert.equal(off.plan.refusal, undefined);

    // No client at all takes the same path.
    assert.deepEqual((await plan(DEMO_GOAL, undefined)).plan, off.plan);

    // The keyword rules of S5-Q8 on three goals.
    assert.deepEqual((await plan("Who are the largest holders and what is the supply?", undefined, true)).plan.capabilities, ["token-intelligence"]);
    assert.deepEqual((await plan("What is the current price?", undefined, true)).plan.capabilities, ["market-intelligence"]);
    assert.deepEqual((await plan("Write me a short report", undefined, true)).plan.capabilities, ["token-intelligence", "market-intelligence"]);

    // FD-25: another token is refused; JUP and its mint are not.
    const bonk = await plan("Create a risk report on BONK", undefined, true);
    assert.deepEqual(bonk.plan.capabilities, []);
    assert.equal(bonk.plan.refusal, "No approved provider serves BONK; AgentFlow buys nothing.");
    assert.equal(bonk.plan.label, DETERMINISTIC_PLAN_LABEL);
    const mint = await plan("Supply of DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 please", undefined, true);
    assert.equal(mint.plan.refusal, "No approved provider serves DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263; AgentFlow buys nothing.");
    assert.equal((await plan(`Price and holders of JUP (${JUP_MINT})`, undefined, true)).plan.refusal, undefined);
  });
});

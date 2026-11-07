import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Complete, CompleteRequest } from "../src/llm/claude.ts";
import { BUDGET_LINE, REPORT_REJECTED_LABEL, composeResult } from "../src/agentflow/composer.ts";
import type { Plan } from "../src/agentflow/planner.ts";
import type { Delivery } from "../src/agentflow/procure.ts";
import type { ProcurementReceipt } from "../src/agentflow/receipt.ts";
import { checkReportFigures, collectFigureSources } from "../src/agentflow/report-check.ts";

const GOAL = "Create a Solana token risk and market intelligence report. Maximum budget: $0.05.";
const now = () => new Date("2026-11-07T12:00:00.000Z");

// Fixtures shaped like the real delivered bodies (Service A, Market Intel B1) and the receipts summary.
const bodyA = {
  serviceId: "svc-a-token-intel",
  capability: "token-intelligence",
  dataNetwork: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  decimals: 6,
  supplyUi: "6999215711.06",
  largestAccounts: [
    { address: "LargestTokenAccount1111111111111111111111111", amountUi: "1700000000.10888" },
    { address: "SecondTokenAccount11111111111111111111111111", amountUi: "1000000000" },
  ],
  top10TokenAccountSharePct: 41.37,
  dataStatus: "live",
  asOf: "2026-11-06T22:31:26.223Z",
  source: "Helius Mainnet RPC (getTokenSupply, getTokenLargestAccounts)",
};
const bodyB = {
  serviceId: "svc-b1-market-intel",
  capability: "market-intelligence",
  mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  priceUsd: 0.2447941616415981,
  priceChange24hPct: 1.656633246459385,
  decimals: 6,
  blockId: 466277767,
  dataStatus: "snapshot",
  asOf: "2026-11-06T22:31:26.223Z",
  source: "Jupiter Price API V3",
};
const purchases = [
  { capability: "token-intelligence", serviceId: "svc-a-token-intel", quotedPriceUsd: "$0.005", paymentOutcome: "paid", isFallback: false },
  { capability: "market-intelligence", serviceId: "svc-b1-market-intel", quotedPriceUsd: "$0.004", paymentOutcome: "paid", isFallback: false },
];
const sent = {
  deliveries: [
    { capability: "token-intelligence", serviceId: "svc-a-token-intel", body: bodyA },
    { capability: "market-intelligence", serviceId: "svc-b1-market-intel", body: bodyB },
  ],
  purchases,
};
const sources = collectFigureSources(sent, [GOAL, BUDGET_LINE]);
const unmatchedOf = (text: string) => {
  const check = checkReportFigures(text, sources);
  return check.ok ? [] : check.unmatched;
};

describe("s6-report-check", () => {
  it("(1) figures present in the data pass, with their units; dates, times, bare integers 0–10 and numbers attached to letters are not checked", () => {
    const passing = ["0.24", "$0.2448", "1.66%", "6,999,215,711", "$0.005", "3", "2026-11-06", "6 November 2026", "22:31 UTC", "x402", "24h", "top 10"];
    for (const figure of passing) assert.deepEqual(unmatchedOf(`The report says ${figure} here.`), [], figure);
    const report =
      "JUP traded at $0.2448 (about 0.24), up 1.66% over 24h in the snapshot of 2026-11-06 at 22:31 UTC (6 November 2026). " +
      "Supply is 6,999,215,711 tokens; the top 10 accounts were read over x402 in 3 steps. Token Intel A cost $0.005.";
    assert.deepEqual(checkReportFigures(report, sources), { ok: true });
    // Addresses, mints and names in the data are not sources; the goal's $0.05 is a dollar source.
    assert.deepEqual(unmatchedOf("A budget of $0.05 applies."), []);
    // FD-35 (S6-A1): a time window whose digits are a run inside a source key (priceChange24hPct) passes.
    for (const window of ["over 24 hours", "a 24-hour change", "24 Hours"]) assert.deepEqual(unmatchedOf(`The price moved ${window}.`), [], window);
  });

  it("(2) figures absent from the data, or present only with another unit, are unmatched", () => {
    assert.deepEqual(checkReportFigures("Its market capitalisation is about $1.68 billion, 64% of it held by insiders, and 12.5% is staked.", sources), {
      ok: false,
      unmatched: ["$1.68 billion", "64%", "12.5%"],
    });
    // A $ figure needs a Usd key (or a dollar amount of the goal or budget line); a % figure needs a Pct key.
    assert.deepEqual(unmatchedOf("Supply is $6,999,215,711."), ["$6,999,215,711"]);
    assert.deepEqual(unmatchedOf("The price is 0.24%."), ["0.24%"]);
    // FD-35 (S6-A1): the time-window rule needs the same digits inside a source key, a bare integer and a time word.
    const noWindowKey = collectFigureSources({ priceUsd: 0.2447941616415981 }, []);
    assert.deepEqual(checkReportFigures("It moved over 24 hours.", noWindowKey), { ok: false, unmatched: ["24"] });
    const window24 = collectFigureSources({ priceChange24hPct: 1.656633246459385 }, []);
    for (const [text, figure] of [
      ["It moved over 48 hours.", "48"],
      ["It moved over 24.0 hours.", "24.0"],
      ["It moved $24 hours.", "$24"],
      ["It moved over 24 weeks.", "24"],
    ]) {
      assert.deepEqual(checkReportFigures(text, window24), { ok: false, unmatched: [figure] }, text);
    }
  });

  it("(3) a scaled figure matches within its rounding: 6.999 billion and 7 billion match 6999215711.06; 8 billion and 6.99 billion do not", () => {
    assert.deepEqual(unmatchedOf("Supply is 6.999 billion."), []);
    assert.deepEqual(unmatchedOf("Supply is 7 billion."), []);
    assert.deepEqual(unmatchedOf("Supply is 7B."), []);
    assert.deepEqual(unmatchedOf("Supply is 8 billion."), ["8 billion"], "a scaled 8 is not a bare integer 0–10");
    assert.deepEqual(unmatchedOf("Supply is 6.99 billion."), ["6.99 billion"]);
    // C-AF-5: a whole number is matched within ±0.5 only, also at this magnitude (the float allowance is a few ulps).
    assert.deepEqual(unmatchedOf("Supply is 6,999,215,711."), []);
    assert.deepEqual(unmatchedOf("Supply is 6,999,215,717."), ["6,999,215,717"]);
  });

  it("(4) composeResult: a clean LLM report is kept; a report with an unmatched figure is replaced by the template led by REPORT_REJECTED_LABEL, usage counted", async () => {
    const hitsBefore = netGuardHits();
    const plan: Plan = {
      interpretation: "A risk and market report on JUP.",
      capabilities: ["token-intelligence", "market-intelligence"],
      token: "JUP",
      unsupported: [],
      planSource: "llm",
    };
    const deliveries: Delivery[] = sent.deliveries.map(({ capability, serviceId, body }) => ({ capability, serviceId, bodyText: JSON.stringify(body), body }));
    const receipt = (n: number, capability: string, serviceId: string, priceAtomic: string, priceUsd: string): ProcurementReceipt => ({
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
      delivered: true,
      requestFingerprint: "a".repeat(64),
      isFallback: false,
    });
    const receipts = [receipt(1, "token-intelligence", "svc-a-token-intel", "5000", "$0.005"), receipt(2, "market-intelligence", "svc-b1-market-intel", "4000", "$0.004")];
    const standIn = (report: string) => {
      const requests: CompleteRequest[] = [];
      const llm: Complete = async (request) => {
        requests.push(request);
        return { text: report, usage: { inputTokens: 1500, outputTokens: 400 } };
      };
      return { llm, requests };
    };

    const clean = "JUP was at $0.2448 in a snapshot of 2026-11-06 (up 1.66% over 24h); supply is about 6.999 billion. Token Intel A cost $0.005.";
    const good = standIn(clean);
    const kept = await composeResult({ goal: GOAL, plan, deliveries, receipts, llm: good.llm, llmOff: false, now });
    assert.deepEqual(kept.result, { text: `${clean}\n\n${BUDGET_LINE}`, resultSource: "llm" });
    assert.match(good.requests[0].system, /Use only numbers that appear in the data\. Do not compute new figures/);
    assert.deepEqual(kept.events, [{ name: "RESULT_COMPOSED", at: "2026-11-07T12:00:00.000Z", detail: "resultSource: llm" }]);

    const bad = standIn("JUP trades at $0.2448, a market capitalisation of about $1.68 billion.");
    const rejected = await composeResult({ goal: GOAL, plan, deliveries, receipts, llm: bad.llm, llmOff: false, now });
    assert.equal(bad.requests.length, 1);
    assert.equal(rejected.result.resultSource, "deterministic");
    assert.equal(rejected.result.label, REPORT_REJECTED_LABEL);
    assert.equal(REPORT_REJECTED_LABEL, "LLM report rejected — figures not in purchased data — deterministic summary");
    assert.ok(rejected.result.text.startsWith(`${REPORT_REJECTED_LABEL}\n- token-intelligence, from svc-a-token-intel: `));
    assert.ok(rejected.result.text.endsWith(`Total spent: $0.009 Devnet USDC in 2 paid purchases.\n\n${BUDGET_LINE}`));
    assert.ok(!rejected.result.text.includes("1.68"), "the rejected report's text is not kept");
    assert.ok(rejected.result.llmError?.startsWith("report rejected"));
    assert.equal(rejected.result.llmError, "report rejected: figures not in purchased data: $1.68 billion");
    assert.deepEqual(rejected.usage, { inputTokens: 1500, outputTokens: 400 });
    assert.deepEqual(rejected.events, [{ name: "RESULT_COMPOSED", at: "2026-11-07T12:00:00.000Z", detail: "report rejected: figures not in purchased data" }]);
    assert.equal(netGuardHits(), hitsBefore);
  });
});

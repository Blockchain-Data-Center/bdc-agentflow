// The Result Composer (S5-Q6, S5-Q8, FD-22): the purchased resources → one short report.
// With the LLM (Claude Haiku 5.5): one call that sees only the goal, the plan's interpretation, the unsupported
// needs, the delivered bodies and a summary of the receipts (capability, provider, quoted price, outcome, fallback);
// never a buyer, seller or payTo address, a fingerprint or a signature. Without it: a template summary.
// - a refused plan: the refusal is the result; an empty plan: says it buys nothing; no delivery: the template.
//   None of these makes a call, and none is labelled, since the LLM was not needed (founder, S5 silence 2);
// - --llm-off, no client, or a ClaudeError: the template, labelled "LLM unavailable — deterministic summary".
// Every result ends with the line stating that budget text in the goal is not parsed (R10).
// It reads no environment variable and never sees the signer.
import { ClaudeError, ZERO_USAGE, type ClaudeUsage, type Complete } from "../llm/claude.ts";
import type { AgentEvent } from "./events.ts";
import { EMPTY_PLAN_TEXT, type Plan } from "./planner.ts";
import type { Delivery } from "./procure.ts";
import type { ProcurementReceipt } from "./receipt.ts";

export const DETERMINISTIC_SUMMARY_LABEL = "LLM unavailable — deterministic summary";
export const BUDGET_LINE = "Budget text in the goal is not parsed; the policy budget of $0.05 applies.";
export const COMPOSER_MAX_TOKENS = 4000;

export type ComposedResult = {
  text: string;
  resultSource: "llm" | "deterministic";
  label?: string; // DETERMINISTIC_SUMMARY_LABEL, when the LLM was needed and unavailable
  llmError?: string;
};

export type ComposeResult = { result: ComposedResult; usage: ClaudeUsage; events: AgentEvent[] };

// The figures the template reports, when present in a body (S5-Q8).
const FIGURES = ["supplyUi", "top10TokenAccountSharePct", "priceUsd", "priceChange24hPct"] as const;

const COMPOSER_SYSTEM = [
  "You are the result composer of BDC AgentFlow, an autonomous procurement layer that bought data services for a goal.",
  "Write a short plain-text report, at most about 250 words, that answers the goal from the purchased data given and nothing else.",
  'Name any data whose dataStatus is "cached fallback" or "snapshot" as such, with its asOf time, and never present it as live.',
  "Claim nothing the data does not show. Say plainly what the goal asked for that was not obtained or is unsupported.",
  "Mention the purchases briefly: provider, quoted price, outcome, and whether a provider was a fallback.",
  "Use plain sentences, no Markdown headings or tables.",
].join("\n");

// USDC atomic units (6 decimals) as dollars, e.g. 9000n -> "$0.009".
function usd(atomic: bigint): string {
  const fraction = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `$${atomic / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

const receiptsSummary = (receipts: readonly ProcurementReceipt[]) =>
  receipts.map((receipt) => ({
    capability: receipt.capability,
    serviceId: receipt.selected.serviceId,
    quotedPriceUsd: receipt.quotedPriceUsd,
    paymentOutcome: receipt.paymentOutcome,
    isFallback: receipt.isFallback,
  }));

// The template summary: per delivery, the figures present, the data status and asOf; what was not obtained;
// the unsupported needs; the total spent.
function deterministicSummary(plan: Plan, deliveries: readonly Delivery[], receipts: readonly ProcurementReceipt[]): string[] {
  const lines = deliveries.length === 0 ? ["No resource was delivered."] : [];
  for (const delivery of deliveries) {
    const body = (typeof delivery.body === "object" && delivery.body !== null ? delivery.body : {}) as Record<string, unknown>;
    const figures = FIGURES.filter((field) => body[field] !== undefined && body[field] !== null).map((field) => `${field} ${String(body[field])}`);
    lines.push(
      `- ${delivery.capability}, from ${delivery.serviceId}: ${figures.join("; ") || "no figures"} (data status ${String(body.dataStatus)}, asOf ${String(body.asOf)}).`,
    );
  }
  const obtained = new Set(deliveries.map((delivery) => delivery.capability));
  const missing = plan.capabilities.filter((capability) => !obtained.has(capability));
  if (missing.length > 0) lines.push(`Not obtained: ${missing.join(", ")}.`);
  if (plan.unsupported.length > 0) lines.push(`Not served by any approved provider: ${plan.unsupported.join(", ")}.`);
  const paid = receipts.filter((receipt) => receipt.paymentOutcome === "paid");
  const spent = paid.reduce((sum, receipt) => sum + BigInt(receipt.quotedPriceAtomic), 0n);
  lines.push(`Total spent: ${usd(spent)} Devnet USDC in ${paid.length} paid purchase${paid.length === 1 ? "" : "s"}.`);
  return lines;
}

export async function composeResult({
  goal,
  plan,
  deliveries,
  receipts,
  llm,
  llmOff,
  now,
}: {
  goal: string;
  plan: Plan;
  deliveries: readonly Delivery[];
  receipts: readonly ProcurementReceipt[];
  llm?: Complete;
  llmOff: boolean;
  now: () => Date;
}): Promise<ComposeResult> {
  const withBudgetLine = (text: string) => `${text}\n\n${BUDGET_LINE}`;
  let result: ComposedResult;
  let usage = ZERO_USAGE;

  if (plan.refusal !== undefined) {
    result = { text: withBudgetLine(plan.refusal), resultSource: "deterministic" };
  } else if (plan.capabilities.length === 0) {
    result = { text: withBudgetLine(EMPTY_PLAN_TEXT), resultSource: "deterministic" };
  } else if (deliveries.length === 0) {
    result = { text: withBudgetLine(deterministicSummary(plan, deliveries, receipts).join("\n")), resultSource: "deterministic" };
  } else {
    const labelled = (llmError?: string): ComposedResult => ({
      text: withBudgetLine([DETERMINISTIC_SUMMARY_LABEL, ...deterministicSummary(plan, deliveries, receipts)].join("\n")),
      resultSource: "deterministic",
      label: DETERMINISTIC_SUMMARY_LABEL,
      ...(llmError !== undefined ? { llmError } : {}),
    });
    if (llmOff || llm === undefined) {
      result = labelled();
    } else {
      const user = JSON.stringify(
        {
          goal,
          interpretation: plan.interpretation,
          unsupported: plan.unsupported,
          deliveries: deliveries.map(({ capability, serviceId, body }) => ({ capability, serviceId, body })),
          purchases: receiptsSummary(receipts),
        },
        null,
        2,
      );
      try {
        const reply = await llm({ system: COMPOSER_SYSTEM, user, maxTokens: COMPOSER_MAX_TOKENS });
        usage = reply.usage;
        result = { text: withBudgetLine(reply.text.trim()), resultSource: "llm" };
      } catch (error) {
        // A ClaudeError's message is its status only; any other error is named by its class, never its text.
        if (error instanceof ClaudeError) usage = error.usage;
        result = labelled(error instanceof ClaudeError ? error.message : error instanceof Error ? error.name : typeof error);
      }
    }
  }
  return {
    result,
    usage: { ...usage },
    events: [{ name: "RESULT_COMPOSED", at: now().toISOString(), detail: `resultSource: ${result.resultSource}` }],
  };
}

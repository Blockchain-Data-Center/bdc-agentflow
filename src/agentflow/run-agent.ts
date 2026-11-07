// The Agent Orchestrator (S5-Q9): goal → plan → procurement → composed result.
// The planner proposes capabilities only; runProcurement buys them (the Agent Tender selects each supplier, the
// policy engine authorizes each purchase before anything is signed); the composer reports on what was delivered.
// The LLM never sets or raises the budget ("Maximum budget" in a goal is never parsed: the session budget is the
// policy's, FD-02), never chooses a supplier and never reaches the signer. A refused or empty plan buys nothing.
// It reads no environment variable: llm is the client's complete, or undefined for the deterministic path.
import { addUsage, type ClaudeUsage, type Complete } from "../llm/claude.ts";
import type { PolicyRules } from "../policy/engine.ts";
import type { Ledger } from "../policy/session.ts";
import type { PayAndFetch } from "../payments/purchase.ts";
import type { ServiceQuote } from "../registry/services.ts";
import { composeResult, type ComposedResult } from "./composer.ts";
import type { AgentEvent } from "./events.ts";
import { planTask, type Plan } from "./planner.ts";
import { runProcurement, type ProcurementResult } from "./procure.ts";
import type { TenderCandidateInput } from "./tender.ts";

export type AgentRun = {
  plan: Plan;
  procurement: ProcurementResult;
  result: ComposedResult;
  events: AgentEvent[];
  // The Claude API tokens of the run, failed calls included; not part of the x402 USDC session budget (S5-Q10).
  usage: ClaudeUsage;
};

export async function runAgent({
  goal,
  llm,
  llmOff,
  candidates,
  ledger,
  rules,
  quoteFor,
  payAndFetchFor,
  now,
  runId,
}: {
  goal: string;
  llm: Complete | undefined;
  llmOff: boolean;
  candidates: readonly TenderCandidateInput[];
  ledger: Ledger;
  rules: PolicyRules;
  quoteFor: (serviceId: string) => ServiceQuote;
  payAndFetchFor: (quote: ServiceQuote) => PayAndFetch;
  now: () => Date;
  runId: string;
}): Promise<AgentRun> {
  const planned = await planTask({ goal, candidates, llm, llmOff, now });
  // A refused or empty plan has no capability: runProcurement then makes no purchase call.
  const procurement = await runProcurement({ capabilities: planned.plan.capabilities, candidates, ledger, rules, quoteFor, payAndFetchFor, now, runId });
  const composed = await composeResult({
    goal,
    plan: planned.plan,
    deliveries: procurement.deliveries,
    receipts: procurement.receipts,
    llm,
    llmOff,
    now,
  });
  return {
    plan: planned.plan,
    procurement,
    result: composed.result,
    events: [...planned.events, ...procurement.events, ...composed.events],
    usage: addUsage(planned.usage, composed.usage),
  };
}

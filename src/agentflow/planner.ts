// The Capability Planner (S5-Q5, S5-Q8, FD-23, FD-25): a written goal → the registry capabilities to buy.
// With the LLM (Claude Haiku 5.5): one structured-output call that sees the goal and each registry entry's capability
// and name only (no price, no address); its reply is validated deterministically against the registry. Without it
// (--llm-off, no client, a ClaudeError, an invalid reply): a keyword plan, labelled. On either path a goal naming a
// token no approved provider serves is refused and nothing is planned; the providers serve JUP only.
// The planner only proposes capabilities: the Agent Tender chooses the supplier and the policy engine authorizes.
// It reads no environment variable and never sees the signer.
import { ClaudeError, ZERO_USAGE, type ClaudeUsage, type Complete } from "../llm/claude.ts";
import type { ServiceEntry } from "../registry/services.ts";
import { JUP_MINT } from "../services/token-intel.ts";
import type { AgentEvent } from "./events.ts";

export const DEMO_TOKEN = "JUP";
export const DETERMINISTIC_PLAN_LABEL = "LLM unavailable — deterministic plan";
export const PLANNER_MAX_TOKENS = 4000;
export const NO_TOKEN_NAMED = "No token named; the approved providers serve JUP.";
export const EMPTY_PLAN_TEXT = "No capability in the approved registry serves this goal; AgentFlow buys nothing.";
export const refusalText = (token: string) => `No approved provider serves ${token}; AgentFlow buys nothing.`;

export type Plan = {
  interpretation: string;
  capabilities: string[];
  token: string;
  unsupported: string[];
  refusal?: string;
  planSource: "llm" | "deterministic";
  label?: string; // DETERMINISTIC_PLAN_LABEL, on the deterministic path only
  llmError?: string;
};

export type PlanResult = { plan: Plan; usage: ClaudeUsage; events: AgentEvent[] };

// What the planner may know of a registry entry.
export type PlanCandidate = Pick<ServiceEntry, "capability" | "name">;

// The structured output the LLM must return (R6): all four fields required, nothing else.
export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    interpretation: { type: "string" },
    capabilities: { type: "array", items: { type: "string" } },
    token: { type: "string" },
    unsupported: { type: "array", items: { type: "string" } },
  },
  required: ["interpretation", "capabilities", "token", "unsupported"],
  additionalProperties: false,
} as const;

type PlanReply = { interpretation: string; capabilities: string[]; token: string; unsupported: string[] };

const TOKEN_CAPABILITY = /token|holder|supply|on-?chain|risk/i;
const MARKET_CAPABILITY = /market|price/i;
const UPPER_CASE_WORD = /\b[A-Z]{2,10}\b/g;
const BASE58_STRING = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

// The registry's capabilities, each once, in registry order.
const registryCapabilities = (candidates: readonly PlanCandidate[]) => [...new Set(candidates.map((candidate) => candidate.capability))];

function plannerSystem(candidates: readonly PlanCandidate[]): string {
  const lines = candidates.map((candidate) => `- ${candidate.capability} (${candidate.name})`);
  return [
    "You are the capability planner of BDC AgentFlow, an autonomous procurement layer that buys data services for a goal.",
    "The approved registry offers only these capabilities:",
    ...lines,
    "Read the user's goal and return: interpretation, one or two sentences on what the goal asks for;",
    "capabilities, the registry capabilities the goal needs, written exactly as listed above;",
    "unsupported, anything the goal needs that no listed capability provides;",
    'token, the token symbol or mint address the goal names, or "" when it names no specific token.',
    'A chain or network name such as "Solana" alone is not a token. Never invent a token.',
    "You only propose capabilities: you do not choose providers, prices or budgets.",
  ].join("\n");
}

// The reply as the schema demands, or undefined.
function parseReply(text: string): PlanReply | "not-json" | "schema" {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "not-json";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "schema";
  const reply = value as Record<string, unknown>;
  const keys = Object.keys(reply).sort();
  if (keys.join(",") !== "capabilities,interpretation,token,unsupported") return "schema";
  const strings = (list: unknown) => Array.isArray(list) && list.every((item) => typeof item === "string");
  if (typeof reply.interpretation !== "string" || typeof reply.token !== "string") return "schema";
  if (!strings(reply.capabilities) || !strings(reply.unsupported)) return "schema";
  return reply as PlanReply;
}

// The first token named in the goal that is not the demo token: an upper-case word of 2–10 letters other than JUP,
// or a base58 string of 32–44 characters other than JUP_MINT (FD-25), whichever comes first in the goal.
function otherTokenNamed(goal: string): string | undefined {
  const named = [...goal.matchAll(UPPER_CASE_WORD), ...goal.matchAll(BASE58_STRING)]
    .filter((match) => match[0] !== DEMO_TOKEN && match[0] !== JUP_MINT)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return named[0]?.[0];
}

function deterministicPlan(goal: string, llmError: string | undefined): Plan {
  const base = { planSource: "deterministic" as const, label: DETERMINISTIC_PLAN_LABEL, ...(llmError !== undefined ? { llmError } : {}) };
  const token = otherTokenNamed(goal);
  if (token !== undefined) {
    return {
      interpretation: `Deterministic plan: the goal names the token ${token}.`,
      capabilities: [],
      token,
      unsupported: [],
      refusal: refusalText(token),
      ...base,
    };
  }
  const wantsToken = TOKEN_CAPABILITY.test(goal);
  const wantsMarket = MARKET_CAPABILITY.test(goal);
  const capabilities = [
    ...(wantsToken || !wantsMarket ? ["token-intelligence"] : []),
    ...(wantsMarket || !wantsToken ? ["market-intelligence"] : []),
  ];
  return {
    interpretation: `Deterministic plan from keywords in the goal: ${capabilities.join(" and ")}. It assumes the demo token JUP, the only token the approved providers serve.`,
    capabilities,
    token: DEMO_TOKEN,
    unsupported: [],
    ...base,
  };
}

// The LLM's reply validated against the registry (R6): capabilities compared case-insensitively, unknown ones moved
// to unsupported, de-duplicated and put in registry order; the token checked against JUP (FD-23).
function validatedPlan(reply: PlanReply, registry: readonly string[]): Plan {
  const byLowerCase = new Map(registry.map((capability) => [capability.toLowerCase(), capability]));
  const chosen = new Set<string>();
  const unsupported = [...reply.unsupported];
  for (const requested of reply.capabilities) {
    const known = byLowerCase.get(requested.toLowerCase());
    if (known !== undefined) chosen.add(known);
    else if (!unsupported.includes(requested)) unsupported.push(requested);
  }
  const capabilities = registry.filter((capability) => chosen.has(capability));

  const token = reply.token;
  if (token !== "" && token.toLowerCase() !== DEMO_TOKEN.toLowerCase() && token.toLowerCase() !== JUP_MINT.toLowerCase()) {
    return { interpretation: reply.interpretation, capabilities: [], token, unsupported, refusal: refusalText(token), planSource: "llm" };
  }
  const sentences = [reply.interpretation, ...(token === "" ? [NO_TOKEN_NAMED] : []), ...(capabilities.length === 0 ? [EMPTY_PLAN_TEXT] : [])];
  return { interpretation: sentences.join(" "), capabilities, token: DEMO_TOKEN, unsupported, planSource: "llm" };
}

export async function planTask({
  goal,
  candidates,
  llm,
  llmOff,
  now,
}: {
  goal: string;
  candidates: readonly PlanCandidate[];
  llm?: Complete;
  llmOff: boolean;
  now: () => Date;
}): Promise<PlanResult> {
  let plan: Plan;
  let usage = ZERO_USAGE;
  if (llmOff || llm === undefined) {
    plan = deterministicPlan(goal, undefined);
  } else {
    try {
      const reply = await llm({ system: plannerSystem(candidates), user: goal, maxTokens: PLANNER_MAX_TOKENS, jsonSchema: PLAN_SCHEMA });
      usage = reply.usage;
      const parsed = parseReply(reply.text);
      plan =
        typeof parsed === "string"
          ? deterministicPlan(goal, `invalid planner reply: ${parsed === "not-json" ? "not JSON" : "does not match the schema"}`)
          : validatedPlan(parsed, registryCapabilities(candidates));
    } catch (error) {
      // A ClaudeError's message is its status only; any other error is named by its class, never its text.
      if (error instanceof ClaudeError) usage = error.usage;
      plan = deterministicPlan(goal, error instanceof ClaudeError ? error.message : error instanceof Error ? error.name : typeof error);
    }
  }
  const detail = `planSource: ${plan.planSource}; ${
    plan.refusal !== undefined ? `refused: ${plan.token}` : `capabilities: ${plan.capabilities.join(", ") || "none"}; token ${plan.token}`
  }`;
  return { plan, usage: { ...usage }, events: [{ name: "PLAN_CREATED", at: now().toISOString(), detail }] };
}

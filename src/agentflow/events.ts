// Structured events (S4-Q6): the brief's STRUCTURED EVENTS list, all seventeen names exactly.
// The runner returns them in order. They are derived from the purchase outcome, not observed on the wire.
// S4 emits fourteen of them; PLAN_CREATED and RESULT_COMPOSED belong to S5, and SERVICE_SKIPPED is defined
// but never emitted (the Agent Tender already excludes a failed service).
// No secret and no address other than a public Solana signature ever goes into an event.

export const AGENT_EVENT_NAMES = [
  "PLAN_CREATED",
  "CAPABILITY_REQUIRED",
  "SERVICE_CANDIDATES_FOUND",
  "SERVICE_SELECTED",
  "PROCUREMENT_DECISION_CREATED",
  "PAYMENT_REQUIRED",
  "POLICY_APPROVED",
  "POLICY_REJECTED",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_SETTLED",
  "RESOURCE_RECEIVED",
  "DELIVERY_VERIFIED",
  "SERVICE_FAILED",
  "SERVICE_SKIPPED",
  "FALLBACK_SELECTED",
  "PROCUREMENT_RECEIPT_CREATED",
  "RESULT_COMPOSED",
] as const;

export type AgentEventName = (typeof AGENT_EVENT_NAMES)[number];

// at: now().toISOString(); detail: a short human-readable string.
export type AgentEvent = {
  name: AgentEventName;
  at: string;
  capability?: string;
  serviceId?: string;
  detail?: string;
};

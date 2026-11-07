// The procurement runner (S4-Q3, FD-20): buys by capability, the Agent Tender choosing the supplier.
// For each capability, in the given order (duplicates merged, the first kept):
// - run the Tender; buy its SELECTED candidate through one purchase call (the policy engine first, then payment);
// - failed-before-payment or payment-failed: the service joins the failed set and counts as a reliability
//   failure; the Tender runs again and its new SELECTED is bought (FALLBACK_SELECTED). A failed service is never
//   retried: the Tender excludes it as FAILED_IN_SESSION;
// - rejected: the capability ends with no fallback and no reliability failure (S4-Q12); it is listed in
//   unfulfilled with that round's candidates and the policy code (founder, S4 silence 2);
// - no eligible candidate: no purchase call; the capability is listed in unfulfilled (S4-Q13);
// - pending-reconciliation: the whole run stops at once (stoppedEarly);
// - paid: the body is read once; delivered when HTTP 200 and the text parses as JSON (S4-Q5). A paid resource
//   that is not delivered ends the capability with no fallback, counts as a reliability failure and is listed in
//   undelivered, so a capability is never paid for twice (FD-26).
// One Procurement Decision Receipt per purchase attempt; events in order (S4-Q6), derived from the outcome.
// It reads no environment variable and never sees the signer: payAndFetchFor is built by the caller.
import type { PolicyRules } from "../policy/engine.ts";
import type { Ledger } from "../policy/session.ts";
import { purchase, type PayAndFetch, type PurchaseResult } from "../payments/purchase.ts";
import type { ServiceQuote } from "../registry/services.ts";
import type { AgentEvent, AgentEventName } from "./events.ts";
import { buildReceipt, type ProcurementReceipt } from "./receipt.ts";
import { serviceUrlFor, SESSION_METHOD } from "./run-session.ts";
import { runTender, type ReliabilityCounts, type TenderCandidate, type TenderCandidateInput } from "./tender.ts";

export type TenderRound = { capability: string; round: number; candidates: TenderCandidate[] };
export type Delivery = { capability: string; serviceId: string; bodyText: string; body: unknown };
// The Tender's candidates of the last round; for a policy rejection, also "POLICY_REJECTED: <code>".
export type Unfulfilled = { capability: string; reasons: (TenderCandidate | string)[] };
export type Undelivered = { capability: string; serviceId: string };

export type ProcurementResult = {
  rounds: TenderRound[];
  receipts: ProcurementReceipt[];
  events: AgentEvent[];
  deliveries: Delivery[];
  unfulfilled: Unfulfilled[];
  undelivered: Undelivered[];
  ledgerRemainingAtomic: bigint;
  stoppedEarly: boolean;
  // The run's reliability signal at its end (founder, S4 silence 1).
  reliability: Record<string, ReliabilityCounts>;
};

const describeFailure = (result: PurchaseResult): string =>
  result.outcome === "failed-before-payment"
    ? `failed before payment: ${result.reason}`
    : result.outcome === "payment-failed"
      ? `payment failed: ${result.errorReason ?? "no reason given"}`
      : result.outcome;

export async function runProcurement({
  capabilities,
  candidates,
  ledger,
  rules,
  quoteFor,
  payAndFetchFor,
  now,
  runId,
}: {
  capabilities: readonly string[];
  candidates: readonly TenderCandidateInput[];
  ledger: Ledger;
  rules: PolicyRules;
  quoteFor: (serviceId: string) => ServiceQuote;
  payAndFetchFor: (quote: ServiceQuote) => PayAndFetch;
  now: () => Date;
  runId: string;
}): Promise<ProcurementResult> {
  const rounds: TenderRound[] = [];
  const receipts: ProcurementReceipt[] = [];
  const events: AgentEvent[] = [];
  const deliveries: Delivery[] = [];
  const unfulfilled: Unfulfilled[] = [];
  const undelivered: Undelivered[] = [];
  const failed = new Set<string>();
  const reliability: Record<string, ReliabilityCounts> = {};

  const emit = (name: AgentEventName, fields: Omit<AgentEvent, "name" | "at"> = {}) =>
    void events.push({ name, at: now().toISOString(), ...fields });
  const count = (serviceId: string, outcome: "successes" | "failures") => {
    const counts = (reliability[serviceId] ??= { successes: 0, failures: 0 });
    counts[outcome] += 1;
  };
  const finish = (stoppedEarly: boolean): ProcurementResult => ({
    rounds,
    receipts,
    events,
    deliveries,
    unfulfilled,
    undelivered,
    ledgerRemainingAtomic: ledger.remaining(),
    stoppedEarly,
    reliability: Object.fromEntries(Object.entries(reliability).map(([id, counts]) => [id, { ...counts }])),
  });

  for (const capability of [...new Set(capabilities)]) {
    emit("CAPABILITY_REQUIRED", { capability });

    for (let round = 1; ; round += 1) {
      const tender = runTender({ capability, candidates, ledger, rules, failed, reliability });
      rounds.push({ capability, round, candidates: tender });
      const eligible = tender.filter((candidate) => candidate.reasonCode === "SELECTED" || candidate.reasonCode === "RANKED_LOWER").length;
      emit("SERVICE_CANDIDATES_FOUND", { capability, detail: `round ${round}: ${tender.length} considered, ${eligible} eligible` });

      const selected = tender.find((candidate) => candidate.reasonCode === "SELECTED");
      if (!selected) {
        unfulfilled.push({ capability, reasons: tender });
        break;
      }
      const serviceId = selected.serviceId;
      emit(round === 1 ? "SERVICE_SELECTED" : "FALLBACK_SELECTED", { capability, serviceId, detail: selected.reasonText });

      const quote = quoteFor(serviceId);
      const url = serviceUrlFor(quote);
      const budgetBeforeAtomic = ledger.remaining();
      emit("PROCUREMENT_DECISION_CREATED", {
        capability,
        serviceId,
        detail: `buy ${selected.name} at ${quote.priceUsd} (${quote.priceAtomic} atomic); remaining ${budgetBeforeAtomic} atomic`,
      });

      const result = await purchase({ quote, method: SESSION_METHOD, url, ledger, rules, payAndFetch: payAndFetchFor(quote) });
      const budgetAfterAtomic = ledger.remaining();

      // The paid body, read once; delivered only for HTTP 200 with a JSON body (S4-Q5).
      let bodyText: string | undefined;
      let body: unknown;
      let delivered = false;
      if (result.outcome === "paid") {
        try {
          bodyText = await result.response.text();
        } catch {
          bodyText = undefined;
        }
        if (result.response.status === 200 && bodyText !== undefined) {
          try {
            body = JSON.parse(bodyText);
            delivered = true;
          } catch {
            delivered = false;
          }
        }
      }

      // The purchase events, derived from the outcome: the policy runs before any request (purchase.ts).
      const at = { capability, serviceId };
      if (result.outcome === "rejected") {
        emit("POLICY_REJECTED", { ...at, detail: `rejected by the policy engine: ${result.code}` });
      } else {
        emit("POLICY_APPROVED", { ...at, detail: "approved by the policy engine" });
        if (result.outcome !== "failed-before-payment") {
          emit("PAYMENT_REQUIRED", { ...at, detail: `x402 payment of ${quote.priceUsd} required` });
          emit("PAYMENT_AUTHORIZED", {
            ...at,
            detail: result.outcome === "pending-reconciliation" ? "a signed payment request was or may have been sent" : "a signed payment request was sent",
          });
        }
        if (result.outcome === "paid") {
          emit("PAYMENT_SETTLED", { ...at, detail: `settled on Solana Devnet: ${result.transaction}` });
          emit("RESOURCE_RECEIVED", { ...at, detail: `HTTP ${result.response.status}` });
          if (delivered) emit("DELIVERY_VERIFIED", { ...at, detail: "HTTP 200 with a JSON body" });
        }
        if (result.outcome === "failed-before-payment" || result.outcome === "payment-failed") {
          emit("SERVICE_FAILED", { ...at, detail: describeFailure(result) });
        }
      }

      const receipt = buildReceipt({
        runId,
        n: receipts.length + 1,
        createdAt: now(),
        capability,
        candidates: tender,
        selected,
        quote,
        method: SESSION_METHOD,
        url,
        budgetBeforeAtomic,
        budgetAfterAtomic,
        result,
        delivered,
        ...(bodyText !== undefined ? { bodyText } : {}),
        isFallback: round > 1,
      });
      receipts.push(receipt);
      emit("PROCUREMENT_RECEIPT_CREATED", { ...at, detail: receipt.receiptId });

      if (result.outcome === "paid") {
        if (delivered && bodyText !== undefined) {
          count(serviceId, "successes");
          deliveries.push({ capability, serviceId, bodyText, body });
        } else {
          count(serviceId, "failures");
          undelivered.push({ capability, serviceId });
        }
        break;
      }
      if (result.outcome === "rejected") {
        unfulfilled.push({ capability, reasons: [...tender, `POLICY_REJECTED: ${result.code}`] });
        break;
      }
      if (result.outcome === "pending-reconciliation") return finish(true);
      // failed-before-payment or payment-failed: never retried; the Tender runs again without it.
      failed.add(serviceId);
      count(serviceId, "failures");
    }
  }
  return finish(false);
}

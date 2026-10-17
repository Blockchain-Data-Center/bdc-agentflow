// The Procurement Policy Engine (S2-Q1): a pure decision on a proposed purchase, before anything is signed.
// No I/O, no clock, no randomness; it reads the ledger and never changes it. The first failing check wins.
// The network rule is on paymentNetwork only: dataNetwork is never read (FD-04 item 4).
import type { LedgerView } from "./session.ts";

export type Proposal = {
  serviceId: string;
  capability: string;
  requestKey: string;
  paymentNetwork: string;
  paymentAsset: string;
  amountAtomic: bigint;
  payTo: string;
  dataNetwork?: string;
};

export type PolicyRules = {
  readonly sessionBudgetAtomic: bigint;
  readonly maxPerServiceAtomic: bigint;
  readonly allowedPaymentNetwork: string;
  readonly allowedPaymentAsset: string;
};

export type PolicyCode =
  | "WRONG_PAYMENT_NETWORK"
  | "WRONG_PAYMENT_ASSET"
  | "OVER_SERVICE_CAP"
  | "DUPLICATE_PURCHASE"
  | "OVER_BUDGET";

export type PolicyDecision = { decision: "approved" } | { decision: "rejected"; code: PolicyCode; reason: string };

const reject = (code: PolicyCode, reason: string): PolicyDecision => ({ decision: "rejected", code, reason: `${code}: ${reason}` });

export function evaluate(proposal: Proposal, ledger: LedgerView, rules: PolicyRules): PolicyDecision {
  if (proposal.paymentNetwork !== rules.allowedPaymentNetwork) {
    return reject("WRONG_PAYMENT_NETWORK", `expected ${rules.allowedPaymentNetwork}, got ${proposal.paymentNetwork}`);
  }
  if (proposal.paymentAsset !== rules.allowedPaymentAsset) {
    return reject("WRONG_PAYMENT_ASSET", `expected ${rules.allowedPaymentAsset}, got ${proposal.paymentAsset}`);
  }
  if (proposal.amountAtomic > rules.maxPerServiceAtomic) {
    return reject("OVER_SERVICE_CAP", `${proposal.amountAtomic} exceeds the per-service cap ${rules.maxPerServiceAtomic}`);
  }
  const status = ledger.status(proposal.requestKey);
  if (status !== undefined) {
    return reject("DUPLICATE_PURCHASE", `${proposal.requestKey} is already ${status}`);
  }
  const remaining = ledger.remaining();
  if (proposal.amountAtomic > remaining) {
    return reject("OVER_BUDGET", `${proposal.amountAtomic} exceeds the remaining ${remaining}`);
  }
  return { decision: "approved" };
}

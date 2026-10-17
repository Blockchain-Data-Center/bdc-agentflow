// purchase (S2-Q4): decision → policy engine → payment. A rejected proposal returns before payAndFetch is
// called, so no request is made and the signer is never reached. The outcome decides the ledger action (S2-Q2).
// It reads no environment variable and never sees the signer; payAndFetch is built by the caller.
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import { evaluate, type PolicyCode, type PolicyRules, type Proposal } from "../policy/engine.ts";
import { requestKeyFor, type Ledger } from "../policy/session.ts";
import type { ServiceQuote } from "../registry/services.ts";

// Never throws: an error is returned in `error`, with the count of requests that carried PAYMENT-SIGNATURE.
export type PayAndFetch = (url: string) => Promise<{ response?: Response; error?: unknown; signedRequestsSent: number }>;

export type PurchaseResult =
  | { outcome: "rejected"; code: PolicyCode }
  | { outcome: "paid"; transaction: string; response: Response }
  | { outcome: "failed-before-payment"; httpStatus?: number; reason: string }
  | { outcome: "payment-failed"; errorReason?: string }
  | { outcome: "pending-reconciliation"; reason: string };

// Reasons are built here, never copied from a raw error, so no URL or RPC error text is carried.
// A requirement-guard code, if the error names one, is kept.
function errorSummary(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const guard = error instanceof Error ? /\bGUARD_[A-Z]+\b/.exec(error.message)?.[0] : undefined;
  return guard ? `${name} (${guard})` : name;
}

function decodeSettlement(response: Response): SettleResponse | undefined {
  const header = response.headers.get("PAYMENT-RESPONSE");
  if (!header) return undefined;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return undefined;
  }
}

export async function purchase({
  quote,
  method,
  url,
  ledger,
  rules,
  payAndFetch,
}: {
  quote: ServiceQuote;
  method: string;
  url: string;
  ledger: Ledger;
  rules: PolicyRules;
  payAndFetch: PayAndFetch;
}): Promise<PurchaseResult> {
  // (1) the proposal and its duplicate key
  const requestKey = requestKeyFor(quote.serviceId, method, url);
  const proposal: Proposal = {
    serviceId: quote.serviceId,
    capability: quote.capability,
    requestKey,
    paymentNetwork: quote.paymentNetwork,
    paymentAsset: quote.paymentAsset,
    amountAtomic: quote.priceAtomic,
    payTo: quote.payTo,
    ...(quote.dataNetwork !== undefined ? { dataNetwork: quote.dataNetwork } : {}),
  };

  // (2) the policy engine; a rejection never reaches payAndFetch
  const decision = evaluate(proposal, ledger, rules);
  if (decision.decision === "rejected") return { outcome: "rejected", code: decision.code };

  // (3) reserve, (4) pay and fetch
  ledger.reserve(requestKey, proposal.amountAtomic);
  let result: Awaited<ReturnType<PayAndFetch>>;
  try {
    result = await payAndFetch(url);
  } catch (error) {
    // Outside the contract: whether a signed request left is unknown, so the amount stays reserved.
    ledger.markPending(requestKey);
    return { outcome: "pending-reconciliation", reason: `payAndFetch threw: ${errorSummary(error)}` };
  }
  const { response, error, signedRequestsSent } = result;

  // (5) the outcome decides the ledger action
  if (signedRequestsSent === 0) {
    ledger.release(requestKey);
    if (error !== undefined) {
      return { outcome: "failed-before-payment", reason: `no payment was created: ${errorSummary(error)}` };
    }
    return {
      outcome: "failed-before-payment",
      ...(response ? { httpStatus: response.status } : {}),
      reason: response ? `no payment was requested: HTTP ${response.status}` : "no response and no payment",
    };
  }

  if (error !== undefined || !response) {
    ledger.markPending(requestKey);
    return { outcome: "pending-reconciliation", reason: `signed request sent, then ${error !== undefined ? errorSummary(error) : "no response"}` };
  }

  const settlement = decodeSettlement(response);
  if (!settlement) {
    ledger.markPending(requestKey);
    return { outcome: "pending-reconciliation", reason: `signed request sent, HTTP ${response.status} without a decodable PAYMENT-RESPONSE` };
  }
  if (settlement.success === true) {
    ledger.commit(requestKey);
    return { outcome: "paid", transaction: settlement.transaction, response };
  }
  if (!settlement.transaction) {
    ledger.release(requestKey);
    return { outcome: "payment-failed", ...(settlement.errorReason !== undefined ? { errorReason: settlement.errorReason } : {}) };
  }
  ledger.markPending(requestKey);
  return { outcome: "pending-reconciliation", reason: "PAYMENT-RESPONSE reports success: false with a transaction" };
}

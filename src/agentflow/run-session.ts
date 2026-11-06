// The minimal session runner (S3-Q4): buys an ordered plan of services, each through one purchase call, so the
// policy engine runs exactly once per purchase, before any request. No AI in Task A; deterministic.
// - failed-before-payment (SERVICE_FAILED) or payment-failed (PAYMENT_FAILED): already released by purchase;
//   the service's one alternate, if any, is bought by its own purchase call; the failed service is never retried.
// - pending-reconciliation (PENDING_RECONCILIATION): the session stops at once; the amount stays reserved.
// It reads no environment variable and never sees the signer: payAndFetchFor is built by the caller.
import type { PolicyCode, PolicyRules } from "../policy/engine.ts";
import type { Ledger } from "../policy/session.ts";
import { purchase, type PayAndFetch, type PurchaseResult } from "../payments/purchase.ts";
import type { ServiceQuote } from "../registry/services.ts";
import { JUP_MINT } from "../services/token-intel.ts";

export const SESSION_HOST = "127.0.0.1";
export const SESSION_METHOD = "GET";

export type SessionCode = PolicyCode | "SERVICE_FAILED" | "PAYMENT_FAILED" | "PENDING_RECONCILIATION" | "SERVICE_SKIPPED";

export type SessionRecord = {
  serviceId: string;
  amountAtomic: bigint;
  outcome: PurchaseResult["outcome"] | "skipped";
  code?: SessionCode;
  transaction?: string;
  remainingAfter: bigint;
};

export type SessionResult = { records: SessionRecord[]; stoppedEarly: boolean };

// The URL a quote is bought at: the service in-process on 127.0.0.1, the Task A demo token.
export function serviceUrlFor(quote: Pick<ServiceQuote, "port" | "endpointPath">): string {
  return `http://${SESSION_HOST}:${quote.port}${quote.endpointPath}?mint=${JUP_MINT}`;
}

const failureCode = (outcome: SessionRecord["outcome"]): SessionCode | undefined =>
  outcome === "failed-before-payment" ? "SERVICE_FAILED" : outcome === "payment-failed" ? "PAYMENT_FAILED" : undefined;

export async function runSession({
  plan,
  alternates,
  ledger,
  rules,
  quoteFor,
  payAndFetchFor,
}: {
  plan: readonly string[];
  alternates: Readonly<Record<string, string>>;
  ledger: Ledger;
  rules: PolicyRules;
  quoteFor: (serviceId: string) => ServiceQuote;
  payAndFetchFor: (quote: ServiceQuote) => PayAndFetch;
}): Promise<SessionResult> {
  const records: SessionRecord[] = [];
  const failed = new Set<string>();

  // One attempt: one purchase call, one record. Returns the record.
  async function attempt(serviceId: string): Promise<SessionRecord> {
    const quote = quoteFor(serviceId);
    if (failed.has(serviceId)) {
      const record: SessionRecord = {
        serviceId,
        amountAtomic: quote.priceAtomic,
        outcome: "skipped",
        code: "SERVICE_SKIPPED",
        remainingAfter: ledger.remaining(),
      };
      records.push(record);
      return record;
    }
    const result = await purchase({
      quote,
      method: SESSION_METHOD,
      url: serviceUrlFor(quote),
      ledger,
      rules,
      payAndFetch: payAndFetchFor(quote),
    });
    const code: SessionCode | undefined =
      result.outcome === "rejected"
        ? result.code
        : result.outcome === "pending-reconciliation"
          ? "PENDING_RECONCILIATION"
          : failureCode(result.outcome);
    const record: SessionRecord = {
      serviceId,
      amountAtomic: quote.priceAtomic,
      outcome: result.outcome,
      ...(code !== undefined ? { code } : {}),
      ...(result.outcome === "paid" ? { transaction: result.transaction } : {}),
      remainingAfter: ledger.remaining(),
    };
    if (failureCode(result.outcome) !== undefined) failed.add(serviceId);
    records.push(record);
    return record;
  }

  for (const serviceId of plan) {
    const record = await attempt(serviceId);
    if (record.outcome === "pending-reconciliation") return { records, stoppedEarly: true };
    const alternate = alternates[serviceId];
    if (failureCode(record.outcome) !== undefined && alternate !== undefined) {
      const alternateRecord = await attempt(alternate);
      if (alternateRecord.outcome === "pending-reconciliation") return { records, stoppedEarly: true };
    }
  }
  return { records, stoppedEarly: false };
}

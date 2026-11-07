// The Procurement Decision Receipt (S4-Q4): one per purchase attempt (paid, failed-before-payment,
// payment-failed, rejected, pending-reconciliation). Pure: no I/O, no environment, no clock (the time is passed in).
// Every field is JSON-safe; atomic amounts are decimal strings. It carries no wallet secret, no environment value
// and no header. Application-level only: nothing is written on-chain. The request and output fingerprints link
// the purchase to what was delivered without publishing the raw data.
import { createHash } from "node:crypto";
import type { PolicyCode } from "../policy/engine.ts";
import type { PurchaseResult } from "../payments/purchase.ts";
import type { TenderCandidate } from "./tender.ts";

export type ReceiptCandidate = Pick<TenderCandidate, "serviceId" | "priceUsd" | "reasonCode" | "reasonText">;

export type ProcurementReceipt = {
  receiptId: string;
  createdAt: string;
  capability: string;
  candidates: ReceiptCandidate[];
  selected: { serviceId: string; name: string; reasonText: string };
  quotedPriceAtomic: string;
  quotedPriceUsd: string;
  policy: { decision: "approved" } | { decision: "rejected"; code: PolicyCode };
  budgetBeforeAtomic: string;
  budgetAfterAtomic: string;
  paymentOutcome: PurchaseResult["outcome"];
  transaction?: string;
  explorerUrl?: string;
  delivered: boolean;
  requestFingerprint: string;
  outputFingerprint?: string;
  isFallback: boolean;
};

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export const explorerUrlFor = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

export function buildReceipt({
  runId,
  n,
  createdAt,
  capability,
  candidates,
  selected,
  quote,
  method,
  url,
  budgetBeforeAtomic,
  budgetAfterAtomic,
  result,
  delivered,
  bodyText,
  isFallback,
}: {
  runId: string;
  n: number; // 1-based, in attempt order across the run
  createdAt: Date;
  capability: string;
  candidates: readonly TenderCandidate[];
  selected: TenderCandidate;
  quote: { priceAtomic: bigint; priceUsd: string };
  method: string;
  url: string;
  budgetBeforeAtomic: bigint;
  budgetAfterAtomic: bigint;
  result: PurchaseResult;
  delivered: boolean;
  bodyText?: string;
  isFallback: boolean;
}): ProcurementReceipt {
  const paid = result.outcome === "paid";
  const wasDelivered = paid && delivered && bodyText !== undefined;
  return {
    receiptId: `${runId}-${n}`,
    createdAt: createdAt.toISOString(),
    capability,
    candidates: candidates.map(({ serviceId, priceUsd, reasonCode, reasonText }) => ({ serviceId, priceUsd, reasonCode, reasonText })),
    selected: { serviceId: selected.serviceId, name: selected.name, reasonText: selected.reasonText },
    quotedPriceAtomic: quote.priceAtomic.toString(),
    quotedPriceUsd: quote.priceUsd,
    policy: result.outcome === "rejected" ? { decision: "rejected", code: result.code } : { decision: "approved" },
    budgetBeforeAtomic: budgetBeforeAtomic.toString(),
    budgetAfterAtomic: budgetAfterAtomic.toString(),
    paymentOutcome: result.outcome,
    ...(paid ? { transaction: result.transaction, explorerUrl: explorerUrlFor(result.transaction) } : {}),
    delivered: wasDelivered,
    requestFingerprint: sha256Hex(`${method} ${url}`),
    ...(wasDelivered ? { outputFingerprint: sha256Hex(bodyText) } : {}),
    isFallback,
  };
}

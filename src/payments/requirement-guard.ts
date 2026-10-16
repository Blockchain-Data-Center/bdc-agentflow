// The requirement guard: the server must ask for exactly what we decided to buy.
// It is not the policy engine; it runs in the x402 client's before-creation hook, before anything is signed.
import type { PaymentRequirements } from "@x402/core/types";
import { paymentAsset, paymentNetwork } from "../config/networks.ts";
import type { ServiceQuote } from "../registry/services.ts";

export type GuardCode = "GUARD_SCHEME" | "GUARD_NETWORK" | "GUARD_ASSET" | "GUARD_AMOUNT" | "GUARD_PAYTO";

export type GuardAbort = { abort: true; reason: string };

function abort(code: GuardCode, expected: string, actual: string): GuardAbort {
  return { abort: true, reason: `${code}: expected ${expected}, got ${actual}` };
}

// Returns undefined when the selected requirement matches the quote, otherwise an abort carrying a code.
export function checkRequirement(
  quote: Pick<ServiceQuote, "priceAtomic" | "payTo">,
  selected: Pick<PaymentRequirements, "scheme" | "network" | "asset" | "amount" | "payTo">,
): GuardAbort | undefined {
  if (selected.scheme !== "exact") return abort("GUARD_SCHEME", "exact", selected.scheme);
  if (selected.network !== paymentNetwork) return abort("GUARD_NETWORK", paymentNetwork, selected.network);
  if (selected.asset !== paymentAsset) return abort("GUARD_ASSET", paymentAsset, selected.asset);
  const amount = String(quote.priceAtomic);
  if (selected.amount !== amount) return abort("GUARD_AMOUNT", amount, selected.amount);
  if (selected.payTo !== quote.payTo) return abort("GUARD_PAYTO", quote.payTo, selected.payTo);
  return undefined;
}

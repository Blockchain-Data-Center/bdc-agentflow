// x402 client wiring: one x402Client per purchase, default spend controls left on,
// and the requirement guard in the before-creation hook so a mismatch aborts before the scheme signs.
import type { TransactionSigner } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { paymentNetwork, paymentRpcUrl } from "../config/networks.ts";
import type { ServiceQuote } from "../registry/services.ts";
import { checkRequirement } from "./requirement-guard.ts";

type PurchaseInput = {
  signer: TransactionSigner;
  quote: Pick<ServiceQuote, "priceAtomic" | "payTo">;
};

export function buildX402Client({ signer, quote }: PurchaseInput): x402Client {
  return new x402Client()
    .register(paymentNetwork, new ExactSvmScheme(signer, { rpcUrl: paymentRpcUrl }))
    .onBeforePaymentCreation(async (context) => checkRequirement(quote, context.selectedRequirements));
}

export function createPayingFetch({
  signer,
  quote,
  baseFetch,
}: PurchaseInput & { baseFetch?: typeof fetch }): {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  signedRequestsSent: () => number;
} {
  const base = baseFetch ?? fetch;
  let signed = 0;
  // Counts the requests that leave carrying a PAYMENT-SIGNATURE header.
  const countingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
    if (headers.has("PAYMENT-SIGNATURE")) signed += 1;
    return base(input, init);
  }) as typeof fetch;
  return {
    fetch: wrapFetchWithPayment(countingFetch, buildX402Client({ signer, quote })),
    signedRequestsSent: () => signed,
  };
}

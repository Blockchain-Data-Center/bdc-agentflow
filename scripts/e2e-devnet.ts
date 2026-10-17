// The live Devnet E2E for S2: facilitator preflight, then Service A in-process on 127.0.0.1:4021, then one
// x402 purchase through purchase (the policy engine first, then the payment by the constrained buyer signer),
// then the session ledger. Success needs every check (a)–(e); an HTTP 200 alone is never success.
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createSolanaRpc, signature } from "@solana/kit";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { SettleResponse } from "@x402/core/types";
import { paymentAsset, paymentNetwork, paymentRpcUrl } from "../src/config/networks.ts";
import { createPayingFetch } from "../src/payments/client.ts";
import { FacilitatorUnsupportedError, assertFacilitatorSupports } from "../src/payments/facilitator-preflight.ts";
import { purchase, type PayAndFetch } from "../src/payments/purchase.ts";
import * as rules from "../src/policy/rules.ts";
import { createLedger, requestKeyFor, type LedgerView } from "../src/policy/session.ts";
import { serviceA, type ServiceQuote } from "../src/registry/services.ts";
import { createServiceA } from "../src/services/service-a.ts";
import { JUP_MINT, createTokenIntelProvider, createTokenIntelRpc } from "../src/services/token-intel.ts";
import { loadBuyerSigner } from "../src/signer/buyer-signer.ts";

const FACILITATOR_URL = "https://x402.org/facilitator";
const HOST = "127.0.0.1";
const POLL_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 2000;
const SERVICE_A_FIELDS = [
  "serviceId",
  "capability",
  "dataNetwork",
  "mint",
  "decimals",
  "supplyUi",
  "largestAccounts",
  "top10TokenAccountSharePct",
  "dataStatus",
  "asOf",
  "source",
] as const;

type TokenBalanceRow = { mint: string; owner?: string; uiTokenAmount: { amount: string } };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

function fail(check: string, detail: string): never {
  console.error(`FAIL ${check}: ${detail}`);
  process.exit(1);
}

function pass(check: string, detail: string): void {
  console.log(`PASS ${check}: ${detail}`);
}

function printLedger(ledger: LedgerView): void {
  console.log(`ledger: budget ${ledger.budgetAtomic}, committed ${ledger.committed()}, reserved ${ledger.reserved()}, remaining ${ledger.remaining()} (atomic)`);
}

// Sum of the payment-asset balance rows owned by the given wallet (0 when it has none).
function ownerBalance(rows: readonly TokenBalanceRow[] | undefined, owner: string): bigint {
  return (rows ?? [])
    .filter((row) => row.mint === paymentAsset && row.owner === owner)
    .reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), 0n);
}

async function preflight(facilitator: HTTPFacilitatorClient): Promise<void> {
  try {
    const kind = await assertFacilitatorSupports(facilitator, { x402Version: 2, scheme: "exact", network: paymentNetwork });
    console.log(`facilitator preflight: PASS, matching kind ${JSON.stringify(kind)}`);
  } catch (error) {
    if (error instanceof FacilitatorUnsupportedError) {
      console.error(`facilitator preflight: ${error.code}`);
      console.error(`returned kinds: ${JSON.stringify(error.kinds, null, 2)}`);
    } else {
      console.error(`facilitator preflight: FACILITATOR_UNREACHABLE: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}

async function confirmedTransaction(sig: string) {
  const rpc = createSolanaRpc(paymentRpcUrl);
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
    const tx = await rpc
      .getTransaction(signature(sig), { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "jsonParsed" })
      .send();
    if (tx) return tx;
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

async function main(): Promise<void> {
  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  await preflight(facilitator);

  const wallets = JSON.parse(readFileSync(new URL("../wallets.public.json", import.meta.url), "utf8")) as {
    buyer: string;
    seller: string;
  };
  const signer = await loadBuyerSigner();
  if (signer.address !== wallets.buyer) fail("setup", "the buyer signer does not match wallets.public.json");

  const tokenIntel = createTokenIntelProvider({
    rpc: createTokenIntelRpc(),
    cachePath: fileURLToPath(new URL("../data/cache/token-intel-JUP.json", import.meta.url)),
  });
  const app = createServiceA({ payTo: wallets.seller, facilitator, tokenIntel });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(serviceA.port, HOST, () => resolve(s));
  });
  console.log(`Service A listening on http://${HOST}:${serviceA.port}${serviceA.endpointPath}`);

  const quote: ServiceQuote = { ...serviceA, payTo: wallets.seller };
  const paying = createPayingFetch({ signer, quote });
  // Never throws: an error is returned with the count of signed requests, for purchase to map.
  const payAndFetch: PayAndFetch = async (target) => {
    try {
      return { response: await paying.fetch(target), signedRequestsSent: paying.signedRequestsSent() };
    } catch (error) {
      return { error, signedRequestsSent: paying.signedRequestsSent() };
    }
  };
  const ledger = createLedger(rules.sessionBudgetAtomic);
  const url = `http://${HOST}:${serviceA.port}${serviceA.endpointPath}?mint=${JUP_MINT}`;
  printLedger(ledger);
  console.log(`buying ${quote.serviceId} for ${quote.priceUsd} (${quote.priceAtomic} atomic) from ${quote.payTo}`);

  const result = await purchase({ quote, method: "GET", url, ledger, rules, payAndFetch });
  server.close();
  console.log(`purchase outcome: ${result.outcome}; signed requests sent: ${paying.signedRequestsSent()}`);
  if (result.outcome !== "paid") {
    printLedger(ledger);
    if (result.outcome === "pending-reconciliation") {
      console.error(`pending reconciliation: requestKey ${requestKeyFor(quote.serviceId, "GET", url)}, buyer ${wallets.buyer}`);
    }
    fail("purchase", JSON.stringify(result));
  }
  const response = result.response;

  // (a) HTTP 200
  if (response.status !== 200) fail("(a)", `HTTP ${response.status}: ${await response.text()}`);
  pass("(a)", "HTTP 200");

  // (b) PAYMENT-RESPONSE
  const header = response.headers.get("PAYMENT-RESPONSE");
  if (!header) fail("(b)", "no PAYMENT-RESPONSE header");
  let settle: SettleResponse;
  try {
    settle = decodePaymentResponseHeader(header);
  } catch (error) {
    fail("(b)", `PAYMENT-RESPONSE does not decode: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (settle.success !== true) fail("(b)", `success is ${settle.success} (${settle.errorReason ?? "no reason"})`);
  if (settle.network !== paymentNetwork) fail("(b)", `network is ${settle.network}`);
  if (!settle.transaction) fail("(b)", "empty transaction");
  if (settle.payer !== wallets.buyer) fail("(b)", `payer is ${settle.payer}, expected the buyer ${wallets.buyer}`);
  pass("(b)", `success, ${settle.network}, payer ${settle.payer}`);
  const sig = settle.transaction;
  console.log(`signature: ${sig}`);
  console.log(`explorer: ${explorerTx(sig)}`);

  // (c) confirmed on Devnet with no error
  const tx = await confirmedTransaction(sig);
  if (!tx) fail("(c)", `not found at confirmed after ${POLL_ATTEMPTS} attempts`);
  if (!tx.meta) fail("(c)", "transaction has no meta");
  if (tx.meta.err !== null) fail("(c)", `meta.err is ${JSON.stringify(tx.meta.err)}`);
  pass("(c)", "confirmed, meta.err === null");

  // (d) exact balance deltas of the payment asset
  const pre = tx.meta.preTokenBalances as readonly TokenBalanceRow[] | undefined;
  const post = tx.meta.postTokenBalances as readonly TokenBalanceRow[] | undefined;
  const sellerDelta = ownerBalance(post, wallets.seller) - ownerBalance(pre, wallets.seller);
  const buyerDelta = ownerBalance(post, wallets.buyer) - ownerBalance(pre, wallets.buyer);
  console.log(`seller delta: ${sellerDelta} atomic, buyer delta: ${buyerDelta} atomic`);
  if (sellerDelta !== quote.priceAtomic) fail("(d)", `seller delta ${sellerDelta}, expected +${quote.priceAtomic}`);
  if (buyerDelta !== -quote.priceAtomic) fail("(d)", `buyer delta ${buyerDelta}, expected -${quote.priceAtomic}`);
  pass("(d)", `seller +${sellerDelta}, buyer ${buyerDelta}`);

  // (e) the body carries every field of Service A's response definition
  const body = (await response.json()) as Record<string, unknown>;
  const missing = SERVICE_A_FIELDS.filter((field) => !(field in body));
  if (missing.length > 0) fail("(e)", `missing fields: ${missing.join(", ")}`);
  if (body.serviceId !== serviceA.serviceId) fail("(e)", `serviceId is ${String(body.serviceId)}`);
  pass("(e)", `every Service A field present, serviceId ${body.serviceId}`);
  console.log(`data status: ${body.dataStatus} (asOf ${body.asOf})`);

  // the session ledger after one committed purchase
  printLedger(ledger);
  if (ledger.committed() !== quote.priceAtomic || ledger.reserved() !== 0n || ledger.remaining() !== rules.sessionBudgetAtomic - quote.priceAtomic) {
    fail("ledger", `expected committed ${quote.priceAtomic}, reserved 0, remaining ${rules.sessionBudgetAtomic - quote.priceAtomic}`);
  }
  pass("ledger", `budget ${ledger.budgetAtomic}, committed ${ledger.committed()}, remaining ${ledger.remaining()}`);

  console.log("e2e:devnet: all checks passed");
  process.exit(0);
}

await main();

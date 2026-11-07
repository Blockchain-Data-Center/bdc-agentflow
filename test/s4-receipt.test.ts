import "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildReceipt } from "../src/agentflow/receipt.ts";
import { runTender } from "../src/agentflow/tender.ts";
import * as rules from "../src/policy/rules.ts";
import { createLedger } from "../src/policy/session.ts";
import { serviceB1, services } from "../src/registry/services.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (path: string) => relative(repoRoot, path).split(sep).join("/");

const createdAt = new Date("2026-11-07T12:00:00.000Z");
const url = "http://127.0.0.1:4022/v1/market-intel?mint=JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const candidates = runTender({
  capability: "market-intelligence",
  candidates: services,
  ledger: createLedger(rules.sessionBudgetAtomic),
  rules,
  failed: new Set(),
  reliability: {},
});
const selected = candidates[0];

const common = {
  runId: "run-test",
  createdAt,
  capability: "market-intelligence",
  candidates,
  selected,
  quote: serviceB1,
  method: "GET",
  url,
  isFallback: false,
};

// Relative import specifiers of a file, resolved to repository-relative paths.
function localImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specifiers = [
    ...text.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...text.matchAll(/\bimport\s*["']([^"']+)["']/g),
    ...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
  return specifiers.filter((s) => s.startsWith(".")).map((s) => rel(resolve(dirname(file), s)));
}
const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

describe("s4-receipt", () => {
  it("(1) a paid receipt carries every S4-Q4 field, a Devnet Explorer URL, both fingerprints, string budgets, and serialises", () => {
    const bodyText = '{"serviceId":"svc-b1-market-intel"}';
    const receipt = buildReceipt({
      ...common,
      n: 2,
      budgetBeforeAtomic: 45_000n,
      budgetAfterAtomic: 41_000n,
      result: { outcome: "paid", transaction: "tx-signature", response: new Response(bodyText) },
      delivered: true,
      bodyText,
    });
    assert.deepEqual(Object.keys(receipt), [
      "receiptId",
      "createdAt",
      "capability",
      "candidates",
      "selected",
      "quotedPriceAtomic",
      "quotedPriceUsd",
      "policy",
      "budgetBeforeAtomic",
      "budgetAfterAtomic",
      "paymentOutcome",
      "transaction",
      "explorerUrl",
      "delivered",
      "requestFingerprint",
      "outputFingerprint",
      "isFallback",
    ]);
    assert.equal(receipt.receiptId, "run-test-2");
    assert.equal(receipt.createdAt, "2026-11-07T12:00:00.000Z");
    assert.equal(receipt.capability, "market-intelligence");
    assert.deepEqual(
      receipt.candidates,
      candidates.map(({ serviceId, priceUsd, reasonCode, reasonText }) => ({ serviceId, priceUsd, reasonCode, reasonText })),
    );
    assert.deepEqual(receipt.selected, { serviceId: serviceB1.serviceId, name: serviceB1.name, reasonText: selected.reasonText });
    assert.equal(receipt.quotedPriceAtomic, "4000");
    assert.equal(receipt.quotedPriceUsd, "$0.004");
    assert.deepEqual(receipt.policy, { decision: "approved" });
    assert.equal(receipt.budgetBeforeAtomic, "45000");
    assert.equal(receipt.budgetAfterAtomic, "41000");
    assert.equal(receipt.paymentOutcome, "paid");
    assert.equal(receipt.transaction, "tx-signature");
    assert.equal(receipt.explorerUrl, "https://explorer.solana.com/tx/tx-signature?cluster=devnet");
    assert.equal(receipt.delivered, true);
    assert.equal(receipt.requestFingerprint, sha256(`GET ${url}`));
    assert.equal(receipt.outputFingerprint, sha256(bodyText));
    assert.equal(receipt.isFallback, false);
    assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt);
  });

  it("(2) a failed-before-payment receipt has no transaction, explorerUrl or outputFingerprint; a rejected one carries its code", () => {
    const failed = buildReceipt({
      ...common,
      n: 1,
      budgetBeforeAtomic: 45_000n,
      budgetAfterAtomic: 45_000n,
      result: { outcome: "failed-before-payment", httpStatus: 503, reason: "no payment was requested: HTTP 503" },
      delivered: false,
    });
    for (const field of ["transaction", "explorerUrl", "outputFingerprint"]) assert.equal(Object.hasOwn(failed, field), false, field);
    assert.equal(failed.delivered, false);
    assert.equal(failed.paymentOutcome, "failed-before-payment");
    assert.deepEqual(failed.policy, { decision: "approved" });

    const rejected = buildReceipt({
      ...common,
      n: 1,
      budgetBeforeAtomic: 50_000n,
      budgetAfterAtomic: 50_000n,
      result: { outcome: "rejected", code: "WRONG_PAYMENT_NETWORK" },
      delivered: false,
    });
    assert.deepEqual(rejected.policy, { decision: "rejected", code: "WRONG_PAYMENT_NETWORK" });
    assert.equal(rejected.paymentOutcome, "rejected");
    assert.equal(rejected.delivered, false);
    assert.equal(Object.hasOwn(rejected, "transaction"), false);
  });

  it("(3) source scan: tender, receipt, procure and events read no environment and import nothing from src/signer; tender nothing from src/payments; procure not src/payments/client.ts", () => {
    const files = ["tender.ts", "receipt.ts", "procure.ts", "events.ts"].map((name) => join(repoRoot, "src", "agentflow", name));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.ok(!/process\s*\.\s*env|process\s*\[/.test(text), `${rel(file)} reads the environment`);
      for (const target of localImports(file)) assert.ok(!inside(target, "src/signer"), `${rel(file)} imports ${target}`);
    }
    for (const target of localImports(files[0])) assert.ok(!inside(target, "src/payments"), `tender.ts imports ${target}`);
    for (const target of localImports(files[2])) assert.notEqual(target, "src/payments/client.ts", "procure.ts imports src/payments/client.ts");
  });
});

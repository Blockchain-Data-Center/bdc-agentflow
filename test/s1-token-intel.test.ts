import "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  JUP_MINT,
  computeTokenIntel,
  createTokenIntelProvider,
  createTokenIntelRpc,
  TokenIntelRpcError,
  type RpcLargestAccount,
  type RpcTokenAmount,
  type TokenIntelData,
  type TokenIntelRpc,
} from "../src/services/token-intel.ts";

// Supply 1,000,000.000000 (6 decimals); ten accounts holding 12,345.678901 in total.
const supply: RpcTokenAmount = { amount: "1000000000000", decimals: 6, uiAmountString: "1000000" };
const largest: RpcLargestAccount[] = [
  "5000000000", "2000000000", "1500000000", "1000000000", "800000000",
  "700000000", "600000000", "400000000", "200000000", "145678901",
  "100000000", // an 11th account, beyond the top 10
].map((amount, i) => ({ address: `Account${i}`, amount, decimals: 6, uiAmountString: String(Number(amount) / 1e6) }));

const workingRpc: TokenIntelRpc = {
  getTokenSupply: async () => supply,
  getTokenLargestAccounts: async () => largest,
};
const throwingRpc: TokenIntelRpc = {
  getTokenSupply: async () => {
    throw new Error("rpc down");
  },
  getTokenLargestAccounts: async () => {
    throw new Error("rpc down");
  },
};

const tempDir = mkdtempSync(join(tmpdir(), "agentflow-token-intel-test-"));
after(() => rmSync(tempDir, { recursive: true, force: true }));

describe("s1-token-intel", () => {
  it("computes top10TokenAccountSharePct from stand-in RPC answers", () => {
    const data = computeTokenIntel({ mint: JUP_MINT, supply, largest, asOf: "2026-10-17T00:00:00.000Z", source: "test" });
    // 12,345.678901 / 1,000,000 = 1.2345678901 % -> 1.23
    assert.equal(data.top10TokenAccountSharePct, 1.23);
    assert.equal(data.largestAccounts.length, 10);
    assert.equal(data.decimals, 6);
    assert.equal(data.supplyUi, "1000000");
    assert.deepEqual(data.largestAccounts[0], { address: "Account0", amountUi: "5000" });
    // half-up at the boundary: 12,345 / 1,000,000 = 1.2345 % -> 1.23, 12,350 / 1,000,000 = 1.235 % -> 1.24
    const at = (amount: string) =>
      computeTokenIntel({ mint: JUP_MINT, supply, largest: [{ ...largest[0], amount }], asOf: "", source: "" })
        .top10TokenAccountSharePct;
    assert.equal(at("12345000000"), 1.23);
    assert.equal(at("12350000000"), 1.24);
  });

  it("a throwing RPC gives dataStatus cached fallback with the cache file's asOf", async () => {
    const cached: TokenIntelData = {
      ...computeTokenIntel({ mint: JUP_MINT, supply, largest, asOf: "2026-10-16T12:00:00.000Z", source: "cache test" }),
    };
    const cachePath = join(tempDir, "token-intel-JUP.json");
    writeFileSync(cachePath, JSON.stringify(cached), { flag: "wx" });
    const body = await createTokenIntelProvider({ rpc: throwingRpc, cachePath })(JUP_MINT);
    assert.equal(body.dataStatus, "cached fallback");
    assert.equal(body.asOf, "2026-10-16T12:00:00.000Z");
    assert.equal(body.top10TokenAccountSharePct, cached.top10TokenAccountSharePct);

    // The real Helius RPC with a dummy key, blocked by the net guard: same fallback, and its error carries
    // the method and status only, never the key or the URL. Without the key it fails naming the variable.
    const savedKey = process.env.HELIUS_API_KEY;
    try {
      process.env.HELIUS_API_KEY = "test-dummy-key";
      const heliusRpc = createTokenIntelRpc();
      const viaHelius = await createTokenIntelProvider({ rpc: heliusRpc, cachePath })(JUP_MINT);
      assert.equal(viaHelius.dataStatus, "cached fallback");
      await assert.rejects(heliusRpc.getTokenSupply(JUP_MINT), (error: unknown) => {
        assert.ok(error instanceof TokenIntelRpcError);
        assert.equal(error.message, "getTokenSupply failed: network-error");
        assert.ok(!error.message.includes("test-dummy-key") && !error.message.includes("helius-rpc.com"));
        assert.equal(error.cause, undefined);
        return true;
      });
      delete process.env.HELIUS_API_KEY;
      assert.throws(() => createTokenIntelRpc(), { message: "HELIUS_API_KEY is not set" });
    } finally {
      if (savedKey === undefined) delete process.env.HELIUS_API_KEY;
      else process.env.HELIUS_API_KEY = savedKey;
    }
  });

  it("a working RPC gives dataStatus live", async () => {
    const now = () => new Date("2026-10-17T01:02:03.000Z");
    const body = await createTokenIntelProvider({ rpc: workingRpc, cachePath: join(tempDir, "absent.json"), now })(JUP_MINT);
    assert.equal(body.dataStatus, "live");
    assert.equal(body.asOf, "2026-10-17T01:02:03.000Z");
    assert.equal(body.serviceId, "svc-a-token-intel");
    assert.equal(body.mint, JUP_MINT);
  });
});

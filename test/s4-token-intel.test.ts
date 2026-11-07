import "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  JUP_MINT,
  LIVE_TIMEOUT_MS,
  TokenIntelRpcError,
  computeTokenIntel,
  createTokenIntelProvider,
  type RpcLargestAccount,
  type RpcTokenAmount,
  type TokenIntelRpc,
} from "../src/services/token-intel.ts";

const supply: RpcTokenAmount = { amount: "1000000000000", decimals: 6, uiAmountString: "1000000" };
const largest: RpcLargestAccount[] = [{ address: "Account0", amount: "5000000000", decimals: 6, uiAmountString: "5000" }];

const rpcThrowing = (error: unknown): TokenIntelRpc => ({
  getTokenSupply: async () => supply,
  getTokenLargestAccounts: async () => {
    throw error;
  },
});
const workingRpc: TokenIntelRpc = { getTokenSupply: async () => supply, getTokenLargestAccounts: async () => largest };

// The cache is written only into this test's own temporary directory.
const tempDir = mkdtempSync(join(tmpdir(), "agentflow-s4-token-intel-test-"));
after(() => rmSync(tempDir, { recursive: true, force: true }));
const cachePath = join(tempDir, "token-intel-JUP.json");
writeFileSync(cachePath, JSON.stringify(computeTokenIntel({ mint: JUP_MINT, supply, largest, asOf: "2026-10-16T12:00:00.000Z", source: "cache test" })), {
  flag: "wx",
});

describe("s4-token-intel", () => {
  it("(1) Service A's live-read timeout is 20000 ms (FD-19)", () => {
    assert.equal(LIVE_TIMEOUT_MS, 20000);
  });

  it("(2) a cached fallback records its cause: the RPC error's method and status, else the error class only; live has none", async () => {
    const viaTimeout = await createTokenIntelProvider({ rpc: rpcThrowing(new TokenIntelRpcError("getTokenLargestAccounts", "timeout")), cachePath })(JUP_MINT);
    assert.equal(viaTimeout.dataStatus, "cached fallback");
    assert.equal(viaTimeout.fallbackCause, "getTokenLargestAccounts failed: timeout");
    assert.equal(viaTimeout.asOf, "2026-10-16T12:00:00.000Z");

    const viaTypeError = await createTokenIntelProvider({ rpc: rpcThrowing(new TypeError("fetch failed https://example.invalid/?api-key=test-dummy-key")), cachePath })(JUP_MINT);
    assert.equal(viaTypeError.dataStatus, "cached fallback");
    assert.equal(viaTypeError.fallbackCause, "TypeError");

    const live = await createTokenIntelProvider({ rpc: workingRpc, cachePath, now: () => new Date("2026-11-07T00:00:00.000Z") })(JUP_MINT);
    assert.equal(live.dataStatus, "live");
    assert.equal(Object.hasOwn(live, "fallbackCause"), false);
  });
});

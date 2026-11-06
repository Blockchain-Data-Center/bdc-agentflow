import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedKind } from "@x402/core/types";
import { paymentAsset, paymentNetwork } from "../src/config/networks.ts";
import { createServiceB, marketIntelBody, type MarketSnapshot, type ServiceBVariant } from "../src/services/service-b.ts";

const fixedAddress = (fill: number) => getBase58Decoder().decode(new Uint8Array(32).fill(fill));
const payTo = fixedAddress(9);
const feePayer = fixedAddress(7);
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

// A stand-in snapshot; its values are test values, not market data.
const snapshot: MarketSnapshot = {
  kind: "snapshot",
  notLive: true,
  source: "Jupiter Price API V3",
  sourceUrl: `https://api.jup.ag/price/v3?ids=${JUP}`,
  mint: JUP,
  asOf: "2026-01-01T00:00:00.000Z",
  capturedAt: "2026-01-01T00:00:00.001Z",
  priceUsd: 1.25,
  priceChange24hPct: -2.5,
  decimals: 6,
  blockId: 123,
};

// A complete SupportedResponse from a stand-in facilitator; verify and settle are never reached here.
const facilitator: FacilitatorClient = {
  getSupported: async () => ({
    kinds: [{ x402Version: 2, scheme: "exact", network: paymentNetwork, extra: { feePayer } } as SupportedKind],
    extensions: [],
    signers: {},
  }),
  verify: async () => {
    throw new Error("stand-in facilitator: verify not expected");
  },
  settle: async () => {
    throw new Error("stand-in facilitator: settle not expected");
  },
};

const servers: Server[] = [];
after(() => Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))));

async function start(variant: ServiceBVariant, failMode?: "unavailable"): Promise<number> {
  const app = createServiceB({ variant, payTo, facilitator, snapshot, ...(failMode ? { failMode } : {}) });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

// Local requests go through node:http, never the global fetch.
function get(port: number, path: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { accept: "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function assertUnpaid402(variant: ServiceBVariant, amount: string): Promise<void> {
  const hitsBefore = netGuardHits();
  const port = await start(variant);
  const res = await get(port, `/v1/market-intel?mint=${JUP}`);
  assert.equal(res.status, 402);
  const header = res.headers["payment-required"];
  assert.ok(header, "PAYMENT-REQUIRED header present");
  const required = decodePaymentRequiredHeader(header);
  assert.equal(required.x402Version, 2);
  assert.equal(required.accepts.length, 1);
  const [requirement] = required.accepts;
  assert.equal(requirement.scheme, "exact");
  assert.equal(requirement.network, paymentNetwork);
  assert.equal(requirement.asset, paymentAsset);
  assert.equal(requirement.amount, amount);
  assert.equal(requirement.payTo, payTo);
  assert.equal(netGuardHits(), hitsBefore);
}

describe("s3-service-b", () => {
  it("B1 unpaid GET /v1/market-intel returns 402 with a PAYMENT-REQUIRED header decoding to 4000", async () => {
    await assertUnpaid402("B1", "4000");
  });

  it("B2 unpaid GET /v1/market-intel returns 402 with a PAYMENT-REQUIRED header decoding to 8000", async () => {
    await assertUnpaid402("B2", "8000");
  });

  it("the paid-body builder labels dataStatus snapshot, with the snapshot's asOf and source; B2 adds its provider note", () => {
    const b1 = marketIntelBody("B1", snapshot);
    assert.deepEqual(b1, {
      serviceId: "svc-b1-market-intel",
      capability: "market-intelligence",
      mint: JUP,
      priceUsd: 1.25,
      priceChange24hPct: -2.5,
      decimals: 6,
      blockId: 123,
      dataStatus: "snapshot",
      asOf: snapshot.asOf,
      source: "Jupiter Price API V3",
    });
    const b2 = marketIntelBody("B2", snapshot);
    assert.deepEqual(b2, { ...b1, serviceId: "svc-b2-market-intel", providerNote: "alternative provider" });
  });

  it("B1 in failMode answers 503 SERVICE_UNAVAILABLE with no PAYMENT-REQUIRED header", async () => {
    const port = await start("B1", "unavailable");
    for (const path of [`/v1/market-intel?mint=${JUP}`, "/v1/market-intel"]) {
      const res = await get(port, path);
      assert.equal(res.status, 503);
      assert.deepEqual(JSON.parse(res.body), { error: "SERVICE_UNAVAILABLE", serviceId: "svc-b1-market-intel" });
      assert.equal(res.headers["payment-required"], undefined);
    }
  });
});

import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedKind } from "@x402/core/types";
import { paymentAsset, paymentNetwork } from "../src/config/networks.ts";
import { FacilitatorUnsupportedError, assertFacilitatorSupports } from "../src/payments/facilitator-preflight.ts";
import { createServiceA } from "../src/services/service-a.ts";
import type { TokenIntelBody } from "../src/services/token-intel.ts";

const fixedAddress = (fill: number) => getBase58Decoder().decode(new Uint8Array(32).fill(fill));
const payTo = fixedAddress(9);
const feePayer = fixedAddress(7);
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;

// A complete SupportedResponse from a stand-in facilitator; verify and settle are never reached here.
function standInFacilitator(kinds: SupportedKind[]): FacilitatorClient {
  return {
    getSupported: async () => ({ kinds, extensions: [], signers: {} }),
    verify: async () => {
      throw new Error("stand-in facilitator: verify not expected");
    },
    settle: async () => {
      throw new Error("stand-in facilitator: settle not expected");
    },
  };
}

const devnetKind: SupportedKind = { x402Version: 2, scheme: "exact", network: DEVNET, extra: { feePayer } };

const unusedTokenIntel = async (): Promise<TokenIntelBody> => {
  throw new Error("token intel not expected for an unpaid request");
};

// Local requests go through node:http, never the global fetch.
function get(port: number, path: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { accept: "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, body }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

let server: Server;
let port: number;

before(async () => {
  const app = createServiceA({ payTo, facilitator: standInFacilitator([devnetKind]), tokenIntel: unusedTokenIntel });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  port = (server.address() as AddressInfo).port;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("s1-service-a", () => {
  it("an unpaid GET /v1/token-intel returns 402 with a PAYMENT-REQUIRED header for exact / Devnet / Devnet USDC / 5000 / payTo", async () => {
    const hitsBefore = netGuardHits();
    const res = await get(port, "/v1/token-intel");
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
    assert.equal(requirement.amount, "5000");
    assert.equal(requirement.payTo, payTo);
    assert.equal(netGuardHits(), hitsBefore);
  });

  it("GET /v1/token-intel with another valid mint returns 400 UNSUPPORTED_MINT and no PAYMENT-REQUIRED header", async () => {
    const res = await get(port, `/v1/token-intel?mint=${paymentAsset}`);
    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(res.body), { error: "UNSUPPORTED_MINT" });
    assert.equal(res.headers["payment-required"], undefined);
  });

  it("assertFacilitatorSupports refuses three near-misses and passes on the exact V2 / exact / Devnet kind", async () => {
    const wanted = { x402Version: 2, scheme: "exact", network: DEVNET };
    const nearMisses: SupportedKind[] = [
      { ...devnetKind, x402Version: 1 },
      { ...devnetKind, scheme: "upto" },
      { ...devnetKind, network: MAINNET },
    ];
    for (const kind of nearMisses) {
      await assert.rejects(assertFacilitatorSupports(standInFacilitator([kind]), wanted), (error: unknown) => {
        assert.ok(error instanceof FacilitatorUnsupportedError);
        assert.equal(error.code, "FACILITATOR_UNSUPPORTED");
        assert.deepEqual(error.kinds, [kind]);
        return true;
      });
    }
    const exact: SupportedKind = { x402Version: 2, scheme: "exact", network: DEVNET };
    const match = await assertFacilitatorSupports(standInFacilitator([...nearMisses, exact]), wanted);
    assert.deepEqual(match, exact);
  });
});

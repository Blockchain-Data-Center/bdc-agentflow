import "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as networks from "../src/config/networks.ts";

describe("s1-config", () => {
  it("paymentNetwork is the Devnet CAIP-2", () => {
    assert.equal(networks.paymentNetwork, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });

  it("paymentAsset is the Devnet USDC mint", () => {
    assert.equal(networks.paymentAsset, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  });

  it("dataNetwork is the Mainnet CAIP-2, differs from paymentNetwork, and nothing is named network", () => {
    assert.equal(networks.dataNetwork, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    assert.notEqual(networks.dataNetwork, networks.paymentNetwork);
    assert.equal(Object.hasOwn(networks, "network"), false);
  });
});

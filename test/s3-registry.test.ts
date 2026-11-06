import "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paymentAsset, paymentNetwork } from "../src/config/networks.ts";
import { serviceB1, serviceB2, services } from "../src/registry/services.ts";

describe("s3-registry", () => {
  it("B1 and B2 are priced 4000n and 8000n, on ports 4022 and 4023, with the same capability", () => {
    const fields = [
      "capability",
      "endpointPath",
      "name",
      "paymentAsset",
      "paymentNetwork",
      "port",
      "priceAtomic",
      "priceUsd",
      "serviceId",
      "status",
    ];
    for (const entry of [serviceB1, serviceB2]) {
      assert.deepEqual(Object.keys(entry).sort(), fields);
      assert.equal(entry.capability, "market-intelligence");
      assert.equal(entry.endpointPath, "/v1/market-intel");
      assert.equal(entry.paymentNetwork, paymentNetwork);
      assert.equal(entry.paymentAsset, paymentAsset);
      assert.equal(entry.status, "active");
      assert.equal(Object.hasOwn(entry, "dataNetwork"), false);
      assert.equal(Object.hasOwn(entry, "payTo"), false);
    }
    assert.equal(serviceB1.serviceId, "svc-b1-market-intel");
    assert.equal(serviceB1.name, "Market Intel B1");
    assert.equal(serviceB1.priceAtomic, 4000n);
    assert.equal(serviceB1.priceUsd, "$0.004");
    assert.equal(serviceB1.port, 4022);
    assert.equal(serviceB2.serviceId, "svc-b2-market-intel");
    assert.equal(serviceB2.name, "Market Intel B2");
    assert.equal(serviceB2.priceAtomic, 8000n);
    assert.equal(serviceB2.priceUsd, "$0.008");
    assert.equal(serviceB2.port, 4023);
    assert.ok(services.includes(serviceB1) && services.includes(serviceB2));
  });

  it("no registry port is reserved (3000, 3002, 3005), and every port is one of 4021–4023", () => {
    for (const entry of services) {
      assert.ok(![3000, 3002, 3005].includes(entry.port), `${entry.serviceId} uses reserved port ${entry.port}`);
      assert.ok([4021, 4022, 4023].includes(entry.port), `${entry.serviceId} uses port ${entry.port}`);
    }
    assert.equal(new Set(services.map((entry) => entry.port)).size, services.length);
  });
});

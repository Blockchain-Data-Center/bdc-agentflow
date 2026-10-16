import "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dataNetwork, paymentAsset, paymentNetwork } from "../src/config/networks.ts";
import { serviceA, services } from "../src/registry/services.ts";

describe("s1-registry", () => {
  it("the Service A entry has every S3-Q6 field, priced 5000n / $0.005", () => {
    assert.deepEqual(Object.keys(serviceA).sort(), [
      "capability",
      "dataNetwork",
      "endpointPath",
      "name",
      "paymentAsset",
      "paymentNetwork",
      "port",
      "priceAtomic",
      "priceUsd",
      "serviceId",
      "status",
    ]);
    assert.equal(serviceA.serviceId, "svc-a-token-intel");
    assert.equal(serviceA.capability, "token-intelligence");
    assert.equal(serviceA.endpointPath, "/v1/token-intel");
    assert.equal(serviceA.priceAtomic, 5000n);
    assert.equal(serviceA.priceUsd, "$0.005");
    assert.equal(serviceA.paymentNetwork, paymentNetwork);
    assert.equal(serviceA.paymentAsset, paymentAsset);
    assert.equal(serviceA.status, "active");
    assert.equal(serviceA.dataNetwork, dataNetwork);
    assert.equal(Object.hasOwn(serviceA, "payTo"), false);
  });

  it("Service A is on port 4021 and no registry port is 3000, 3002 or 3005", () => {
    assert.equal(serviceA.port, 4021);
    for (const entry of services) {
      assert.ok(![3000, 3002, 3005].includes(entry.port), `${entry.serviceId} uses reserved port ${entry.port}`);
    }
  });
});

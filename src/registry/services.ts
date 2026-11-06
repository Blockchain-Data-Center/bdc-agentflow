// Service registry: data only. payTo is injected at runtime from wallets.public.json, never stored here.
import { dataNetwork, paymentAsset, paymentNetwork } from "../config/networks.ts";

export type ServiceEntry = {
  serviceId: string;
  name: string;
  capability: string;
  endpointPath: string;
  port: number;
  priceAtomic: bigint;
  priceUsd: string;
  paymentNetwork: string;
  paymentAsset: string;
  status: "active";
  dataNetwork?: string;
};

// A registry entry with the runtime payTo: what AgentFlow decided to buy.
export type ServiceQuote = ServiceEntry & { payTo: string };

export const serviceA: ServiceEntry = {
  serviceId: "svc-a-token-intel",
  name: "Token Intel A",
  capability: "token-intelligence",
  endpointPath: "/v1/token-intel",
  port: 4021,
  priceAtomic: 5000n,
  priceUsd: "$0.005",
  paymentNetwork,
  paymentAsset,
  status: "active",
  dataNetwork,
};

// Two providers of the same capability at different prices (FD-02, S3-Q2). Their data is a dated snapshot,
// not a chain read, so they carry no dataNetwork.
export const serviceB1: ServiceEntry = {
  serviceId: "svc-b1-market-intel",
  name: "Market Intel B1",
  capability: "market-intelligence",
  endpointPath: "/v1/market-intel",
  port: 4022,
  priceAtomic: 4000n,
  priceUsd: "$0.004",
  paymentNetwork,
  paymentAsset,
  status: "active",
};

export const serviceB2: ServiceEntry = {
  serviceId: "svc-b2-market-intel",
  name: "Market Intel B2",
  capability: "market-intelligence",
  endpointPath: "/v1/market-intel",
  port: 4023,
  priceAtomic: 8000n,
  priceUsd: "$0.008",
  paymentNetwork,
  paymentAsset,
  status: "active",
};

export const services: readonly ServiceEntry[] = [serviceA, serviceB1, serviceB2];

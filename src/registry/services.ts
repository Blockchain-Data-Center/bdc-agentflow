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

export const services: readonly ServiceEntry[] = [serviceA];

// Services B1 and B2: market intelligence behind an x402 paywall, from a dated snapshot kept in the project
// (S3-Q1, S3-Q2). The snapshot is labelled as such: it is not live market data.
// In failMode "unavailable" every request gets HTTP 503 before the payment middleware (S3-Q3), so no
// PAYMENT-REQUIRED header is ever sent and nothing can be paid. Mint validation also runs before the middleware.
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import type { FacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { paymentNetwork } from "../config/networks.ts";
import { serviceB1, serviceB2, type ServiceEntry } from "../registry/services.ts";
import { JUP_MINT } from "./token-intel.ts";

// The file data/snapshots/market-JUP.json, as written once by scripts/capture-market-snapshot.ts.
export type MarketSnapshot = {
  kind: "snapshot";
  notLive: true;
  source: string;
  sourceUrl: string;
  mint: string;
  asOf: string;
  capturedAt: string;
  priceUsd: number | null;
  priceChange24hPct: number | null;
  decimals: number | null;
  blockId: number | null;
};

export type ServiceBVariant = "B1" | "B2";

export type MarketIntelBody = {
  serviceId: string;
  capability: string;
  mint: string;
  priceUsd: number | null;
  priceChange24hPct: number | null;
  decimals: number | null;
  blockId: number | null;
  dataStatus: "snapshot";
  asOf: string;
  source: string;
  providerNote?: "alternative provider";
};

export const serviceBEntry = (variant: ServiceBVariant): ServiceEntry => (variant === "B1" ? serviceB1 : serviceB2);

// The paid response: the four snapshot fields, labelled "snapshot" with the snapshot's own asOf and source.
export function marketIntelBody(variant: ServiceBVariant, snapshot: MarketSnapshot): MarketIntelBody {
  const entry = serviceBEntry(variant);
  return {
    serviceId: entry.serviceId,
    capability: entry.capability,
    mint: snapshot.mint,
    priceUsd: snapshot.priceUsd,
    priceChange24hPct: snapshot.priceChange24hPct,
    decimals: snapshot.decimals,
    blockId: snapshot.blockId,
    dataStatus: "snapshot",
    asOf: snapshot.asOf,
    source: snapshot.source,
    ...(variant === "B2" ? { providerNote: "alternative provider" as const } : {}),
  };
}

export function createServiceB({
  variant,
  payTo,
  facilitator,
  snapshot,
  failMode,
}: {
  variant: ServiceBVariant;
  payTo: string;
  facilitator: FacilitatorClient;
  snapshot: MarketSnapshot;
  failMode?: "unavailable";
}): Express {
  const entry = serviceBEntry(variant);
  const app = express();

  if (failMode === "unavailable") {
    app.use((_req: Request, res: Response) => {
      res.status(503).json({ error: "SERVICE_UNAVAILABLE", serviceId: entry.serviceId });
    });
    return app;
  }

  const resourceServer = new x402ResourceServer(facilitator).register(paymentNetwork, new ExactSvmScheme());

  app.use(entry.endpointPath, (req: Request, res: Response, next: NextFunction) => {
    const mint = req.query.mint;
    if (mint === undefined || mint === JUP_MINT) return next();
    res.status(400).json({ error: "UNSUPPORTED_MINT" });
  });

  app.use(
    paymentMiddleware(
      {
        [`GET ${entry.endpointPath}`]: {
          accepts: { scheme: "exact", price: entry.priceUsd, network: paymentNetwork, payTo },
        },
      },
      resourceServer,
    ),
  );

  app.get(entry.endpointPath, (_req: Request, res: Response) => {
    res.json(marketIntelBody(variant, snapshot));
  });

  return app;
}

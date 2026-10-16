// Service A: token intelligence behind an x402 paywall, $0.005 Devnet USDC per request.
// Mint validation runs before the payment middleware, so nothing is paid for a request that cannot be served.
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import type { FacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { paymentNetwork } from "../config/networks.ts";
import { serviceA } from "../registry/services.ts";
import { JUP_MINT, type TokenIntelBody } from "./token-intel.ts";

export function createServiceA({
  payTo,
  facilitator,
  tokenIntel,
}: {
  payTo: string;
  facilitator: FacilitatorClient;
  tokenIntel: (mint: string) => Promise<TokenIntelBody>;
}): Express {
  const app = express();
  const resourceServer = new x402ResourceServer(facilitator).register(paymentNetwork, new ExactSvmScheme());

  app.use(serviceA.endpointPath, (req: Request, res: Response, next: NextFunction) => {
    const mint = req.query.mint;
    if (mint === undefined || mint === JUP_MINT) return next();
    res.status(400).json({ error: "UNSUPPORTED_MINT" });
  });

  app.use(
    paymentMiddleware(
      {
        [`GET ${serviceA.endpointPath}`]: {
          accepts: { scheme: "exact", price: serviceA.priceUsd, network: paymentNetwork, payTo },
        },
      },
      resourceServer,
    ),
  );

  app.get(serviceA.endpointPath, async (_req: Request, res: Response) => {
    try {
      res.json(await tokenIntel(JUP_MINT));
    } catch {
      res.status(500).json({ error: "DATA_UNAVAILABLE" });
    }
  });

  return app;
}

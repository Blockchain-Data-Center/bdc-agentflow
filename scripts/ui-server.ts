// The web UI server (S6-Q3, S6-Q6, S6-Q7): `npm run ui`, listening on 127.0.0.1:4020 only.
// The live wiring is a declared copy of scripts/e2e-devnet.ts's (finding C-AF-4, a refactor for after the hackathon):
// the facilitator and its preflight, the wallets, the buyer signer and the x402 client, Services A, B1 and B2 on
// 4021–4023, quoteFor, payAndFetchFor and the Claude client. e2e-devnet.ts is not changed.
// - At start-up only: the Claude client (a failure to create it takes the labelled deterministic path, as in e2e;
//   --llm-off is not offered in the UI), the ports 4020–4023, the facilitator preflight, the wallet file, the signer,
//   the market snapshot and the token-intel provider. Any failure stops the server with one clear line.
// - For each run (startRun): the budget is re-checked (1000–50000 atomic); Services A, B1 and B2 are started (B1 in
//   failMode "unavailable" when the failure switch is on; B2 always, a real Tender candidate); the ledger and the
//   session budget are the user's value, the per-service cap, network and asset stay the policy's; runAgent runs
//   with onEvent; the three services are stopped in finally, also when one fails to start. Nothing inside a run
//   calls process.exit: a failure is a thrown error, reported to the browser by its class name only.
// The UI receives no secret value: the signer and the API key stay in their own modules, as in e2e.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { runAgent } from "../src/agentflow/run-agent.ts";
import { SESSION_HOST } from "../src/agentflow/run-session.ts";
import { CLAUDE_MODEL, createClaudeClient, type Complete } from "../src/llm/claude.ts";
import { createPayingFetch } from "../src/payments/client.ts";
import { FacilitatorUnsupportedError, assertFacilitatorSupports } from "../src/payments/facilitator-preflight.ts";
import type { PayAndFetch } from "../src/payments/purchase.ts";
import * as policyRules from "../src/policy/rules.ts";
import { createLedger } from "../src/policy/session.ts";
import { serviceA, serviceB1, serviceB2, services, type ServiceEntry, type ServiceQuote } from "../src/registry/services.ts";
import { createServiceA } from "../src/services/service-a.ts";
import { createServiceB, type MarketSnapshot } from "../src/services/service-b.ts";
import { createTokenIntelProvider, createTokenIntelRpc } from "../src/services/token-intel.ts";
import { loadBuyerSigner } from "../src/signer/buyer-signer.ts";
import { createUiApp, MAX_BUDGET_ATOMIC, MIN_BUDGET_ATOMIC, UI_HOST, UI_PORT, type StartRun } from "../src/ui/app.ts";

const FACILITATOR_URL = "https://x402.org/facilitator";
const PORTS = [UI_PORT, serviceA.port, serviceB1.port, serviceB2.port];

// A start-up failure: one clear line, then exit. Never called once the UI is listening.
function stop(message: string): never {
  console.error(`ui: cannot start: ${message}`);
  process.exit(1);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const errorCode = (error: unknown) => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);

// Listens, or rejects with the listen error (e.g. a port in use).
function listenOn(handler: Express, port: number, host: string): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

const listen = (app: Express, entry: ServiceEntry) => listenOn(app, entry.port, SESSION_HOST);

// Stops accepting connections, drops the open ones, and resolves once the server is closed.
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

// A port is free when a plain TCP server can listen on it on 127.0.0.1; it is closed at once.
function assertPortFree(port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const probe = createNetServer();
    probe.once("error", (error) =>
      stop(errorCode(error) === "EADDRINUSE" ? `port ${port} is already in use` : `port ${port} cannot be opened (${String(errorCode(error) ?? "error")})`),
    );
    probe.listen(port, UI_HOST, () => probe.close(() => resolve()));
  });
}

async function main(): Promise<void> {
  // The LLM client; a failure to create it takes the labelled deterministic path (R8). Only its message, which
  // names the variable and never its value, is printed.
  let llm: Complete | undefined;
  try {
    llm = createClaudeClient().complete;
    console.log(`ui: LLM ${CLAUDE_MODEL}`);
  } catch (error) {
    console.log(`ui: LLM unavailable (${errorText(error)}); the labelled deterministic plan and summary are used`);
  }

  for (const port of PORTS) await assertPortFree(port);

  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  try {
    await assertFacilitatorSupports(facilitator, { x402Version: 2, scheme: "exact", network: policyRules.allowedPaymentNetwork });
    console.log("ui: facilitator preflight PASS");
  } catch (error) {
    stop(error instanceof FacilitatorUnsupportedError ? `facilitator preflight: ${error.code}` : "facilitator preflight: FACILITATOR_UNREACHABLE");
  }

  let wallets: { buyer: string; seller: string };
  try {
    wallets = JSON.parse(readFileSync(new URL("../wallets.public.json", import.meta.url), "utf8")) as { buyer: string; seller: string };
  } catch {
    stop("wallets.public.json is missing or unreadable");
  }
  let signer: Awaited<ReturnType<typeof loadBuyerSigner>>;
  try {
    signer = await loadBuyerSigner();
  } catch (error) {
    stop(`the buyer signer cannot be loaded (${errorText(error)})`);
  }
  if (signer.address !== wallets.buyer) stop("the buyer signer does not match wallets.public.json");

  let snapshot: MarketSnapshot;
  try {
    snapshot = JSON.parse(readFileSync(new URL("../data/snapshots/market-JUP.json", import.meta.url), "utf8")) as MarketSnapshot;
  } catch {
    stop("data/snapshots/market-JUP.json is missing or unreadable");
  }
  let tokenIntel: ReturnType<typeof createTokenIntelProvider>;
  try {
    tokenIntel = createTokenIntelProvider({
      rpc: createTokenIntelRpc(),
      cachePath: fileURLToPath(new URL("../data/cache/token-intel-JUP.json", import.meta.url)),
    });
  } catch (error) {
    stop(`the token-intel provider cannot be created (${errorText(error)})`);
  }

  const quoteFor = (serviceId: string): ServiceQuote => {
    const entry = services.find((candidate) => candidate.serviceId === serviceId);
    if (!entry) throw new Error(`no registry entry ${serviceId}`);
    return { ...entry, payTo: wallets.seller };
  };

  // One paying fetch per purchase; never throws: an error is returned with the count of signed requests.
  const payAndFetchFor = (quote: ServiceQuote): PayAndFetch => {
    const paying = createPayingFetch({ signer, quote });
    return async (target) => {
      try {
        const response = await paying.fetch(target);
        return { response, signedRequestsSent: paying.signedRequestsSent() };
      } catch (error) {
        return { error, signedRequestsSent: paying.signedRequestsSent() };
      }
    };
  };

  const startRun: StartRun = async ({ runId, goal, budgetAtomic, simulateFailure, onEvent }) => {
    if (budgetAtomic < MIN_BUDGET_ATOMIC || budgetAtomic > MAX_BUDGET_ATOMIC) throw new RangeError("the session budget is outside $0.001–$0.05");
    console.log(`ui: ${runId} started (budget ${budgetAtomic} atomic${simulateFailure ? ", B1 unavailable (simulated)" : ""})`);
    const servers: Server[] = [];
    try {
      servers.push(await listen(createServiceA({ payTo: wallets.seller, facilitator, tokenIntel }), serviceA));
      servers.push(
        await listen(
          createServiceB({ variant: "B1", payTo: wallets.seller, facilitator, snapshot, ...(simulateFailure ? { failMode: "unavailable" as const } : {}) }),
          serviceB1,
        ),
      );
      servers.push(await listen(createServiceB({ variant: "B2", payTo: wallets.seller, facilitator, snapshot }), serviceB2));
      const run = await runAgent({
        goal,
        llm,
        llmOff: false,
        candidates: services,
        ledger: createLedger(budgetAtomic),
        rules: { ...policyRules, sessionBudgetAtomic: budgetAtomic },
        quoteFor,
        payAndFetchFor,
        now: () => new Date(),
        runId,
        onEvent,
      });
      console.log(`ui: ${runId} done, remaining ${run.procurement.ledgerRemainingAtomic} atomic, resultSource ${run.result.resultSource}`);
      return run;
    } catch (error) {
      console.log(`ui: ${runId} failed (${error instanceof Error ? error.constructor.name : typeof error})`);
      throw error;
    } finally {
      await Promise.all(servers.map(closeServer));
    }
  };

  const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
  let ui: Server;
  try {
    ui = await listenOn(createUiApp({ startRun, publicDir }), UI_PORT, UI_HOST);
  } catch (error) {
    stop(errorCode(error) === "EADDRINUSE" ? `port ${UI_PORT} is already in use` : `the UI cannot listen (${errorCode(error) ?? "error"})`);
  }
  console.log(`ui: BDC AgentFlow on http://${UI_HOST}:${UI_PORT} (Solana Devnet only; Devnet USDC, no real value)`);

  const shutdown = () => {
    ui.closeAllConnections();
    ui.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

await main();

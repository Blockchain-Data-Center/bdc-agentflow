// The web UI's HTTP app (S6-Q2, S6-Q4): one page and its logo from publicDir, and a JSON/SSE API.
// - POST /api/run { goal, budgetUsd, simulateFailure }: validated here, never trusted from the browser; one run at a
//   time (409); 202 { runId }, the runId generated here and passed to startRun, so it equals the receipts' run id.
// - GET /api/runs/:runId/events: Server-Sent Events: every event recorded so far, then each new one, as
//   "event: agent"; then one "event: done" (the AgentRun, bigints as decimal strings, bodyText omitted) or one
//   "event: failed" ({ error: <class name> } only), then the end of the response. Only the latest run is kept.
// - A Host other than 127.0.0.1:4020 or localhost:4020 gets 403; every response carries the Content-Security-Policy;
//   no CORS header is ever set; every error is { error: <short code> }, with no stack trace or local path.
// It has no I/O of its own beyond serving publicDir: the run itself is the injected startRun. It reads no environment
// variable and imports from src/agentflow only types (U12): the signer, the payment client and the LLM are never
// reachable from here.
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import type { AgentEvent } from "../agentflow/events.ts";
import type { AgentRun } from "../agentflow/run-agent.ts";

export const UI_HOST = "127.0.0.1";
export const UI_PORT = 4020;
export const ALLOWED_HOSTS: readonly string[] = [`${UI_HOST}:${UI_PORT}`, `localhost:${UI_PORT}`];
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const MIN_BUDGET_ATOMIC = 1_000n;
export const MAX_BUDGET_ATOMIC = 50_000n;
const MAX_GOAL_CODE_POINTS = 500;
const BUDGET_USD = /^0\.\d{1,3}$/;

export type StartRun = (input: {
  runId: string;
  goal: string;
  budgetAtomic: bigint;
  simulateFailure: boolean;
  onEvent: (event: AgentEvent) => void;
}) => Promise<AgentRun>;

type RunState = {
  runId: string;
  events: AgentEvent[];
  end?: { name: "done" | "failed"; data: string };
  subscribers: Set<Response>;
};

// "$x" with at most three decimals, as a string, to atomic units (6 decimals) without floating-point arithmetic.
export function budgetUsdToAtomic(budgetUsd: string): bigint {
  const [whole, fraction] = budgetUsd.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

// The AgentRun as JSON for the browser: bigints as decimal strings, every bodyText omitted, bodies kept.
export function serializeRun(run: AgentRun): string {
  return JSON.stringify(run, (key, value: unknown) => (key === "bodyText" ? undefined : typeof value === "bigint" ? value.toString() : value));
}

const className = (error: unknown) =>
  error instanceof Error ? error.constructor.name : typeof error;

const sendEvent = (res: Response, name: string, data: string) => void res.write(`event: ${name}\ndata: ${data}\n\n`);

export function createUiApp({ startRun, publicDir }: { startRun: StartRun; publicDir: string }): Express {
  const app = express();
  app.disable("x-powered-by");
  let latest: RunState | undefined;
  let running = false;

  const finish = (state: RunState, end: NonNullable<RunState["end"]>) => {
    state.end = end;
    for (const subscriber of state.subscribers) {
      sendEvent(subscriber, end.name, end.data);
      subscriber.end();
    }
    state.subscribers.clear();
  };

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    next();
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!ALLOWED_HOSTS.includes(req.headers.host ?? "")) {
      res.status(403).json({ error: "forbidden-host" });
      return;
    }
    next();
  });

  app.post(
    "/api/run",
    (req: Request, res: Response, next: NextFunction) => {
      if (req.is("application/json") !== "application/json") {
        res.status(415).json({ error: "unsupported-media-type" });
        return;
      }
      next();
    },
    express.json({ limit: "4kb" }),
    (req: Request, res: Response) => {
      const body: Record<string, unknown> = typeof req.body === "object" && req.body !== null && !Array.isArray(req.body) ? req.body : {};

      const goal = typeof body.goal === "string" ? body.goal.trim() : undefined;
      const goalLength = goal === undefined ? 0 : [...goal].length;
      if (goal === undefined || goalLength < 1 || goalLength > MAX_GOAL_CODE_POINTS) {
        res.status(400).json({ error: "goal" });
        return;
      }
      const budgetUsd = body.budgetUsd;
      const budgetAtomic = typeof budgetUsd === "string" && BUDGET_USD.test(budgetUsd) ? budgetUsdToAtomic(budgetUsd) : undefined;
      if (budgetAtomic === undefined || budgetAtomic < MIN_BUDGET_ATOMIC || budgetAtomic > MAX_BUDGET_ATOMIC) {
        res.status(400).json({ error: "budgetUsd" });
        return;
      }
      const simulateFailure = body.simulateFailure;
      if (typeof simulateFailure !== "boolean") {
        res.status(400).json({ error: "simulateFailure" });
        return;
      }
      if (running) {
        res.status(409).json({ error: "run-in-progress" });
        return;
      }

      const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const state: RunState = { runId, events: [], subscribers: new Set() };
      latest = state;
      running = true;
      const onEvent = (event: AgentEvent) => {
        if (state.end !== undefined) return;
        state.events.push(event);
        const data = JSON.stringify(event);
        for (const subscriber of state.subscribers) sendEvent(subscriber, "agent", data);
      };
      let run: Promise<AgentRun>;
      try {
        run = startRun({ runId, goal, budgetAtomic, simulateFailure, onEvent });
      } catch (error) {
        run = Promise.reject(error);
      }
      // The lock is released only when startRun has settled, i.e. after its services have stopped (U9).
      run.then(
        (result) => {
          finish(state, { name: "done", data: serializeRun(result) });
          running = false;
        },
        (error: unknown) => {
          finish(state, { name: "failed", data: JSON.stringify({ error: className(error) }) });
          running = false;
        },
      );
      res.status(202).json({ runId });
    },
  );

  app.get("/api/runs/:runId/events", (req: Request, res: Response) => {
    const state = latest;
    if (state === undefined || state.runId !== req.params.runId) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.flushHeaders();
    for (const event of state.events) sendEvent(res, "agent", JSON.stringify(event));
    if (state.end !== undefined) {
      sendEvent(res, state.end.name, state.end.data);
      res.end();
      return;
    }
    state.subscribers.add(res);
    req.on("close", () => state.subscribers.delete(res));
  });

  app.use(express.static(publicDir, { index: "index.html", dotfiles: "ignore" }));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not-found" });
  });

  // Malformed JSON, a body over 4 KB and every other error: a short code only.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = typeof error === "object" && error !== null ? (error as { type?: unknown }).type : undefined;
    const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
    if (res.headersSent) {
      res.end();
      return;
    }
    if (type === "entity.too.large") {
      res.status(413).json({ error: "too-large" });
    } else if (type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid-json" });
    } else if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ error: "bad-request" });
    } else {
      res.status(500).json({ error: "internal" });
    }
  });

  return app;
}

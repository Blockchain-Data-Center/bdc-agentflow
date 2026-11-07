import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "../src/agentflow/events.ts";
import type { AgentRun } from "../src/agentflow/run-agent.ts";
import { CONTENT_SECURITY_POLICY, createUiApp, type StartRun } from "../src/ui/app.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(repoRoot, "public");
// The logo's size and SHA-256 as constants (U11): the copy of bdc-logo-primary.ed5ab696.svg.
const LOGO_BYTES = 15911;
const LOGO_SHA256 = "ed5ab696e13e2c2d1ce9419944daf80994df968f42129636144465ffc67e1331";
const HOST = "127.0.0.1:4020";
const GOAL = "Create a Solana token risk and market intelligence report. Maximum budget: $0.05.";

type Reply = { status: number; headers: IncomingHttpHeaders; body: string; bytes: Buffer };

// Every request through node:http (the net guard blocks fetch), with an explicit Host header.
function send(port: number, method: string, path: string, options: { host?: string; json?: unknown; raw?: string; contentType?: string } = {}): Promise<Reply> {
  const payload = options.raw ?? (options.json !== undefined ? JSON.stringify(options.json) : undefined);
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: options.host ?? HOST,
          ...(payload !== undefined ? { "content-type": options.contentType ?? "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: bytes.toString("utf8"), bytes });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const fakeRun = (): AgentRun => ({
  plan: { interpretation: "A risk and market report on JUP.", capabilities: ["token-intelligence"], token: "JUP", unsupported: [], planSource: "llm" },
  procurement: {
    rounds: [],
    receipts: [],
    events: [],
    deliveries: [{ capability: "token-intelligence", serviceId: "svc-a-token-intel", bodyText: '{"supplyUi":"6999215711.06"}', body: { supplyUi: "6999215711.06" } }],
    unfulfilled: [],
    undelivered: [],
    ledgerRemainingAtomic: 45_000n,
    stoppedEarly: false,
    reliability: { "svc-a-token-intel": { successes: 1, failures: 0 } },
  },
  result: { text: "JUP report.", resultSource: "llm" },
  events: [],
  usage: { inputTokens: 10, outputTokens: 5 },
});

const event = (name: AgentEvent["name"], detail: string): AgentEvent => ({ name, at: "2026-11-07T12:00:00.000Z", detail });

async function withApp(startRun: StartRun, body: (port: number) => Promise<void>): Promise<void> {
  const server: Server = await new Promise((resolvePromise) => {
    const listening = createUiApp({ startRun, publicDir }).listen(0, "127.0.0.1", () => resolvePromise(listening));
  });
  try {
    await body((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

// "event: x\ndata: y" blocks of an SSE body.
const sseBlocks = (text: string) =>
  text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      return { event: lines.find((line) => line.startsWith("event: "))?.slice(7), data: lines.find((line) => line.startsWith("data: "))?.slice(6) };
    });

describe("s6-ui-api", () => {
  it("(1) POST /api/run validates on the server: each bad field → 400 with its name; over 4 KB → 413; a valid body → 202 and the exact atomic budget", async () => {
    const hitsBefore = netGuardHits();
    const received: Parameters<StartRun>[0][] = [];
    const startRun: StartRun = async (input) => {
      received.push(input);
      return fakeRun();
    };
    await withApp(startRun, async (port) => {
      const valid = { goal: GOAL, budgetUsd: "0.05", simulateFailure: false };
      const cases: [Record<string, unknown>, string][] = [
        [{ ...valid, goal: "   " }, "goal"],
        [{ ...valid, goal: "x".repeat(501) }, "goal"],
        [{ ...valid, goal: 7 }, "goal"],
        [{ ...valid, budgetUsd: "0" }, "budgetUsd"],
        [{ ...valid, budgetUsd: "0.0505" }, "budgetUsd"],
        [{ ...valid, budgetUsd: "0.0011" }, "budgetUsd"],
        [{ ...valid, budgetUsd: "0.1" }, "budgetUsd"],
        [{ ...valid, budgetUsd: "0.000" }, "budgetUsd"],
        [{ ...valid, budgetUsd: 0.05 }, "budgetUsd"],
        [{ ...valid, budgetUsd: "abc" }, "budgetUsd"],
        [{ ...valid, simulateFailure: "true" }, "simulateFailure"],
        [{ ...valid, simulateFailure: undefined }, "simulateFailure"],
      ];
      for (const [body, field] of cases) {
        const reply = await send(port, "POST", "/api/run", { json: body });
        assert.equal(reply.status, 400, JSON.stringify(body).slice(0, 80));
        assert.deepEqual(JSON.parse(reply.body), { error: field });
      }
      const tooLarge = await send(port, "POST", "/api/run", { json: { ...valid, goal: "x".repeat(5000) } });
      assert.equal(tooLarge.status, 413);
      assert.deepEqual(JSON.parse(tooLarge.body), { error: "too-large" });
      const malformed = await send(port, "POST", "/api/run", { raw: '{"goal":' });
      assert.equal(malformed.status, 400);
      assert.deepEqual(JSON.parse(malformed.body), { error: "invalid-json" });
      const wrongType = await send(port, "POST", "/api/run", { raw: "goal=x", contentType: "application/x-www-form-urlencoded" });
      assert.equal(wrongType.status, 415);
      assert.deepEqual(JSON.parse(wrongType.body), { error: "unsupported-media-type" });
      assert.equal(received.length, 0, "no run started by an invalid request");

      const accepted = await send(port, "POST", "/api/run", { json: { goal: `  ${GOAL}  `, budgetUsd: "0.008", simulateFailure: true } });
      assert.equal(accepted.status, 202);
      const { runId } = JSON.parse(accepted.body) as { runId: string };
      assert.match(runId, /^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
      assert.equal(received.length, 1);
      assert.equal(received[0].budgetAtomic, 8000n);
      assert.equal(received[0].goal, GOAL, "the trimmed goal is used");
      assert.equal(received[0].simulateFailure, true);
      assert.equal(received[0].runId, runId, "the app's runId is the run's");
    });
    assert.equal(netGuardHits(), hitsBefore);
  });

  it("(2) a second POST while a run is in progress → 409", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolvePromise) => (release = resolvePromise));
    let started = 0;
    const startRun: StartRun = async () => {
      started += 1;
      await gate;
      return fakeRun();
    };
    await withApp(startRun, async (port) => {
      const body = { json: { goal: GOAL, budgetUsd: "0.05", simulateFailure: false } };
      assert.equal((await send(port, "POST", "/api/run", body)).status, 202);
      const second = await send(port, "POST", "/api/run", body);
      assert.equal(second.status, 409);
      assert.deepEqual(JSON.parse(second.body), { error: "run-in-progress" });
      assert.equal(started, 1);
      release();
    });
  });

  it("(3) the SSE stream: each event as event: agent, then done with bigints as strings and no bodyText; a throwing run → failed with the class name only; unknown runId → 404", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolvePromise) => (release = resolvePromise));
    const startRun: StartRun = async ({ onEvent }) => {
      onEvent(event("PLAN_CREATED", "planSource: llm"));
      await gate;
      onEvent(event("RESULT_COMPOSED", "resultSource: llm"));
      return fakeRun();
    };
    await withApp(startRun, async (port) => {
      const { runId } = JSON.parse((await send(port, "POST", "/api/run", { json: { goal: GOAL, budgetUsd: "0.05", simulateFailure: false } })).body) as { runId: string };
      const stream = send(port, "GET", `/api/runs/${runId}/events`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      release();
      const reply = await stream;
      assert.equal(reply.status, 200);
      assert.equal(reply.headers["content-type"], "text/event-stream");
      const blocks = sseBlocks(reply.body);
      assert.deepEqual(blocks.map((block) => block.event), ["agent", "agent", "done"]);
      assert.deepEqual(JSON.parse(blocks[0].data ?? ""), event("PLAN_CREATED", "planSource: llm"));
      assert.deepEqual(JSON.parse(blocks[1].data ?? ""), event("RESULT_COMPOSED", "resultSource: llm"));
      const done = JSON.parse(blocks[2].data ?? "") as { procurement: { ledgerRemainingAtomic: unknown; deliveries: Record<string, unknown>[] } };
      assert.equal(done.procurement.ledgerRemainingAtomic, "45000");
      assert.deepEqual(done.procurement.deliveries, [{ capability: "token-intelligence", serviceId: "svc-a-token-intel", body: { supplyUi: "6999215711.06" } }]);
      assert.ok(!blocks[2].data?.includes("bodyText"));

      // A late subscriber gets every event, then done, then the end.
      const late = sseBlocks((await send(port, "GET", `/api/runs/${runId}/events`)).body);
      assert.deepEqual(late.map((block) => block.event), ["agent", "agent", "done"]);

      assert.equal((await send(port, "GET", "/api/runs/run-unknown/events")).status, 404);
    });

    const throwing: StartRun = async ({ onEvent }) => {
      onEvent(event("PLAN_CREATED", "planSource: llm"));
      throw new TypeError("a detail with /Users/somebody/path that must not reach the browser");
    };
    await withApp(throwing, async (port) => {
      const { runId } = JSON.parse((await send(port, "POST", "/api/run", { json: { goal: GOAL, budgetUsd: "0.05", simulateFailure: false } })).body) as { runId: string };
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      const reply = await send(port, "GET", `/api/runs/${runId}/events`);
      const blocks = sseBlocks(reply.body);
      assert.deepEqual(blocks.map((block) => block.event), ["agent", "failed"]);
      assert.deepEqual(JSON.parse(blocks[1].data ?? ""), { error: "TypeError" });
      assert.ok(!reply.body.includes("/Users/"));
      // The lock is released after the failure: a new run is accepted, and the earlier runId is gone.
      assert.equal((await send(port, "POST", "/api/run", { json: { goal: GOAL, budgetUsd: "0.05", simulateFailure: false } })).status, 202);
      assert.equal((await send(port, "GET", `/api/runs/${runId}/events`)).status, 404);
    });
  });

  it("(4) the page, the logo, the Host check, the CSP on every response, no CORS header, and type-only imports from src/agentflow", async () => {
    const startRun: StartRun = async () => fakeRun();
    await withApp(startRun, async (port) => {
      const replies: Reply[] = [];
      const get = async (path: string, host?: string) => {
        const reply = await send(port, "GET", path, host !== undefined ? { host } : {});
        replies.push(reply);
        return reply;
      };
      const page = await get("/");
      assert.equal(page.status, 200);
      assert.match(page.body, /<title>BDC AgentFlow<\/title>/);
      for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML"]) assert.ok(!page.body.includes(sink), `index.html uses ${sink}`);
      assert.equal(page.body, readFileSync(join(publicDir, "index.html"), "utf8"));

      const logo = await get("/bdc-logo.svg");
      assert.equal(logo.status, 200);
      assert.equal(logo.bytes.length, LOGO_BYTES);
      assert.equal(createHash("sha256").update(logo.bytes).digest("hex"), LOGO_SHA256);

      const evil = await get("/", "evil.example");
      assert.equal(evil.status, 403);
      assert.deepEqual(JSON.parse(evil.body), { error: "forbidden-host" });
      assert.equal((await get("/", "localhost:4020")).status, 200);
      assert.equal((await get("/", "127.0.0.1:4021")).status, 403);
      assert.equal((await get("/nothing-here")).status, 404);
      replies.push(await send(port, "POST", "/api/run", { json: { goal: "" } }));
      replies.push(await send(port, "OPTIONS", "/api/run"));

      for (const reply of replies) {
        assert.equal(reply.headers["content-security-policy"], CONTENT_SECURITY_POLICY);
        assert.equal(reply.headers["access-control-allow-origin"], undefined);
      }
    });

    // U12: src/ui/app.ts imports from src/agentflow with import type only, and nothing from the signer, the payment
    // client, the LLM client or scripts/.
    const source = readFileSync(join(repoRoot, "src", "ui", "app.ts"), "utf8");
    const imports = [...source.matchAll(/^\s*(import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)].map((match) => ({ statement: match[0].trim(), target: match[2] }));
    const agentflow = imports.filter(({ target }) => target.startsWith("../agentflow/"));
    assert.ok(agentflow.length > 0);
    for (const { statement } of agentflow) assert.match(statement, /^import type\b/, statement);
    for (const { target } of imports) assert.ok(!/signer|payments\/client|llm\/claude|scripts\//.test(target), target);
    assert.ok(!/process\s*\.\s*env|process\s*\[/.test(source), "app.ts reads the environment");
    assert.ok(!/\bimport\s*\(/.test(source), "app.ts has a dynamic import");
  });
});

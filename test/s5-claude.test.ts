import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeError, createClaudeClient } from "../src/llm/claude.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DUMMY_KEY = "test-dummy-key";
const KEY = "ANTHROPIC_API_KEY";

// The dummy key only, set for this test process and restored after.
const saved = process.env[KEY];
before(() => {
  process.env[KEY] = DUMMY_KEY;
});
after(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

type Call = { url: string; init: RequestInit };

// A stand-in fetch: records each call and answers with the given function. No network.
function standIn(answer: (init: RequestInit) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer(init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const message = (fields: Record<string, unknown>) => new Response(JSON.stringify(fields), { status: 200, headers: { "content-type": "application/json" } });

const rel = (path: string) => relative(repoRoot, path).split(sep).join("/");
function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|mts|cts|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe("s5-claude", () => {
  it("(1) one POST to the Messages API with the three headers, the model, max_tokens and effort low; format only with a schema; text from the text blocks; usage returned", async () => {
    const hitsBefore = netGuardHits();
    const { fetchImpl, calls } = standIn(() =>
      message({
        content: [
          { type: "thinking", thinking: "first a thinking block" },
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 34 },
      }),
    );
    const client = createClaudeClient({ fetchImpl });

    const plain = await client.complete({ system: "the system", user: "the user", maxTokens: 4000 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(calls[0].init.headers, {
      Authorization: `Bearer ${DUMMY_KEY}`,
      "anthropic-version": "2026-10-21",
      "content-type": "application/json",
    });
    assert.ok(calls[0].init.signal instanceof AbortSignal, "the call carries its timeout signal");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      model: "claude-haiku-5-5",
      max_tokens: 4000,
      system: "the system",
      messages: [{ role: "user", content: "the user" }],
      output_config: { effort: "low" },
    });
    assert.deepEqual(plain, { text: "hello world", usage: { inputTokens: 12, outputTokens: 34 } });

    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
    await client.complete({ system: "s", user: "u", maxTokens: 4000, jsonSchema: schema });
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(String(calls[1].init.body)).output_config, { effort: "low", format: { type: "json_schema", schema } });
    assert.equal(netGuardHits(), hitsBefore);
  });

  it("(2) errors: HTTP 500 after one call, max-tokens, refusal, timeout, no-text, invalid-json, network-error; usage carried; no key, Bearer or header in any message; missing key", async () => {
    const hitsBefore = netGuardHits();
    const failures: ClaudeError[] = [];
    const expectError = async (answer: Parameters<typeof standIn>[0], status: string, usage = { inputTokens: 0, outputTokens: 0 }, timeoutMs?: number) => {
      const { fetchImpl, calls } = standIn(answer);
      const client = createClaudeClient({ fetchImpl, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      await assert.rejects(client.complete({ system: "s", user: "u", maxTokens: 4000 }), (error: unknown) => {
        assert.ok(error instanceof ClaudeError);
        assert.equal(error.message, `messages failed: ${status}`);
        assert.equal(error.status, status);
        assert.deepEqual(error.usage, usage);
        failures.push(error);
        return true;
      });
      assert.equal(calls.length, 1, `${status}: exactly one call, no retry`);
    };

    await expectError(() => new Response('{"type":"error","error":{"type":"api_error","message":"body text"}}', { status: 500 }), "HTTP 500");
    await expectError(
      () => message({ content: [{ type: "thinking", thinking: "…" }], stop_reason: "max_tokens", usage: { input_tokens: 50, output_tokens: 4000 } }),
      "max-tokens",
      { inputTokens: 50, outputTokens: 4000 },
    );
    await expectError(() => message({ content: [], stop_reason: "refusal", usage: { input_tokens: 7, output_tokens: 3 } }), "refusal", { inputTokens: 7, outputTokens: 3 });
    // The call's own timeout aborts a call that never answers. AbortSignal.timeout's timer does not hold the event
    // loop open, so the stand-in holds it (a real fetch would) until the abort.
    await expectError(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          const hold = setTimeout(() => undefined, 10_000);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(hold);
            reject(init.signal?.reason);
          });
        }),
      "timeout",
      undefined,
      5,
    );
    await expectError(() => message({ content: [{ type: "thinking", thinking: "…" }], stop_reason: "end_turn", usage: { input_tokens: 9 } }), "no-text", { inputTokens: 9, outputTokens: 0 });
    await expectError(() => new Response("not json", { status: 200 }), "invalid-json");
    await expectError(() => Promise.reject(new TypeError("fetch failed")), "network-error");

    for (const error of failures) {
      const text = `${error.name} ${error.message} ${JSON.stringify(error)} ${String(error.stack)}`;
      for (const forbidden of [DUMMY_KEY, "Bearer", "Authorization", "anthropic-version", "body text"]) {
        assert.ok(!text.includes(forbidden), `${error.message} carries ${forbidden}`);
      }
    }

    // Missing key: fails naming the variable only, before any call.
    delete process.env[KEY];
    const { fetchImpl, calls } = standIn(() => message({}));
    assert.throws(() => createClaudeClient({ fetchImpl }), { message: "ANTHROPIC_API_KEY is not set" });
    assert.equal(calls.length, 0);
    process.env[KEY] = DUMMY_KEY;
    assert.equal(netGuardHits(), hitsBefore);
  });

  it("(3) source scan of src/ and scripts/: ANTHROPIC_API_KEY occurs only in src/llm/claude.ts", () => {
    const files = [...sourceFiles(join(repoRoot, "src")), ...sourceFiles(join(repoRoot, "scripts"))]
      .filter((file) => readFileSync(file, "utf8").includes("ANTHROPIC_API_KEY"))
      .map(rel)
      .sort();
    assert.deepEqual(files, ["src/llm/claude.ts"]);
  });
});

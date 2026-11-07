// The Claude API client (S5-Q1, FD-17): one POST to the Messages API with plain fetch, no package, Claude Haiku 5.5.
// ANTHROPIC_API_KEY is read here only, when the client is created (S5-Q3); a missing key fails naming the variable
// only. The key travels in a header, so no header, the key or the response body is ever logged, printed or thrown:
// errors are ClaudeError "messages failed: <status>" and carry the token counts, zero when unknown (R7).
// One attempt, no retry; each call is bounded by the timeout, the body read included (S5-Q7).
// The LLM never receives signing material and never reaches the signer: this module imports no project code.

const KEY_VARIABLE = "ANTHROPIC_API_KEY";

export const CLAUDE_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const CLAUDE_MODEL = "claude-haiku-5-5";
export const ANTHROPIC_VERSION = "2026-10-21";
export const CLAUDE_TIMEOUT_MS = 20000;

export type ClaudeUsage = { inputTokens: number; outputTokens: number };
export const ZERO_USAGE: ClaudeUsage = { inputTokens: 0, outputTokens: 0 };
export const addUsage = (a: ClaudeUsage, b: ClaudeUsage): ClaudeUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

export type ClaudeStatus = `HTTP ${number}` | "timeout" | "network-error" | "invalid-json" | "max-tokens" | "refusal" | "no-text";

export class ClaudeError extends Error {
  readonly status: ClaudeStatus;
  readonly usage: ClaudeUsage;

  constructor(status: ClaudeStatus, usage: ClaudeUsage = ZERO_USAGE) {
    super(`messages failed: ${status}`);
    this.name = "ClaudeError";
    this.status = status;
    this.usage = { ...usage };
  }
}

export type CompleteRequest = { system: string; user: string; maxTokens: number; jsonSchema?: Record<string, unknown> };
export type CompleteResult = { text: string; usage: ClaudeUsage };
export type Complete = (request: CompleteRequest) => Promise<CompleteResult>;
export type ClaudeClient = { complete: Complete };

// A transport failure: an abort of the call's own timeout, or anything else the fetch threw.
const transportStatus = (error: unknown): ClaudeStatus =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "network-error";

// A token count from the response: a missing or non-number value counts 0.
const tokens = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

export function createClaudeClient({
  fetchImpl = globalThis.fetch,
  timeoutMs = CLAUDE_TIMEOUT_MS,
}: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): ClaudeClient {
  const apiKey = process.env[KEY_VARIABLE];
  if (!apiKey) throw new Error(`${KEY_VARIABLE} is not set`);

  return {
    async complete({ system, user, maxTokens, jsonSchema }) {
      const body = {
        model: CLAUDE_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { effort: "low", ...(jsonSchema !== undefined ? { format: { type: "json_schema", schema: jsonSchema } } : {}) },
      };
      const signal = AbortSignal.timeout(timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(CLAUDE_MESSAGES_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        throw new ClaudeError(transportStatus(error));
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new ClaudeError(`HTTP ${response.status}`);
      }

      let raw: string;
      try {
        raw = await response.text();
      } catch (error) {
        throw new ClaudeError(transportStatus(error));
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ClaudeError("invalid-json");
      }

      const message = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
        content?: unknown;
        stop_reason?: unknown;
        usage?: { input_tokens?: unknown; output_tokens?: unknown } | null;
      };
      const usage: ClaudeUsage = { inputTokens: tokens(message.usage?.input_tokens), outputTokens: tokens(message.usage?.output_tokens) };
      if (message.stop_reason === "refusal") throw new ClaudeError("refusal", usage);
      if (message.stop_reason === "max_tokens") throw new ClaudeError("max-tokens", usage);

      // The text blocks, selected by type: a response can begin with thinking blocks.
      const blocks = Array.isArray(message.content) ? (message.content as unknown[]) : [];
      const text = blocks
        .filter((block): block is { type: "text"; text: string } => {
          const candidate = block as { type?: unknown; text?: unknown } | null;
          return typeof candidate === "object" && candidate !== null && candidate.type === "text" && typeof candidate.text === "string";
        })
        .map((block) => block.text)
        .join("");
      if (text === "") throw new ClaudeError("no-text", usage);
      return { text, usage };
    },
  };
}

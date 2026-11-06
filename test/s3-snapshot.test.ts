import { netGuardHits } from "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  JUPITER_PRICE_URL,
  MarketSnapshotError,
  SNAPSHOT_FILE,
  buildMarketSnapshot,
  captureMarketSnapshot,
} from "../scripts/capture-market-snapshot.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const DUMMY_KEY = "test-dummy-key";

// The snapshot is only ever written into this isolated temporary directory.
let dir: string;
before(() => {
  dir = mkdtempSync(tmpdir() + "/agentflow-snapshot-test-");
  const fromRepo = relative(repoRoot, dir);
  assert.ok(fromRepo.startsWith("..") || isAbsolute(fromRepo), "the test directory is not inside repo/");
});
after(() => rmSync(dir, { recursive: true, force: true }));

// A stand-in Jupiter entry with extra fields the snapshot must not keep; its values are test values.
const entry = { usdPrice: 0.5, priceChange24h: 1.5, decimals: 6, blockId: 42, liquidity: 999, createdAt: "x" };

const rel = (path: string) => relative(repoRoot, path).split(sep).join("/");
function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|mts|cts|js|mjs)$/.test(name) ? [path] : [];
  });
}
const filesContaining = (needle: string) =>
  [...sourceFiles(join(repoRoot, "src")), ...sourceFiles(join(repoRoot, "scripts"))]
    .filter((file) => readFileSync(file, "utf8").includes(needle))
    .map(rel)
    .sort();

// Captures console output while fn runs; nothing is passed through.
async function captureOutput<T>(fn: () => Promise<T>): Promise<{ output: string; result?: T; error?: unknown }> {
  const lines: string[] = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { output: lines.join("\n"), result: await fn() };
  } catch (error) {
    return { output: lines.join("\n"), error };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

describe("s3-snapshot", () => {
  it("the snapshot builder keeps only the S3-Q1 fields, from the S3-Q1 paths, marked kind snapshot and notLive", () => {
    const snapshot = buildMarketSnapshot({ response: { [JUP]: entry }, asOf: "2026-01-01T00:00:00.000Z", capturedAt: "2026-01-01T00:00:01.000Z" });
    assert.deepEqual(snapshot, {
      kind: "snapshot",
      notLive: true,
      source: "Jupiter Price API V3",
      sourceUrl: `https://api.jup.ag/price/v3?ids=${JUP}`,
      mint: JUP,
      asOf: "2026-01-01T00:00:00.000Z",
      capturedAt: "2026-01-01T00:00:01.000Z",
      priceUsd: 0.5,
      priceChange24hPct: 1.5,
      decimals: 6,
      blockId: 42,
    });
    const { blockId: _omitted, ...withoutBlockId } = entry;
    assert.equal(buildMarketSnapshot({ response: { [JUP]: withoutBlockId }, asOf: "a", capturedAt: "b" }).blockId, null);
    assert.throws(() => buildMarketSnapshot({ response: {}, asOf: "a", capturedAt: "b" }), (error: unknown) => {
      assert.ok(error instanceof MarketSnapshotError);
      assert.equal(error.status, "no-entry");
      return true;
    });
  });

  it("captureMarketSnapshot sends the key only in x-api-key, never prints or writes it, makes one request per run, and refuses a second run", async () => {
    const hitsBefore = netGuardHits();
    const calls: { url: string; headers: Headers }[] = [];
    const standIn = (status: number) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify({ [JUP]: entry }), { status });
      }) as typeof fetch;
    const now = () => new Date("2026-01-01T00:00:00.000Z");
    const path = join(dir, SNAPSHOT_FILE);

    // A non-200 (here 429) writes nothing.
    const refused = await captureOutput(() => captureMarketSnapshot({ fetchImpl: standIn(429), apiKey: DUMMY_KEY, outDir: dir, now }));
    assert.ok(refused.error instanceof MarketSnapshotError && refused.error.status === 429);
    assert.equal(existsSync(path), false);

    const first = await captureOutput(() => captureMarketSnapshot({ fetchImpl: standIn(200), apiKey: DUMMY_KEY, outDir: dir, now }));
    assert.equal(first.error, undefined);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.url, JUPITER_PRICE_URL);
      assert.equal(call.headers.get("x-api-key"), DUMMY_KEY);
      assert.ok(!call.url.includes(DUMMY_KEY));
    }
    const written = readFileSync(path, "utf8");
    assert.ok(!written.includes(DUMMY_KEY), "the written file does not contain the key");
    assert.ok(!first.output.includes(DUMMY_KEY) && !refused.output.includes(DUMMY_KEY), "the output does not contain the key");
    assert.equal(JSON.parse(written).kind, "snapshot");

    const second = await captureOutput(() => captureMarketSnapshot({ fetchImpl: standIn(200), apiKey: DUMMY_KEY, outDir: dir, now }));
    assert.ok(second.error instanceof MarketSnapshotError && second.error.status === "exists");
    assert.equal(calls.length, 2, "no request on the refused run");
    assert.equal(readFileSync(path, "utf8"), written);
    assert.equal(netGuardHits(), hitsBefore);
  });

  it("source scan of src/ and scripts/: JUPITER_API_KEY, SECRET_KEY and HELIUS_API_KEY each occur only in their own module", () => {
    assert.deepEqual(filesContaining("JUPITER_API_KEY"), ["scripts/capture-market-snapshot.ts"]);
    assert.deepEqual(filesContaining("SECRET_KEY"), ["scripts/wallets-create.ts", "src/signer/buyer-signer.ts"]);
    assert.deepEqual(filesContaining("HELIUS_API_KEY"), ["src/services/token-intel.ts"]);
  });
});

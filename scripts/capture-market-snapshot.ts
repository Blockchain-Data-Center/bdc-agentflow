// Run once in S3 (S3-Q1, FD-09): exactly one request to Jupiter Price API V3 for JUP, saved as the dated market
// snapshot that Services B1 and B2 serve. It is labelled a snapshot, not live market data.
// JUPITER_API_KEY is read here only (FD-10, FD-11 item 3). It travels in the x-api-key header and is never logged,
// printed, stored or echoed; request headers are never printed. The URL carries no key.
// One request, 30 s timeout, no retry: a timeout, an HTTP 429 or any non-200 writes nothing and exits 1.
// Errors are reported by status only. The file is written with flag "wx", so it is never overwritten.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MarketSnapshot } from "../src/services/service-b.ts";
import { JUP_MINT } from "../src/services/token-intel.ts";

const KEY_VARIABLE = "JUPITER_API_KEY";

export const MARKET_SNAPSHOT_SOURCE = "Jupiter Price API V3";
export const JUPITER_PRICE_URL = `https://api.jup.ag/price/v3?ids=${JUP_MINT}`;
export const SNAPSHOT_FILE = "market-JUP.json";
export const CAPTURE_TIMEOUT_MS = 30_000;

export type MarketSnapshotStatus = number | "missing-key" | "exists" | "timeout" | "network-error" | "invalid-json" | "no-entry";

export class MarketSnapshotError extends Error {
  readonly status: MarketSnapshotStatus;

  constructor(status: MarketSnapshotStatus) {
    super(
      status === "missing-key"
        ? `${KEY_VARIABLE} is not set`
        : status === "exists"
          ? `${SNAPSHOT_FILE} already exists`
          : `Jupiter Price API V3 request failed: ${typeof status === "number" ? `HTTP ${status}` : status}`,
    );
    this.name = "MarketSnapshotError";
    this.status = status;
  }
}

// Keeps only the S3-Q1 fields of the response's entry for the mint; an absent field is null.
export function buildMarketSnapshot({
  response,
  asOf,
  capturedAt,
}: {
  response: unknown;
  asOf: string;
  capturedAt: string;
}): MarketSnapshot {
  const entry =
    response !== null && typeof response === "object" ? (response as Record<string, unknown>)[JUP_MINT] : undefined;
  if (entry === null || typeof entry !== "object") throw new MarketSnapshotError("no-entry");
  const field = (name: string) => ((entry as Record<string, unknown>)[name] ?? null) as number | null;
  return {
    kind: "snapshot",
    notLive: true,
    source: MARKET_SNAPSHOT_SOURCE,
    sourceUrl: JUPITER_PRICE_URL,
    mint: JUP_MINT,
    asOf,
    capturedAt,
    priceUsd: field("usdPrice"),
    priceChange24hPct: field("priceChange24h"),
    decimals: field("decimals"),
    blockId: field("blockId"),
  };
}

const isTimeout = (error: unknown) =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

// The single request, its checks and the "wx" write. The key goes only into the x-api-key header.
export async function captureMarketSnapshot({
  fetchImpl,
  apiKey,
  outDir,
  now,
}: {
  fetchImpl: typeof fetch;
  apiKey: string | undefined;
  outDir: string;
  now: () => Date;
}): Promise<{ path: string; snapshot: MarketSnapshot }> {
  if (!apiKey) throw new MarketSnapshotError("missing-key");
  const path = join(outDir, SNAPSHOT_FILE);
  if (existsSync(path)) throw new MarketSnapshotError("exists");

  const asOf = now().toISOString();
  let body: unknown;
  try {
    const response = await fetchImpl(JUPITER_PRICE_URL, {
      method: "GET",
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    });
    if (response.status !== 200) throw new MarketSnapshotError(response.status);
    try {
      body = await response.json();
    } catch (error) {
      throw new MarketSnapshotError(isTimeout(error) ? "timeout" : "invalid-json");
    }
  } catch (error) {
    if (error instanceof MarketSnapshotError) throw error;
    throw new MarketSnapshotError(isTimeout(error) ? "timeout" : "network-error");
  }

  const snapshot = buildMarketSnapshot({ response: body, asOf, capturedAt: now().toISOString() });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
  console.log(`written: ${SNAPSHOT_FILE} (${statSync(path).size} bytes)`);
  console.log(`source: ${snapshot.source}, asOf: ${snapshot.asOf}, capturedAt: ${snapshot.capturedAt}`);
  console.log(
    `mint: ${snapshot.mint}, priceUsd: ${snapshot.priceUsd}, priceChange24hPct: ${snapshot.priceChange24hPct}, decimals: ${snapshot.decimals}, blockId: ${snapshot.blockId}`,
  );
  return { path, snapshot };
}

// The CLI entry runs only when this file is the script Node was started with, not when a test imports it.
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const flag = process.argv.indexOf("--out-dir");
  const outDir =
    flag !== -1 && process.argv[flag + 1]
      ? resolve(process.argv[flag + 1])
      : fileURLToPath(new URL("../data/snapshots", import.meta.url));
  try {
    console.log(`capture:market-snapshot: one request to ${JUPITER_PRICE_URL}, started ${new Date().toISOString()}`);
    await captureMarketSnapshot({ fetchImpl: fetch, apiKey: process.env[KEY_VARIABLE], outDir, now: () => new Date() });
  } catch (error) {
    // Only messages this script builds are printed.
    const message = error instanceof MarketSnapshotError ? error.message : "unexpected error";
    console.error(`capture:market-snapshot failed, nothing written: ${message}`);
    process.exit(1);
  }
}

// Run once in S1: one live read of JUP token-account data from Solana Mainnet through Helius, saved as
// Service A's dated cached fallback. It refuses to overwrite the file and writes nothing on failure.
// FD-12 items 2–5 as applied by FD-13 item 4: attempt 1, then up to 3 more on HTTP 429 only, after waits of
// 10 s, 30 s and 60 s; the two reads run one after the other. Errors carry the method and status only.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  JUP_MINT,
  TOKEN_INTEL_SOURCE,
  TokenIntelRpcError,
  computeTokenIntel,
  createTokenIntelRpc,
  type TokenIntelData,
} from "../src/services/token-intel.ts";

const cachePath = fileURLToPath(new URL("../data/cache/token-intel-JUP.json", import.meta.url));
const WAITS_MS = [0, 10_000, 30_000, 60_000];
const CAPTURE_TIMEOUT_MS = 30_000; // capture only (founder, 2026-10-17); Service A keeps LIVE_TIMEOUT_MS

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Local time as YYYY-MM-DD HH:MM:SS +hhmm, the format RESULTS.md uses.
function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`;
}

const isHttp429 = (error: unknown) => error instanceof TokenIntelRpcError && error.status === 429;

// Only messages this project builds (TokenIntelRpcError, the missing-variable error) are printed.
const describeError = (error: unknown) =>
  error instanceof TokenIntelRpcError || (error instanceof Error && error.message.endsWith(" is not set"))
    ? error.message
    : "unexpected error";

// One attempt: getTokenSupply, then getTokenLargestAccounts, never in parallel.
async function readOnce(): Promise<TokenIntelData> {
  const rpc = createTokenIntelRpc(CAPTURE_TIMEOUT_MS);
  const supply = await rpc.getTokenSupply(JUP_MINT);
  const largest = await rpc.getTokenLargestAccounts(JUP_MINT);
  return computeTokenIntel({ mint: JUP_MINT, supply, largest, asOf: new Date().toISOString(), source: TOKEN_INTEL_SOURCE });
}

async function main(): Promise<void> {
  if (existsSync(cachePath)) {
    console.error(`Refusing: ${cachePath} already exists. Nothing was written.`);
    process.exit(1);
  }
  for (const [index, waitMs] of WAITS_MS.entries()) {
    const attempt = index + 1;
    const last = index === WAITS_MS.length - 1;
    if (waitMs > 0) {
      console.log(`attempt ${attempt}: waiting ${waitMs / 1000} s`);
      await sleep(waitMs);
    }
    console.log(`attempt ${attempt}: started ${stamp()}`);
    let data: TokenIntelData;
    try {
      data = await readOnce();
    } catch (error) {
      console.log(`attempt ${attempt}: failed ${stamp()}: ${describeError(error)}`);
      if (isHttp429(error) && !last) continue;
      console.error(`capture:token-intel failed, nothing written (${isHttp429(error) ? "429 on the last attempt" : "not a 429"}).`);
      process.exit(1);
    }
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
    console.log(`attempt ${attempt}: succeeded ${stamp()}`);
    console.log(`written: data/cache/token-intel-JUP.json`);
    console.log(`asOf: ${data.asOf}`);
    console.log(`mint: ${data.mint}, decimals: ${data.decimals}, supplyUi: ${data.supplyUi}`);
    console.log(`largestAccounts: ${data.largestAccounts.length}, top10TokenAccountSharePct: ${data.top10TokenAccountSharePct}`);
    return;
  }
}

try {
  await main();
} catch (error) {
  console.error(`capture:token-intel failed, nothing written: ${describeError(error)}`);
  process.exit(1);
}

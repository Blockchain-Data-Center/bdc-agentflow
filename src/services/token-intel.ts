// Token intelligence for Service A: live read-only data from Solana Mainnet through Helius, with a dated cached fallback.
// The computation is pure and kept apart from the RPC calls. These are token accounts, not holders.
// HELIUS_API_KEY is read here only (FD-13). It travels in the URL query, so the URL is never logged, printed
// or thrown: RPC errors are re-raised as TokenIntelRpcError, carrying the method and status only.
import { readFileSync } from "node:fs";
import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, address, createSolanaRpc, isSolanaError } from "@solana/kit";
import { dataNetwork } from "../config/networks.ts";

export const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
export const TOKEN_INTEL_SOURCE = "Helius Mainnet RPC (getTokenSupply, getTokenLargestAccounts)";
export const LIVE_TIMEOUT_MS = 20000; // FD-19: 5 s → 20 s for Service A's live read; the capture keeps its own 30 s

const HELIUS_KEY_VARIABLE = "HELIUS_API_KEY";
const HELIUS_MAINNET_RPC = "https://mainnet.helius-rpc.com/";

export type TokenIntelRpcStatus = number | "timeout" | "rpc-error" | "network-error";

export class TokenIntelRpcError extends Error {
  readonly method: string;
  readonly status: TokenIntelRpcStatus;

  constructor(method: string, status: TokenIntelRpcStatus) {
    super(`${method} failed: ${typeof status === "number" ? `HTTP ${status}` : status}`);
    this.name = "TokenIntelRpcError";
    this.method = method;
    this.status = status;
  }
}

// Maps any RPC failure to a status without keeping the original error, whose text could carry the URL.
function rpcStatus(error: unknown): TokenIntelRpcStatus {
  if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return error.context.statusCode;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  if (isSolanaError(error)) return "rpc-error";
  return "network-error";
}

async function call<T>(method: string, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    throw new TokenIntelRpcError(method, rpcStatus(error));
  }
}

export type RpcTokenAmount = { amount: string; decimals: number; uiAmountString?: string };
export type RpcLargestAccount = RpcTokenAmount & { address: string };

// The two reads Service A needs; a stand-in implements this in tests.
export type TokenIntelRpc = {
  getTokenSupply(mint: string): Promise<RpcTokenAmount>;
  getTokenLargestAccounts(mint: string): Promise<readonly RpcLargestAccount[]>;
};

export type TokenIntelData = {
  serviceId: "svc-a-token-intel";
  capability: "token-intelligence";
  dataNetwork: string;
  mint: string;
  decimals: number;
  supplyUi: string;
  largestAccounts: { address: string; amountUi: string }[];
  top10TokenAccountSharePct: number;
  asOf: string;
  source: string;
};

// fallbackCause is set on a cached fallback only (FD-19): why the live read failed, as the method and status of a
// TokenIntelRpcError, otherwise the error class name only; never the URL, the key or a request header.
export type TokenIntelBody = TokenIntelData & { dataStatus: "live" | "cached fallback"; fallbackCause?: string };

function fallbackCauseOf(error: unknown): string {
  if (error instanceof TokenIntelRpcError) return error.message;
  return error instanceof Error ? error.name : typeof error;
}

// Share of supply held by the given raw amounts, in percent, rounded half-up to 2 decimals, in bigint.
export function sharePct(supplyRaw: bigint, amountsRaw: readonly bigint[]): number {
  if (supplyRaw <= 0n) return 0;
  const held = amountsRaw.reduce((sum, amount) => sum + amount, 0n);
  const hundredths = (held * 10000n * 2n + supplyRaw) / (2n * supplyRaw);
  return Number(hundredths) / 100;
}

export function computeTokenIntel(input: {
  mint: string;
  supply: RpcTokenAmount;
  largest: readonly RpcLargestAccount[];
  asOf: string;
  source: string;
}): TokenIntelData {
  const top10 = input.largest.slice(0, 10);
  return {
    serviceId: "svc-a-token-intel",
    capability: "token-intelligence",
    dataNetwork,
    mint: input.mint,
    decimals: input.supply.decimals,
    supplyUi: input.supply.uiAmountString ?? input.supply.amount,
    largestAccounts: top10.map((account) => ({
      address: account.address,
      amountUi: account.uiAmountString ?? account.amount,
    })),
    top10TokenAccountSharePct: sharePct(
      BigInt(input.supply.amount),
      top10.map((account) => BigInt(account.amount)),
    ),
    asOf: input.asOf,
    source: input.source,
  };
}

// Kit RPC on Helius Mainnet with the key from HELIUS_API_KEY, each read bounded by the live timeout.
// There is no fallback to another endpoint. A missing key fails naming the variable only.
export function createTokenIntelRpc(timeoutMs = LIVE_TIMEOUT_MS): TokenIntelRpc {
  const apiKey = process.env[HELIUS_KEY_VARIABLE];
  if (!apiKey) throw new Error(`${HELIUS_KEY_VARIABLE} is not set`);
  const url = new URL(HELIUS_MAINNET_RPC);
  url.searchParams.set("api-key", apiKey);
  const rpc = createSolanaRpc(url.toString());
  return {
    async getTokenSupply(mint) {
      const { value } = await call("getTokenSupply", () =>
        rpc.getTokenSupply(address(mint)).send({ abortSignal: AbortSignal.timeout(timeoutMs) }),
      );
      return value;
    },
    async getTokenLargestAccounts(mint) {
      const { value } = await call("getTokenLargestAccounts", () =>
        rpc.getTokenLargestAccounts(address(mint)).send({ abortSignal: AbortSignal.timeout(timeoutMs) }),
      );
      return value;
    },
  };
}

export async function fetchTokenIntel(rpc: TokenIntelRpc, mint: string, now: () => Date): Promise<TokenIntelData> {
  const [supply, largest] = await Promise.all([rpc.getTokenSupply(mint), rpc.getTokenLargestAccounts(mint)]);
  return computeTokenIntel({ mint, supply, largest, asOf: now().toISOString(), source: TOKEN_INTEL_SOURCE });
}

export function readTokenIntelCache(cachePath: string | URL): TokenIntelData {
  return JSON.parse(readFileSync(cachePath, "utf8")) as TokenIntelData;
}

// Live data when the RPC answers; otherwise the cache file, labelled "cached fallback" with its own asOf and
// the recorded cause of the fallback.
export function createTokenIntelProvider({
  rpc,
  cachePath,
  now = () => new Date(),
}: {
  rpc: TokenIntelRpc;
  cachePath: string | URL;
  now?: () => Date;
}): (mint: string) => Promise<TokenIntelBody> {
  return async (mint) => {
    try {
      return { ...(await fetchTokenIntel(rpc, mint, now)), dataStatus: "live" };
    } catch (error) {
      return { ...readTokenIntelCache(cachePath), dataStatus: "cached fallback", fallbackCause: fallbackCauseOf(error) };
    }
  };
}

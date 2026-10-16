// Imported first by every test file: any use of the global fetch fails, so no test can reach the network.
let hits = 0;

globalThis.fetch = (async () => {
  hits += 1;
  throw new Error("NETWORK_BLOCKED");
}) as typeof fetch;

export function netGuardHits(): number {
  return hits;
}

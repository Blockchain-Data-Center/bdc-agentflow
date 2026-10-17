// The session ledger and the duplicate-purchase key (S2-Q2, S2-Q3).
// remaining = budget − committed − reserved, where a pending amount counts as reserved.
// The ledger is changed only through its operations; it has no setter.
import { createHash } from "node:crypto";

export type LedgerEntryStatus = "reserved" | "pending" | "committed";

// What the policy engine reads: no operation that changes the ledger.
export type LedgerView = {
  readonly budgetAtomic: bigint;
  committed(): bigint;
  reserved(): bigint;
  remaining(): bigint;
  status(requestKey: string): LedgerEntryStatus | undefined;
};

export type Ledger = LedgerView & {
  reserve(requestKey: string, amount: bigint): void;
  commit(requestKey: string): void;
  release(requestKey: string): void;
  markPending(requestKey: string): void;
  reconcile(requestKey: string, outcome: { settled: boolean }): void;
};

export function createLedger(budgetAtomic: bigint): Ledger {
  const entries = new Map<string, { amount: bigint; status: LedgerEntryStatus }>();

  const sum = (match: (status: LedgerEntryStatus) => boolean) =>
    [...entries.values()].filter((entry) => match(entry.status)).reduce((total, entry) => total + entry.amount, 0n);

  // The entry for a key, which must be in one of the given states.
  function entryIn(requestKey: string, operation: string, ...states: LedgerEntryStatus[]) {
    const entry = entries.get(requestKey);
    if (!entry || !states.includes(entry.status)) {
      throw new Error(`ledger.${operation}: ${requestKey} is ${entry?.status ?? "unknown"}, expected ${states.join(" or ")}`);
    }
    return entry;
  }

  const ledger: Ledger = {
    budgetAtomic,
    committed: () => sum((status) => status === "committed"),
    reserved: () => sum((status) => status !== "committed"),
    remaining: () => budgetAtomic - ledger.committed() - ledger.reserved(),
    status: (requestKey) => entries.get(requestKey)?.status,

    reserve(requestKey, amount) {
      if (entries.has(requestKey)) throw new Error(`ledger.reserve: ${requestKey} is already ${entries.get(requestKey)!.status}`);
      if (amount > ledger.remaining()) throw new Error(`ledger.reserve: ${amount} exceeds the remaining ${ledger.remaining()}`);
      entries.set(requestKey, { amount, status: "reserved" });
    },
    commit(requestKey) {
      entryIn(requestKey, "commit", "reserved").status = "committed";
    },
    release(requestKey) {
      entryIn(requestKey, "release", "reserved");
      entries.delete(requestKey);
    },
    markPending(requestKey) {
      entryIn(requestKey, "markPending", "reserved").status = "pending";
    },
    reconcile(requestKey, { settled }) {
      const entry = entryIn(requestKey, "reconcile", "pending");
      if (settled) entry.status = "committed";
      else entries.delete(requestKey);
    },
  };
  return ledger;
}

// SHA-256 (hex) of serviceId, method and the canonical URL: the path plus the query with its keys sorted.
export function requestKeyFor(serviceId: string, method: string, url: string): string {
  const parsed = new URL(url, "http://canonical.invalid");
  parsed.searchParams.sort();
  const query = parsed.searchParams.toString();
  const canonicalUrl = query ? `${parsed.pathname}?${query}` : parsed.pathname;
  return createHash("sha256").update(`${serviceId}\n${method.toUpperCase()}\n${canonicalUrl}`).digest("hex");
}

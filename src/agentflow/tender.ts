// The Agent Tender (S4-Q1, FD-21): filter, then cheapest. A pure function: no I/O, no environment, no clock,
// no randomness, no import from src/signer or src/payments. It reads the ledger and never changes it.
// For one capability, every candidate considered gets a reason code and a one-sentence reason text:
// - excluded, checked in this order: NOT_ACTIVE, FAILED_IN_SESSION, OVER_SERVICE_CAP, OVER_BUDGET;
// - the eligible ranked by price (cheapest first), then the reliability signal (fewer failures, then more
//   successes), then serviceId: the first is SELECTED, the others RANKED_LOWER.
// The output lists the eligible in rank order, then the excluded in registry order. A candidate of another
// capability is not listed. The Tender selects; it never approves: the policy engine still runs in purchase.
import type { PolicyRules } from "../policy/engine.ts";
import type { LedgerView } from "../policy/session.ts";
import type { ServiceEntry } from "../registry/services.ts";

// A registry entry whose status may be anything, so a non-active entry can be considered and excluded.
export type TenderCandidateInput = Omit<ServiceEntry, "status"> & { status: string };

export type ReliabilityCounts = { successes: number; failures: number };
// In-memory, per run, owned by the runner (S4-Q2); the Tender only reads it.
export type ReliabilitySignal = Readonly<Record<string, Readonly<ReliabilityCounts>>>;

export type TenderReasonCode = "SELECTED" | "RANKED_LOWER" | "NOT_ACTIVE" | "FAILED_IN_SESSION" | "OVER_SERVICE_CAP" | "OVER_BUDGET";

export type TenderCandidate = {
  serviceId: string;
  name: string;
  priceAtomic: bigint;
  priceUsd: string;
  reasonCode: TenderReasonCode;
  reasonText: string;
};

const NO_HISTORY: ReliabilityCounts = { successes: 0, failures: 0 };

// USDC atomic units (6 decimals, as the policy rules) as dollars, e.g. 10000n -> "$0.01".
function usd(atomic: bigint): string {
  const sign = atomic < 0n ? "-" : "";
  const abs = atomic < 0n ? -atomic : atomic;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}$${abs / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

type Factor = "price" | "failures" | "successes" | "serviceId";

export function runTender({
  capability,
  candidates,
  ledger,
  rules,
  failed,
  reliability,
}: {
  capability: string;
  candidates: readonly TenderCandidateInput[];
  ledger: LedgerView;
  rules: Pick<PolicyRules, "maxPerServiceAtomic">;
  failed: ReadonlySet<string>;
  reliability: ReliabilitySignal;
}): TenderCandidate[] {
  const remaining = ledger.remaining();
  const counts = (serviceId: string) => reliability[serviceId] ?? NO_HISTORY;

  const eligible: TenderCandidateInput[] = [];
  const excluded: TenderCandidate[] = [];
  const exclude = (entry: TenderCandidateInput, reasonCode: TenderReasonCode, reasonText: string) =>
    excluded.push({ serviceId: entry.serviceId, name: entry.name, priceAtomic: entry.priceAtomic, priceUsd: entry.priceUsd, reasonCode, reasonText });

  for (const entry of candidates) {
    if (entry.capability !== capability) continue;
    if (entry.status !== "active") {
      exclude(entry, "NOT_ACTIVE", `${entry.name} is excluded: its status is "${entry.status}", not "active".`);
    } else if (failed.has(entry.serviceId)) {
      exclude(entry, "FAILED_IN_SESSION", `${entry.name} is excluded: it already failed in this session and is never retried.`);
    } else if (entry.priceAtomic > rules.maxPerServiceAtomic) {
      exclude(entry, "OVER_SERVICE_CAP", `${entry.name} is excluded: its price ${entry.priceUsd} is above the per-service cap of ${usd(rules.maxPerServiceAtomic)}.`);
    } else if (entry.priceAtomic > remaining) {
      exclude(entry, "OVER_BUDGET", `${entry.name} is excluded: its price ${entry.priceUsd} is above the remaining budget of ${usd(remaining)}.`);
    } else {
      eligible.push(entry);
    }
  }

  // The first factor that orders a before b, or that b before a.
  const factor = (a: TenderCandidateInput, b: TenderCandidateInput): Factor => {
    if (a.priceAtomic !== b.priceAtomic) return "price";
    if (counts(a.serviceId).failures !== counts(b.serviceId).failures) return "failures";
    if (counts(a.serviceId).successes !== counts(b.serviceId).successes) return "successes";
    return "serviceId";
  };
  const compare = (a: TenderCandidateInput, b: TenderCandidateInput): number => {
    switch (factor(a, b)) {
      case "price":
        return a.priceAtomic < b.priceAtomic ? -1 : 1;
      case "failures":
        return counts(a.serviceId).failures - counts(b.serviceId).failures;
      case "successes":
        return counts(b.serviceId).successes - counts(a.serviceId).successes;
      case "serviceId":
        return a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0;
    }
  };
  const ranked = [...eligible].sort(compare);

  const selectedEntry = ranked[0];
  const out: TenderCandidate[] = ranked.map((entry, index) => {
    const base = { serviceId: entry.serviceId, name: entry.name, priceAtomic: entry.priceAtomic, priceUsd: entry.priceUsd };
    if (index === 0) {
      const runnerUp = ranked[1];
      const tie =
        runnerUp && runnerUp.priceAtomic === entry.priceAtomic
          ? `; tied on price with ${runnerUp.name}, it ranks first on ${
              { failures: "fewer failures", successes: "more successes", serviceId: "service id", price: "price" }[factor(entry, runnerUp)]
            } in this session`
          : "";
      const count = ranked.length;
      return {
        ...base,
        reasonCode: "SELECTED",
        reasonText: `${entry.name} is selected: at ${entry.priceUsd} it is the cheapest of ${count} eligible candidate${count === 1 ? "" : "s"}, within the per-service cap and the remaining budget${tie}.`,
      };
    }
    const lower: Record<Factor, string> = {
      price: `its price ${entry.priceUsd} is above the ${selectedEntry.priceUsd} of ${selectedEntry.name}`,
      failures: `same price as ${selectedEntry.name}, but more failures in this session (${counts(entry.serviceId).failures} against ${counts(selectedEntry.serviceId).failures})`,
      successes: `same price and failures as ${selectedEntry.name}, but fewer successes in this session (${counts(entry.serviceId).successes} against ${counts(selectedEntry.serviceId).successes})`,
      serviceId: `same price and reliability as ${selectedEntry.name}, ordered after it by service id`,
    };
    return { ...base, reasonCode: "RANKED_LOWER", reasonText: `${entry.name} is eligible but ranked lower: ${lower[factor(selectedEntry, entry)]}.` };
  });

  return [...out, ...excluded];
}

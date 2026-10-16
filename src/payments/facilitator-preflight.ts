// Facilitator preflight: before any paid route is advertised, the configured facilitator must report
// support for exactly x402 V2, scheme "exact", on the Devnet payment network (FD-11 item 1).
// A getSupported() failure is not caught here; the caller reports it as FACILITATOR_UNREACHABLE.
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedKind } from "@x402/core/types";

export class FacilitatorUnsupportedError extends Error {
  readonly code = "FACILITATOR_UNSUPPORTED";
  readonly kinds: SupportedKind[];

  constructor(wanted: { x402Version: number; scheme: string; network: string }, kinds: SupportedKind[]) {
    super(
      `FACILITATOR_UNSUPPORTED: no supported kind matches x402Version ${wanted.x402Version}, scheme ${wanted.scheme}, network ${wanted.network}`,
    );
    this.name = "FacilitatorUnsupportedError";
    this.kinds = kinds;
  }
}

export async function assertFacilitatorSupports(
  facilitator: Pick<FacilitatorClient, "getSupported">,
  wanted: { x402Version: number; scheme: string; network: string },
): Promise<SupportedKind> {
  const { kinds } = await facilitator.getSupported();
  const match = kinds.find(
    (kind) => kind.x402Version === wanted.x402Version && kind.scheme === wanted.scheme && kind.network === wanted.network,
  );
  if (!match) throw new FacilitatorUnsupportedError(wanted, kinds);
  return match;
}

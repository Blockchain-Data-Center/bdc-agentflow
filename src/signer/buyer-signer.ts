// The constrained signer: the only source module that reads wallet signing material.
// It hands out a TransactionSigner and never logs, returns, serialises or exposes the key bytes.
import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import type { TransactionSigner } from "@solana/kit";

const BUYER_KEY_VARIABLE = "BUYER_SECRET_KEY_B58";

export async function loadBuyerSigner(): Promise<TransactionSigner> {
  const encoded = process.env[BUYER_KEY_VARIABLE];
  if (!encoded) {
    throw new Error(`${BUYER_KEY_VARIABLE} is not set`);
  }
  const bytes = getBase58Encoder().encode(encoded);
  return createKeyPairSignerFromBytes(bytes);
}

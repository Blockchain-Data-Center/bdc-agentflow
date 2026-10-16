// Reads only wallets.public.json (never .env) and reports, on Devnet, each wallet's SOL balance and its
// associated token account for the payment asset. It writes nothing.
import { readFileSync } from "node:fs";
import { address, createSolanaRpc, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import type { Address } from "@solana/kit";
import { paymentAsset, paymentRpcUrl } from "../src/config/networks.ts";

const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const LAMPORTS_PER_SOL = 1_000_000_000n;

type ParsedTokenAccount = {
  parsed?: { type?: string; info?: { mint?: string; owner?: string; tokenAmount?: { uiAmountString?: string } } };
};

const rpc = createSolanaRpc(paymentRpcUrl);

async function associatedTokenAccount(owner: Address, mint: Address): Promise<Address> {
  const encoder = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [encoder.encode(owner), encoder.encode(TOKEN_PROGRAM), encoder.encode(mint)],
  });
  return ata;
}

function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0");
  return `${whole}.${fraction}`;
}

async function report(label: string, wallet: Address, mint: Address): Promise<void> {
  const { value: lamports } = await rpc.getBalance(wallet).send();
  const ata = await associatedTokenAccount(wallet, mint);
  const { value: account } = await rpc.getAccountInfo(ata, { encoding: "jsonParsed" }).send();
  const info = (account?.data as ParsedTokenAccount | undefined)?.parsed?.info;
  const isUsdcAta =
    account !== null && account.owner === TOKEN_PROGRAM && info?.mint === mint && info?.owner === wallet;
  console.log(`${label}: ${wallet}`);
  console.log(`  SOL: ${formatSol(lamports)}`);
  if (isUsdcAta) {
    console.log(`  USDC ATA: ${ata}`);
    console.log(`  USDC: ${info?.tokenAmount?.uiAmountString ?? "0"}`);
  } else {
    console.log(`  no USDC ATA (expected at ${ata})`);
  }
}

async function main(): Promise<void> {
  const wallets = JSON.parse(readFileSync(new URL("../wallets.public.json", import.meta.url), "utf8")) as {
    buyer: string;
    seller: string;
  };
  const mint = address(paymentAsset);
  const { value: mintAccount } = await rpc.getAccountInfo(mint, { encoding: "base64" }).send();
  if (mintAccount === null || mintAccount.owner !== TOKEN_PROGRAM) {
    console.error(
      `STOP: the payment asset mint ${mint} is not owned by the SPL Token program (owner: ${mintAccount?.owner ?? "account not found"}).`,
    );
    process.exit(1);
  }
  console.log(`payment asset: ${mint} (SPL Token program)`);
  await report("buyer", address(wallets.buyer), mint);
  await report("seller", address(wallets.seller), mint);
}

await main();

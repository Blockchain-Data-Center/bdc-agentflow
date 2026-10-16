// Run by the founder only: creates the Devnet buyer and seller wallets.
// Writes <dir>/.env (the two secret keys, mode 0o600) and <dir>/wallets.public.json, both with flag "wx",
// so it refuses if either file exists. It prints only the public addresses; it never reads a key back.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getBase58Decoder } from "@solana/kit";
import { paymentNetwork } from "../src/config/networks.ts";

function parseDir(argv: readonly string[]): string {
  const at = argv.indexOf("--dir");
  if (at === -1) return process.cwd();
  const dir = argv[at + 1];
  if (!dir) throw new Error("--dir needs a path");
  return resolve(dir);
}

// Solana CLI layout: 64 bytes = 32-byte seed followed by the 32-byte public key.
function createWallet(): { secretB58: string; address: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  if (seed.length !== 32 || pub.length !== 32) throw new Error("unexpected Ed25519 key length");
  const base58 = getBase58Decoder();
  return {
    secretB58: base58.decode(new Uint8Array([...seed, ...pub])),
    address: base58.decode(new Uint8Array(pub)),
  };
}

const explorerAddress = (address: string) => `https://explorer.solana.com/address/${address}?cluster=devnet`;

function main(): void {
  const dir = parseDir(process.argv.slice(2));
  const envPath = join(dir, ".env");
  const publicPath = join(dir, "wallets.public.json");
  for (const path of [envPath, publicPath]) {
    if (existsSync(path)) {
      console.error(`Refusing: ${path} already exists. Nothing was written.`);
      process.exit(1);
    }
  }

  const buyer = createWallet();
  const seller = createWallet();
  writeFileSync(envPath, `BUYER_SECRET_KEY_B58=${buyer.secretB58}\nSELLER_SECRET_KEY_B58=${seller.secretB58}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const publicInfo = {
    buyer: buyer.address,
    seller: seller.address,
    paymentNetwork,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(publicPath, `${JSON.stringify(publicInfo, null, 2)}\n`, { flag: "wx" });

  console.log(`buyer:  ${buyer.address}`);
  console.log(`        ${explorerAddress(buyer.address)}`);
  console.log(`seller: ${seller.address}`);
  console.log(`        ${explorerAddress(seller.address)}`);
}

main();

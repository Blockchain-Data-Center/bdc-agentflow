// Data network (where Service A reads from) and payment network (where AgentFlow pays) are kept apart.
// The policy engine's network rule applies to paymentNetwork only (FD-04 item 4).
import {
  DEVNET_RPC_URL,
  MAINNET_RPC_URL,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  USDC_DEVNET_ADDRESS,
} from "@x402/svm";

export const dataNetwork = SOLANA_MAINNET_CAIP2;
export const paymentNetwork = SOLANA_DEVNET_CAIP2;
export const paymentAsset = USDC_DEVNET_ADDRESS;
export const paymentRpcUrl = DEVNET_RPC_URL;
export const dataRpcUrl = MAINNET_RPC_URL;

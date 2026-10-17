// Procurement policy rules for Task A (FD-02, FD-04 item 9). Amounts are Devnet USDC atomic units (6 decimals):
// the session budget is $0.05 and the per-service cap is $0.01. The network rule is on the payment network only.
import { paymentAsset, paymentNetwork } from "../config/networks.ts";

export const sessionBudgetAtomic = 50_000n;
export const maxPerServiceAtomic = 10_000n;
export const allowedPaymentNetwork = paymentNetwork;
export const allowedPaymentAsset = paymentAsset;

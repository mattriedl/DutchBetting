/**
 * Kalshi taker fee helpers (see lib/trading-fees.ts for the shared formula and Polymarket).
 * Fee schedule effective 2026-07-07: taker roundUp(0.07 × C × P × (1 − P)).
 */
import { KALSHI_FEE, takerFeeCents, feePerContractCents, effectiveCents } from '@/lib/trading-fees';

export const KALSHI_TAKER_RATE = KALSHI_FEE.rate;
export const kalshiTakerFeeCents = (contracts: number, priceCents: number) => takerFeeCents(contracts, priceCents, KALSHI_FEE);
export const kalshiFeePerContractCents = (priceCents: number) => feePerContractCents(priceCents, KALSHI_FEE);
export const kalshiEffectiveCents = (priceCents: number) => effectiveCents(priceCents, KALSHI_FEE);

/**
 * Kalshi trading fees (fee schedule effective 2026-07-07, kalshi.com/fee-schedule):
 *   taker: roundUp(M × 0.07   × C × P × (1 − P))
 *   maker: roundUp(M × 0.0175 × C × P × (1 − P))   (M = 1 for soccer series)
 * P = price in dollars, C = contracts. The app buys at the ask (+ slippage), so orders take
 * liquidity and pay the TAKER fee. We round up to the whole cent (conservative). Polymarket
 * trades are fee-free here.
 *
 * This file has no server-only imports so the UI can use it for previews.
 */
export const KALSHI_TAKER_RATE = 0.07;

/** Taker fee in cents for buying `contracts` at `priceCents` (1-99). */
export function kalshiTakerFeeCents(contracts: number, priceCents: number): number {
  if (!(contracts > 0) || !(priceCents > 0 && priceCents < 100)) return 0;
  const p = priceCents / 100;
  return Math.ceil(KALSHI_TAKER_RATE * contracts * p * (1 - p) * 100 - 1e-9);
}

/**
 * Fee per contract in cents (fractional, before rounding) — for ANALYSIS (margins, edges,
 * viability), where we need a per-contract figure independent of order size.
 * Peaks at 1.75¢ for a 50¢ contract.
 */
export function kalshiFeePerContractCents(priceCents: number): number {
  if (!(priceCents > 0 && priceCents < 100)) return 0;
  const p = priceCents / 100;
  return KALSHI_TAKER_RATE * p * (1 - p) * 100;
}

/** What one contract really costs on Kalshi, in cents: price + taker fee. */
export function kalshiEffectiveCents(priceCents: number): number {
  return priceCents + kalshiFeePerContractCents(priceCents);
}

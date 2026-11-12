/**
 * Exchange taker fees, both of the form  fee = C × rate × (P × (1 − P))^exponent  (P in dollars).
 *  - Kalshi (fee schedule effective 2026-07-07): rate 0.07, exponent 1 for the series we trade.
 *  - Polymarket: per market — Gamma reports `feesEnabled` and `feeSchedule {rate, exponent,
 *    takerOnly}` (soccer/sports: rate 0.05, exponent 1, taker only). Makers pay nothing.
 * The app buys at the ask, so it always pays the taker fee. Recorded fees are rounded up to the
 * cent (conservative); analysis uses the exact per-contract figure.
 *
 * No server-only imports: safe to use in client components.
 */
export interface FeeSpec { rate: number; exponent: number }

export const NO_FEE: FeeSpec = { rate: 0, exponent: 1 };
export const KALSHI_FEE: FeeSpec = { rate: 0.07, exponent: 1 };
/** Used when a Polymarket market doesn't say (older cached data): the sports schedule. */
export const POLYMARKET_DEFAULT_FEE: FeeSpec = { rate: 0.05, exponent: 1 };

/** Fee spec from a Polymarket Gamma market object. */
export function polymarketFeeSpec(mk: any): FeeSpec {
  if (mk?.feesEnabled === false) return NO_FEE;
  const fs = mk?.feeSchedule;
  const rate = Number(fs?.rate);
  const exponent = Number(fs?.exponent);
  if (Number.isFinite(rate) && rate >= 0) {
    return { rate, exponent: Number.isFinite(exponent) && exponent > 0 ? exponent : 1 };
  }
  return mk?.feesEnabled === true ? POLYMARKET_DEFAULT_FEE : POLYMARKET_DEFAULT_FEE;
}

/** Exact fee per contract in cents (fractional) — for margins, edges and viability. */
export function feePerContractCents(priceCents: number, spec: FeeSpec = KALSHI_FEE): number {
  if (!(priceCents > 0 && priceCents < 100) || !(spec?.rate > 0)) return 0;
  const p = priceCents / 100;
  return spec.rate * Math.pow(p * (1 - p), spec.exponent || 1) * 100;
}

/** What one contract really costs in cents: price + taker fee. */
export function effectiveCents(priceCents: number, spec: FeeSpec = KALSHI_FEE): number {
  return priceCents + feePerContractCents(priceCents, spec);
}

/** Fee in whole cents for buying `contracts` at `priceCents`, rounded up. */
export function takerFeeCents(contracts: number, priceCents: number, spec: FeeSpec = KALSHI_FEE): number {
  if (!(contracts > 0)) return 0;
  const raw = contracts * feePerContractCents(priceCents, spec);
  return raw > 0 ? Math.ceil(raw - 1e-9) : 0;
}

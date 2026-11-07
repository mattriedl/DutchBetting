export interface Position {
  ticker: string;
  range: string;
  odds: number; // decimal odds (e.g., price in cents / 100)
  stake: number;
  payout: number;
}

export interface DutchBetAnalysis {
  positions: Position[];
  totalStake: number;
  guaranteedReturn: number;
  profitMargin: number;
  isViable: boolean;
  rating: 'excellent' | 'good' | 'marginal' | 'none';
  /** Number of bins selected (ideally 3) */
  binCount: number;
  /** Distance in °F from NWS forecast to the nearest edge of the center bin */
  forecastOffset: number;
  /** true if binCount < 3 or forecastOffset > 4 — these bets look good on paper but are unreliable */
  isEdgeCase: boolean;
  /** Human-readable reason why this is an edge case */
  edgeCaseReason?: string;
}

/**
 * Calculate Dutch betting stakes for multiple positions.
 * Uses the formula: stake_i = total_stake * (1/odds_i) / sum(1/odds_j)
 * A Dutch bet is viable when sum(1/odds_i) < 1
 * 
 * @param forecast - NWS forecast temp, used to calculate forecastOffset
 */
export function calculateDutchBet(
  positions: { ticker: string; range: string; odds: number }[],
  totalStake: number = 10,
  forecast?: number
): DutchBetAnalysis {
  const safePositions = positions ?? [];
  if (safePositions?.length === 0) {
    return {
      positions: [],
      totalStake,
      guaranteedReturn: 0,
      profitMargin: -100,
      isViable: false,
      rating: 'none',
      binCount: 0,
      forecastOffset: 99,
      isEdgeCase: true,
      edgeCaseReason: 'No positions available',
    };
  }

  // Convert Kalshi prices (cents) to decimal odds
  // Kalshi YES price of 45 cents means implied probability 0.45, decimal odds = 1/0.45 = 2.222
  const decimalOdds = safePositions?.map((p: any) => {
    const price = p?.odds ?? 0;
    if (price <= 0 || price >= 100) return Infinity;
    return 100 / price; // Convert cents price to decimal odds
  }) ?? [];

  // Sum of implied probabilities (1/decimal_odds = price/100)
  const sumImpliedProb = decimalOdds?.reduce((sum: number, odds: number) => {
    if (odds === Infinity) return sum + 1;
    return sum + (1 / odds);
  }, 0) ?? 1;

  // Dutch bet is viable when sum of implied probabilities < 1
  const isViable = sumImpliedProb < 1;

  // Calculate individual stakes
  const calculatedPositions: Position[] = safePositions?.map((p: any, i: number) => {
    const odds = decimalOdds?.[i] ?? 1;
    const impliedProb = odds === Infinity ? 1 : (1 / odds);
    const stake = totalStake * (impliedProb / sumImpliedProb);
    const payout = stake * odds;
    return {
      ticker: p?.ticker ?? '',
      range: p?.range ?? '',
      odds: p?.odds ?? 0,
      stake: Math.round(stake * 100) / 100,
      payout: Math.round(payout * 100) / 100,
    };
  }) ?? [];

  // Guaranteed return is the minimum payout across all positions
  const minPayout = Math.min(...(calculatedPositions?.map((p: any) => p?.payout ?? 0) ?? [0]));
  const guaranteedReturn = Math.round((minPayout - totalStake) * 100) / 100;
  const profitMargin = Math.round(((minPayout / totalStake - 1) * 100) * 100) / 100;

  let rating: 'excellent' | 'good' | 'marginal' | 'none' = 'none';
  if (profitMargin >= 5) rating = 'excellent';
  else if (profitMargin >= 2) rating = 'good';
  else if (profitMargin > 0) rating = 'marginal';

  // Calculate forecastOffset: how far is the forecast from the selected bins?
  const binCount = safePositions.length;
  let forecastOffset = 0;
  if (forecast != null) {
    // Parse the ranges to find the overall coverage
    let overallLow = Infinity;
    let overallHigh = -Infinity;
    for (const p of safePositions) {
      const rangeMatch = (p?.range ?? '').match(/(\d+)[°]?.*?-.*?(\d+)/);
      if (rangeMatch) {
        overallLow = Math.min(overallLow, parseInt(rangeMatch[1], 10));
        overallHigh = Math.max(overallHigh, parseInt(rangeMatch[2], 10));
      }
    }
    if (overallLow !== Infinity && overallHigh !== -Infinity) {
      // If forecast is inside coverage, offset = 0
      if (forecast >= overallLow && forecast <= overallHigh) {
        forecastOffset = 0;
      } else {
        forecastOffset = forecast < overallLow ? overallLow - forecast : forecast - overallHigh;
      }
    }
  }

  // Flag edge cases that inflate margins artificially
  let isEdgeCase = false;
  let edgeCaseReason: string | undefined;
  if (binCount < 3) {
    isEdgeCase = true;
    edgeCaseReason = `Only ${binCount} bin${binCount === 1 ? '' : 's'} — covers ${binCount * 2}°F instead of 6°F`;
  }
  if (forecastOffset > 4) {
    isEdgeCase = true;
    edgeCaseReason = (edgeCaseReason ? edgeCaseReason + '; ' : '') + `Forecast ${forecastOffset}°F outside bin range — longshot`;
  }

  return {
    positions: calculatedPositions,
    totalStake,
    guaranteedReturn,
    profitMargin,
    isViable: isEdgeCase ? false : isViable, // Edge cases are NOT truly viable
    rating: isEdgeCase ? 'none' : rating,     // Edge cases get no rating
    binCount,
    forecastOffset,
    isEdgeCase,
    edgeCaseReason,
  };
}

/**
 * Find adjacent temperature ranges for Dutch bet from available markets.
 * Given NWS forecast, find the containing range and its neighbors.
 */
export function findDutchPositions(
  forecast: number,
  markets: { ticker: string; tempLow: number; tempHigh: number; yesPrice: number }[]
): { ticker: string; range: string; odds: number }[] {
  // Sort by tempLow ascending
  const sorted = (markets ?? [])?.sort((a: any, b: any) => (a?.tempLow ?? 0) - (b?.tempLow ?? 0));
  
  // Deduplicate: if multiple markets map to the same range, keep the one with higher yesPrice (more liquid)
  const deduped: typeof sorted = [];
  const seenRanges = new Map<string, number>();
  for (const m of sorted) {
    const rangeKey = `${m?.tempLow ?? 0}-${m?.tempHigh ?? 0}`;
    const existingIdx = seenRanges.get(rangeKey);
    if (existingIdx !== undefined) {
      // Keep the one with higher yesPrice (more liquid market)
      if ((m?.yesPrice ?? 0) > (deduped[existingIdx]?.yesPrice ?? 0)) {
        deduped[existingIdx] = m;
      }
    } else {
      seenRanges.set(rangeKey, deduped.length);
      deduped.push(m);
    }
  }

  if (deduped.length === 0) return [];
  
  // Find the market containing the forecast temperature
  // Use >= tempLow and <= tempHigh to handle edge cases where forecast equals the boundary
  let centerIdx = deduped.findIndex((m: any) => 
    forecast >= (m?.tempLow ?? 0) && forecast < (m?.tempHigh ?? 0)
  );
  
  // Also try inclusive upper bound (forecast == tempHigh)
  if (centerIdx === -1) {
    centerIdx = deduped.findIndex((m: any) =>
      forecast >= (m?.tempLow ?? 0) && forecast <= (m?.tempHigh ?? 0)
    );
  }

  if (centerIdx === -1) {
    // Find closest market by midpoint
    let closestIdx = 0;
    let closestDist = Infinity;
    deduped.forEach((m: any, i: number) => {
      const mid = ((m?.tempLow ?? 0) + (m?.tempHigh ?? 0)) / 2;
      const dist = Math.abs(forecast - mid);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    });
    return buildPositionsFromIndex(deduped, closestIdx);
  }

  return buildPositionsFromIndex(deduped, centerIdx);
}

function buildPositionsFromIndex(
  markets: { ticker: string; tempLow: number; tempHigh: number; yesPrice: number }[],
  centerIdx: number
): { ticker: string; range: string; odds: number }[] {
  const positions: { ticker: string; range: string; odds: number }[] = [];
  const safeMarkets = markets ?? [];

  // Add lower adjacent if exists
  if (centerIdx > 0) {
    const m = safeMarkets[centerIdx - 1];
    if (m) {
      positions.push({
        ticker: m?.ticker ?? '',
        range: `${m?.tempLow ?? 0}°F - ${m?.tempHigh ?? 0}°F`,
        odds: m?.yesPrice ?? 0,
      });
    }
  }

  // Add center
  const center = safeMarkets[centerIdx];
  if (center) {
    positions.push({
      ticker: center?.ticker ?? '',
      range: `${center?.tempLow ?? 0}°F - ${center?.tempHigh ?? 0}°F`,
      odds: center?.yesPrice ?? 0,
    });
  }

  // Add upper adjacent if exists
  if (centerIdx < (safeMarkets?.length ?? 0) - 1) {
    const m = safeMarkets[centerIdx + 1];
    if (m) {
      positions.push({
        ticker: m?.ticker ?? '',
        range: `${m?.tempLow ?? 0}°F - ${m?.tempHigh ?? 0}°F`,
        odds: m?.yesPrice ?? 0,
      });
    }
  }

  return positions;
}

/**
 * Calculate a UNIFORM contract count to buy for EVERY bin in a Dutch bet.
 *
 * Why uniform? Each Kalshi contract pays exactly $1 (100¢) if it wins. To guarantee
 * a profit no matter which bin wins, every bin must pay out at least the total cost
 * of all legs combined. Buying the SAME number of contracts in each bin makes the
 * payout identical across bins (count × 100¢), so the guarantee holds whenever the
 * sum of the per-contract prices is below 100¢.
 *
 * Buying different counts per bin (e.g. floor(stake_i / price_i)) breaks this: the
 * bin that ends up with fewer contracts has a smaller payout that may not cover the
 * combined cost — exactly the "one selection short of the others" bug.
 *
 * @param bidPrices  per-contract bid prices in cents for each bin (after slippage)
 * @param totalStakeCents  total dollars to deploy across all legs, in cents
 * @returns the number of contracts to buy in EACH bin (>= 1)
 */
export function calculateUniformContracts(
  bidPrices: number[],
  totalStakeCents: number
): number {
  const validPrices = (bidPrices ?? []).filter((p) => p > 0 && p < 100);
  const sumPrices = validPrices.reduce((s, p) => s + p, 0);
  if (sumPrices <= 0) return 0;
  return Math.max(1, Math.floor(totalStakeCents / sumPrices));
}

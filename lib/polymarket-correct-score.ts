/**
 * Polymarket Correct-Score Dutch Betting Library.
 *
 * Mirrors lib/correct-score.ts (Kalshi) but for Polymarket International
 * soccer EXACT-SCORE markets. Each scoreline is a binary YES/NO market on the
 * CLOB. Buying a BASKET of the most-likely scorelines whose combined YES cost
 * < $1.00 guarantees a profit of $1.00 - basketCost if ANY covered score hits.
 *
 * Money is normalized to CENTS (matching the Kalshi library) even though
 * Polymarket natively quotes decimal dollars.
 */

import {
  fetchSoccerExactScoreEvents,
  fetchExactScoreEventBySlug,
  PolyExactScoreEvent,
  PolyScoreMarket,
} from '@/lib/polymarket-api';

export interface PolyScoreline {
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  label: string;            // e.g. "Home 2 - 1 Away" / "Any Other Score"
  teamAScore: number;       // -1 for "Any Other Score"
  teamBScore: number;       // -1 for "Any Other Score"
  outcome: 'teamA' | 'teamB' | 'draw' | 'other';
  ask: number;              // YES ask in cents (true cost to buy)
  bid: number;              // YES bid in cents
  last: number;             // last traded price in cents
  impliedProb: number;      // ask / 100
  modelProb?: number;       // research probability (0-1) if available
  tickSize: number;
  minOrderSize: number;
  acceptingOrders: boolean;
  isAnyOther: boolean;
}

export interface PolyCorrectScoreMatch {
  slug: string;
  eventId: string;
  league: string;
  matchTitle: string;       // "Team A vs Team B"
  teamA: string;
  teamB: string;
  matchDate: string;
  startDate: string;
  endDate: string;          // Polymarket settlement time (~ match end) - ISO
  negRisk: boolean;
  scorelines: PolyScoreline[];
  overround: number;        // sum(all asks) - 100 (cents)
}

export interface PolyBasket {
  numPicks: number;
  scorelines: PolyScoreline[];
  combinedCost: number;     // sum of picked asks (cents)
  dutchProfit: number;      // 100 - combinedCost (cents per unit)
  dutchMargin: number;      // (100 - cost) / cost * 100
  coverage: number;         // sum of normalized probs of picked scores (0-1)
  expectedValue: number;    // coverage*100 - combinedCost (cents per unit)
  viable: boolean;
}

export interface PolyCorrectScoreAnalysis {
  match: PolyCorrectScoreMatch;
  baskets: PolyBasket[];
  recommended: PolyBasket | null;
  bestMargin: number;
  bestEdge: number;        // best expected value (edge, cents/unit) among in-range baskets
  edgeThreshold: number;   // min edge (cents/unit) required to recommend
  lowScore?: number;       // low-scoring consensus score (0-100) if known
  gateReason: string | null; // why no basket is recommended despite viable baskets existing
  rating: 'excellent' | 'good' | 'marginal' | 'none';
}

/**
 * Parse team names + scoreline out of a groupItemTitle such as
 * "Rochedale Rovers FC 1 - 0 SD Raiders FC".
 * Returns null when it cannot find the "X - Y" score pattern.
 */
function parseScoreTitle(
  title: string
): { teamA: string; teamB: string; a: number; b: number } | null {
  // Match "<teamA> <a> - <b> <teamB>"
  const m = title.match(/^(.*?)\s+(\d+)\s*-\s*(\d+)\s+(.*)$/);
  if (!m) return null;
  return {
    teamA: m[1].trim(),
    teamB: m[4].trim(),
    a: parseInt(m[2], 10),
    b: parseInt(m[3], 10),
  };
}

function toScoreline(mk: PolyScoreMarket): PolyScoreline | null {
  if (mk.isAnyOther) {
    return {
      conditionId: mk.conditionId,
      yesTokenId: mk.yesTokenId,
      noTokenId: mk.noTokenId,
      label: 'Any Other Score',
      teamAScore: -1,
      teamBScore: -1,
      outcome: 'other',
      ask: mk.yesAskCents,
      bid: mk.yesBidCents,
      last: mk.lastCents,
      impliedProb: mk.yesAskCents / 100,
      tickSize: mk.tickSize,
      minOrderSize: mk.minOrderSize,
      acceptingOrders: mk.acceptingOrders,
      isAnyOther: true,
    };
  }

  const parsed = parseScoreTitle(mk.groupItemTitle);
  if (!parsed) return null;
  let outcome: 'teamA' | 'teamB' | 'draw' = 'draw';
  if (parsed.a > parsed.b) outcome = 'teamA';
  else if (parsed.b > parsed.a) outcome = 'teamB';

  return {
    conditionId: mk.conditionId,
    yesTokenId: mk.yesTokenId,
    noTokenId: mk.noTokenId,
    label: `${parsed.a} - ${parsed.b}`,
    teamAScore: parsed.a,
    teamBScore: parsed.b,
    outcome,
    ask: mk.yesAskCents,
    bid: mk.yesBidCents,
    last: mk.lastCents,
    impliedProb: mk.yesAskCents / 100,
    tickSize: mk.tickSize,
    minOrderSize: mk.minOrderSize,
    acceptingOrders: mk.acceptingOrders,
    isAnyOther: false,
  };
}

/** Parse event title "Team A vs. Team B - Exact Score" into team names. */
function parseEventTeams(title: string): { teamA: string; teamB: string } {
  const beforeDash = (title ?? '').replace(/\s*-\s*Exact Score\s*$/i, '');
  const parts = beforeDash.split(/\s+vs\.?\s+/i);
  return {
    teamA: (parts[0] ?? '').trim() || 'Team A',
    teamB: (parts[1] ?? '').trim() || 'Team B',
  };
}

function eventToMatch(ev: PolyExactScoreEvent): PolyCorrectScoreMatch | null {
  const scorelines: PolyScoreline[] = [];
  for (const mk of ev.markets) {
    const sl = toScoreline(mk);
    // keep priced, tradeable scorelines only
    if (sl && sl.ask > 0 && sl.ask < 100) scorelines.push(sl);
  }
  if (scorelines.length < 3) return null;

  const { teamA, teamB } = parseEventTeams(ev.title);
  // Relabel numeric scorelines with team context for clarity.
  for (const sl of scorelines) {
    if (!sl.isAnyOther) {
      sl.label = `${teamA} ${sl.teamAScore} - ${sl.teamBScore} ${teamB}`;
    }
  }

  const overround = scorelines.reduce((s, x) => s + x.ask, 0) - 100;
  // The real match date is embedded in the slug ("...-YYYY-MM-DD-exact-score")
  // and mirrored by endDate (settlement). startDate is when the market OPENED
  // (often days earlier), so it must NOT be used as the match date.
  const slugDateMatch = ev.slug.match(/-(\d{4}-\d{2}-\d{2})-exact-score$/);
  // Prefer Polymarket's own kick-off date: postponed matches keep their ORIGINAL date in the slug.
  const matchDate = /^\d{4}-\d{2}-\d{2}$/.test(ev.eventDate || '')
    ? ev.eventDate
    : slugDateMatch
      ? slugDateMatch[1]
      : (ev.endDate || ev.startDate || '').slice(0, 10);

  return {
    slug: ev.slug,
    eventId: ev.eventId,
    league: ev.league,
    matchTitle: `${teamA} vs ${teamB}`,
    teamA,
    teamB,
    matchDate,
    startDate: ev.startDate,
    endDate: ev.endDate,
    negRisk: ev.negRisk,
    scorelines,
    overround,
  };
}

/** Fetch all open soccer exact-score matches from Polymarket. */
export async function fetchPolyCorrectScoreMatches(): Promise<PolyCorrectScoreMatch[]> {
  const events = await fetchSoccerExactScoreEvents();
  const matches: PolyCorrectScoreMatch[] = [];
  for (const ev of events) {
    if (ev.closed) continue;
    const m = eventToMatch(ev);
    if (m) matches.push(m);
  }
  // Sort by soonest match (settlement/kickoff) first.
  matches.sort((a, b) => (a.endDate || a.matchDate || '').localeCompare(b.endDate || b.matchDate || ''));
  return matches;
}

/** Fetch a single match by event slug. */
export async function fetchPolyMatchBySlug(slug: string): Promise<PolyCorrectScoreMatch | null> {
  const ev = await fetchExactScoreEventBySlug(slug);
  if (!ev) return null;
  return eventToMatch(ev);
}

/**
 * Build Dutch baskets for a match and pick the recommended one.
 * Identical strategy to the Kalshi library: rank scorelines by probability,
 * greedily accumulate while combined cost < 100c, recommend best EV within
 * [minPicks, maxPicks].
 */
export function analyzePolyCorrectScore(
  match: PolyCorrectScoreMatch,
  opts: { minPicks?: number; maxPicks?: number; includeAnyOther?: boolean; minEdge?: number; lowScore?: number; minLowScore?: number } = {}
): PolyCorrectScoreAnalysis {
  const minPicks = opts.minPicks ?? 4;
  const maxPicks = opts.maxPicks ?? 6;
  const includeAnyOther = opts.includeAnyOther ?? false;
  const minEdge = opts.minEdge ?? 0;
  const minLowScore = opts.minLowScore ?? 0;
  const lowScore = opts.lowScore;

  const pool = match.scorelines.filter(s => includeAnyOther || !s.isAnyOther);

  const ranked = [...pool].sort((a, b) => {
    const pa = a.modelProb ?? a.impliedProb;
    const pb = b.modelProb ?? b.impliedProb;
    return pb - pa;
  });

  const usingModel = ranked.some(s => typeof s.modelProb === 'number');
  const totalAsk = pool.reduce((s, x) => s + x.ask, 0) || 1;
  const probOf = (s: PolyScoreline): number =>
    usingModel ? (s.modelProb ?? 0) : s.ask / totalAsk;

  const baskets: PolyBasket[] = [];
  let cumCost = 0;
  let cumCoverage = 0;
  const picked: PolyScoreline[] = [];

  for (let k = 0; k < ranked.length; k++) {
    const s = ranked[k];
    cumCost += s.ask;
    cumCoverage += probOf(s);
    picked.push(s);
    if (cumCost >= 100) break;

    const numPicks = picked.length;
    if (numPicks < 2) continue;

    const dutchProfit = 100 - cumCost;
    const dutchMargin = cumCost > 0 ? (dutchProfit / cumCost) * 100 : 0;
    const coverage = Math.min(cumCoverage, 1);
    const expectedValue = coverage * 100 - cumCost;

    baskets.push({
      numPicks,
      scorelines: [...picked],
      combinedCost: cumCost,
      dutchProfit,
      dutchMargin: Math.round(dutchMargin * 100) / 100,
      coverage: Math.round(coverage * 1000) / 1000,
      expectedValue: Math.round(expectedValue * 100) / 100,
      viable: true,
    });
  }

  const inRange = baskets.filter(b => b.numPicks >= minPicks && b.numPicks <= maxPicks);
  const selectPool = inRange.length > 0 ? inRange : baskets;
  let best: PolyBasket | null = null;
  for (const b of selectPool) {
    if (!best || b.expectedValue > best.expectedValue) best = b;
  }

  // Gate the recommendation on a real positive edge AND (optionally) a
  // low-scoring signal — identical policy to the Kalshi library.
  let recommended: PolyBasket | null = null;
  let gateReason: string | null = null;
  if (best) {
    const lowBlocked = minLowScore > 0 && typeof lowScore === 'number' && lowScore < minLowScore;
    if (best.expectedValue < minEdge) {
      gateReason = `No basket clears the +${minEdge.toFixed(1)}¢ edge threshold (best modelled edge ${best.expectedValue.toFixed(1)}¢). Without an edge a Dutch basket only pays the market's margin. Run Research to price a real edge, or place manually.`;
    } else if (lowBlocked) {
      gateReason = `Low-scoring signal ${lowScore}/100 is below your ${minLowScore} threshold — the model projects a higher-scoring game, historically the biggest loss driver. Skipped, or place manually.`;
    } else {
      recommended = best;
    }
  }

  // "Margin" here is the return IF one of the picked scorelines lands (the basket does not cover
  // every result). Measure it only on baskets of the size we would actually recommend/place;
  // over all sizes it was always the cheapest 2-pick basket (e.g. 376%) and drove sort/filter.
  const bestMargin = selectPool.reduce((m, b) => Math.max(m, b.dutchMargin), 0);
  const bestEdge = best?.expectedValue ?? 0;
  let rating: 'excellent' | 'good' | 'marginal' | 'none' = 'none';
  if (recommended) {
    const ev = recommended.expectedValue;
    if (ev >= 8) rating = 'excellent';
    else if (ev >= 4) rating = 'good';
    else rating = 'marginal';
  }

  return { match, baskets, recommended, bestMargin, bestEdge, edgeThreshold: minEdge, lowScore, gateReason, rating };
}

/**
 * Calculate uniform contract allocation for a basket.
 * Polymarket enforces a MINIMUM order size (usually 5 contracts) per leg and a
 * price tick size, so the contract count is floored to respect the minimum.
 */
export function calculatePolyBasketStake(
  basket: PolyBasket,
  totalStakeDollars: number,
  slippageCents: number = 1
): {
  contracts: number;
  legs: { tokenId: string; label: string; askCents: number; buyPriceCents: number; buyPriceDollars: number; tickSize: number }[];
  costPerUnit: number;      // sum of leg buy prices (cents)
  totalCostCents: number;
  expectedPayoutCents: number;
  profitIfWinCents: number;
  minOrderSize: number;
  meetsMinimum: boolean;
} {
  const totalStakeCents = Math.round(totalStakeDollars * 100);
  const minOrderSize = basket.scorelines.reduce((m, s) => Math.max(m, s.minOrderSize || 5), 5);

  const legs = basket.scorelines.map(s => {
    // round buy price up to the leg tick size
    const tick = s.tickSize && s.tickSize > 0 ? s.tickSize : 0.01;
    const tickCents = tick * 100;
    const rawBuyCents = Math.min(s.ask + slippageCents, 99);
    const buyPriceCents = Math.min(99, Math.ceil(rawBuyCents / tickCents) * tickCents);
    return {
      tokenId: s.yesTokenId,
      label: s.label,
      askCents: s.ask,
      buyPriceCents: Math.round(buyPriceCents),
      buyPriceDollars: Math.round(buyPriceCents) / 100,
      tickSize: tick,
    };
  });

  const costPerUnit = legs.reduce((s, x) => s + x.buyPriceCents, 0);
  if (costPerUnit >= 100 || costPerUnit <= 0) {
    return {
      contracts: 0, legs, costPerUnit, totalCostCents: 0,
      expectedPayoutCents: 0, profitIfWinCents: 0, minOrderSize, meetsMinimum: false,
    };
  }

  let contracts = Math.max(minOrderSize, Math.floor(totalStakeCents / costPerUnit));
  const totalCostCents = contracts * costPerUnit;
  const expectedPayoutCents = contracts * 100;
  const profitIfWinCents = expectedPayoutCents - totalCostCents;
  const meetsMinimum = contracts >= minOrderSize;

  return {
    contracts, legs, costPerUnit, totalCostCents,
    expectedPayoutCents, profitIfWinCents, minOrderSize, meetsMinimum,
  };
}

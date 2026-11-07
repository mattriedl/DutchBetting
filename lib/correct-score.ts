/**
 * Correct-Score Dutch Betting Library
 *
 * Applies the Dutch-betting concept to soccer EXACT SCORE markets on Kalshi.
 * Each scoreline (e.g. "Portugal wins 2-1") is a separate binary YES/NO market.
 * By buying a BASKET of the most likely scorelines whose combined cost < $1.00,
 * you profit $1.00 - basketCost if ANY covered scoreline hits.
 *
 * Kalshi offers correct-score (exact-score) markets across many soccer
 * competitions (World Cup, MLS, UEFA Europa League, Liga MX, and more).
 * Kalshi's public API has no "list all series by tag" endpoint, so the fetcher
 * probes a comprehensive list of candidate series tickers and keeps whichever
 * are live. New competitions are picked up by adding their ticker here.
 */

import { kalshiPublicFetch } from '@/lib/kalshi-api';

// Candidate soccer exact-score series on Kalshi. Series that aren't currently
// live simply return zero events and are skipped. The ones marked (live) were
// confirmed active; the rest are probed defensively so new competitions and
// seasonal tournaments are surfaced automatically.
export const SCORE_SERIES = [
  // --- Confirmed live ---
  { ticker: 'KXWCSCORE', league: 'FIFA World Cup' },
  { ticker: 'KXMLSSCORE', league: 'MLS' },
  { ticker: 'KXUELSCORE', league: 'UEFA Europa League' },
  { ticker: 'KXLIGAMXSCORE', league: 'Liga MX' },
  // --- European club competitions ---
  { ticker: 'KXUCLSCORE', league: 'UEFA Champions League' },
  { ticker: 'KXUECLSCORE', league: 'UEFA Conference League' },
  { ticker: 'KXEPLSCORE', league: 'English Premier League' },
  { ticker: 'KXLALIGASCORE', league: 'La Liga' },
  { ticker: 'KXSERIEASCORE', league: 'Serie A' },
  { ticker: 'KXBUNDESLIGASCORE', league: 'Bundesliga' },
  { ticker: 'KXLIGUE1SCORE', league: 'Ligue 1' },
  { ticker: 'KXEREDIVISIESCORE', league: 'Eredivisie' },
  { ticker: 'KXPRIMEIRASCORE', league: 'Primeira Liga' },
  { ticker: 'KXCHAMPIONSHIPSCORE', league: 'EFL Championship' },
  // --- Domestic cups ---
  { ticker: 'KXFACUPSCORE', league: 'FA Cup' },
  { ticker: 'KXCARABAOSCORE', league: 'Carabao Cup' },
  { ticker: 'KXCOPADELREYSCORE', league: 'Copa del Rey' },
  { ticker: 'KXDFBSCORE', league: 'DFB-Pokal' },
  { ticker: 'KXCOPPASCORE', league: 'Coppa Italia' },
  // --- Americas ---
  { ticker: 'KXLEAGUESCUPSCORE', league: 'Leagues Cup' },
  { ticker: 'KXUSOPENCUPSCORE', league: 'US Open Cup' },
  { ticker: 'KXBRASILEIRAOSCORE', league: 'Brasileirão' },
  { ticker: 'KXLIBERTADORESSCORE', league: 'Copa Libertadores' },
  { ticker: 'KXCONCACAFSCORE', league: 'CONCACAF Champions Cup' },
  { ticker: 'KXNWSLSCORE', league: 'NWSL' },
  // --- National teams / tournaments ---
  { ticker: 'KXCLUBWCSCORE', league: 'Club World Cup' },
  { ticker: 'KXWWCSCORE', league: "FIFA Women's World Cup" },
  { ticker: 'KXEUROSCORE', league: 'UEFA Euro' },
  { ticker: 'KXCOPASCORE', league: 'Copa América' },
  { ticker: 'KXNATIONSSCORE', league: 'UEFA Nations League' },
  { ticker: 'KXFRIENDLYSCORE', league: 'International Friendly' },
] as const;

export interface Scoreline {
  ticker: string;        // full market ticker
  label: string;         // clean label e.g. "Portugal wins 2-1" / "Draw 1-1"
  teamAScore: number;
  teamBScore: number;
  outcome: 'teamA' | 'teamB' | 'draw';
  ask: number;           // YES ask in cents
  bid: number;           // YES bid in cents
  last: number;          // last traded price in cents
  impliedProb: number;   // ask / 100 (market implied, includes vig)
  modelProb?: number;    // research/Poisson probability (0-1) if available
}

export interface CorrectScoreMatch {
  eventTicker: string;
  seriesTicker: string;
  league: string;
  matchTitle: string;    // "Portugal vs Croatia"
  subTitle: string;
  teamA: string;
  teamB: string;
  matchDate: string;     // YYYY-MM-DD
  expirationTime: string;
  scorelines: Scoreline[];
  overround: number;     // sum(all asks) - 100 (vig, cents)
}

export interface Basket {
  numPicks: number;
  scorelines: Scoreline[];
  combinedCost: number;    // sum of picked asks (cents)
  dutchProfit: number;     // 100 - combinedCost (cents per unit)
  dutchMargin: number;     // (100 - cost) / cost * 100
  coverage: number;        // sum of normalized probabilities of picked scores (0-1)
  expectedValue: number;   // coverage*100 - combinedCost (cents per unit)
  viable: boolean;         // combinedCost < 100
}

export interface CorrectScoreAnalysis {
  match: CorrectScoreMatch;
  baskets: Basket[];       // baskets for k = 2 .. maxViable
  recommended: Basket | null;
  bestMargin: number;
  bestEdge: number;        // best expected value (edge, cents/unit) among in-range baskets
  edgeThreshold: number;   // min edge (cents/unit) required to recommend
  lowScore?: number;       // low-scoring consensus score (0-100) if known
  gateReason: string | null; // why no basket is recommended despite viable baskets existing
  rating: 'excellent' | 'good' | 'marginal' | 'none';
}

function parseDollarsToCents(val: any): number {
  if (val == null) return 0;
  const parsed = parseFloat(String(val));
  return isNaN(parsed) ? 0 : Math.round(parsed * 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Extract match date from event ticker e.g. KXWCSCORE-26JUL02PORCRO -> 2026-07-02 */
function extractMatchDate(eventTicker: string): string {
  const m = eventTicker.match(/(\d{2})([A-Z]{3})(\d{2})[A-Z]/);
  if (!m) return '';
  const mm: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
  };
  return `20${m[1]}-${mm[m[2]] ?? '01'}-${m[3]}`;
}

/** Parse the two team names out of an event title like
 *  "Portugal vs Croatia: Regulation Time Correct Score" */
function parseTeams(title: string): { teamA: string; teamB: string } {
  const beforeColon = (title ?? '').split(':')[0] ?? '';
  const parts = beforeColon.split(/\s+vs\.?\s+/i);
  return {
    teamA: (parts[0] ?? '').trim() || 'Team A',
    teamB: (parts[1] ?? '').trim() || 'Team B',
  };
}

/** Parse a scoreline market into structured data. */
function parseScoreline(market: any, eventTicker: string): Scoreline | null {
  const ticker: string = market?.ticker ?? '';
  const suffix = ticker.split('-').pop() ?? '';
  // suffix like POR3CRO1 -> [ , POR, 3, CRO, 1 ]
  const m = suffix.match(/^([A-Z]+)(\d+)([A-Z]+)(\d+)$/);
  if (!m) return null;
  const teamAScore = parseInt(m[2], 10);
  const teamBScore = parseInt(m[4], 10);
  const ask = parseDollarsToCents(market?.yes_ask_dollars);
  const bid = parseDollarsToCents(market?.yes_bid_dollars);
  const last = parseDollarsToCents(market?.last_price_dollars);

  const rawSub: string = market?.yes_sub_title ?? '';
  const label = rawSub.replace(/^Reg(ulation)?\s*Time:\s*/i, '').trim()
    || `${teamAScore}-${teamBScore}`;

  let outcome: 'teamA' | 'teamB' | 'draw' = 'draw';
  if (teamAScore > teamBScore) outcome = 'teamA';
  else if (teamBScore > teamAScore) outcome = 'teamB';

  return {
    ticker,
    label,
    teamAScore,
    teamBScore,
    outcome,
    ask,
    bid,
    last,
    impliedProb: ask / 100,
  };
}

/**
 * Fetch all open exact-score match events from Kalshi.
 */
async function fetchSeriesMatches(
  series: { ticker: string; league: string },
  environment: string
): Promise<CorrectScoreMatch[]> {
  const out: CorrectScoreMatch[] = [];
  const DELAY_MS = 200;
  // Fetch one page, retrying a few times on 429 so a live series is never
  // dropped just because the rate limiter was briefly hit.
  const fetchPage = async (cursorParam: string): Promise<any> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await kalshiPublicFetch(
          `/events?series_ticker=${series.ticker}&status=open&limit=50&with_nested_markets=true${cursorParam}`,
          environment
        );
      } catch (e: any) {
        if (e?.message?.includes?.('429') && attempt < 3) {
          await sleep(1200 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    return null;
  };
  try {
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const cursorParam = cursor ? `&cursor=${cursor}` : '';
      const result = await fetchPage(cursorParam);

      const events = result?.events ?? [];
      for (const event of events) {
        const rawMarkets = event?.markets ?? [];
        if (rawMarkets.length < 3) continue; // need a real scoreline grid

        const eventTicker = event?.event_ticker ?? '';
        const scorelines: Scoreline[] = [];
        for (const mk of rawMarkets) {
          const sl = parseScoreline(mk, eventTicker);
          // keep only priced, tradeable scorelines
          if (sl && sl.ask > 0 && sl.ask < 100) scorelines.push(sl);
        }
        if (scorelines.length < 3) continue;

        const { teamA, teamB } = parseTeams(event?.title ?? '');
        const overround = scorelines.reduce((s, x) => s + x.ask, 0) - 100;

        out.push({
          eventTicker,
          seriesTicker: series.ticker,
          league: series.league,
          matchTitle: `${teamA} vs ${teamB}`,
          subTitle: event?.sub_title ?? '',
          teamA,
          teamB,
          matchDate: extractMatchDate(eventTicker),
          expirationTime: rawMarkets[0]?.expiration_time ?? '',
          scorelines,
          overround,
        });
      }

      cursor = result?.cursor ?? null;
      hasMore = !!cursor && events.length > 0;
      if (hasMore) await sleep(DELAY_MS);
    }

    if (out.length > 0) console.log(`[CorrectScore] ${series.ticker}: ${out.length} matches`);
  } catch (err: any) {
    console.log(`[CorrectScore] ${series.ticker} error: ${err?.message}`);
    if (err?.message?.includes?.('429')) await sleep(3000);
  }
  return out;
}

export async function fetchCorrectScoreMatches(
  environment: string = 'production'
): Promise<CorrectScoreMatch[]> {
  const matches: CorrectScoreMatch[] = [];
  // Probe all candidate series in small concurrent batches so the ~30-series
  // scan stays fast without hammering Kalshi's rate limits.
  const BATCH_SIZE = 3;
  const BATCH_DELAY_MS = 400;

  for (let i = 0; i < SCORE_SERIES.length; i += BATCH_SIZE) {
    const batch = SCORE_SERIES.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(s => fetchSeriesMatches({ ticker: s.ticker, league: s.league }, environment))
    );
    for (const r of results) matches.push(...r);
    if (i + BATCH_SIZE < SCORE_SERIES.length) await sleep(BATCH_DELAY_MS);
  }

  return matches;
}

/**
 * Build Dutch baskets for a match and pick the recommended one.
 *
 * Strategy: rank scorelines by probability (model probability if research is
 * supplied, otherwise market-implied ask). Greedily accumulate the most likely
 * scorelines; each additional pick raises coverage but also cost. A basket is
 * viable while combinedCost < 100c. We surface every basket size and recommend
 * the one that maximizes expected value within [minPicks, maxPicks].
 */
export function analyzeCorrectScore(
  match: CorrectScoreMatch,
  opts: { minPicks?: number; maxPicks?: number; minEdge?: number; lowScore?: number; minLowScore?: number } = {}
): CorrectScoreAnalysis {
  const minPicks = opts.minPicks ?? 4;
  const maxPicks = opts.maxPicks ?? 6;
  const minEdge = opts.minEdge ?? 0;
  const minLowScore = opts.minLowScore ?? 0;
  const lowScore = opts.lowScore;

  // Rank by model probability when available, else by market implied ask.
  const ranked = [...match.scorelines].sort((a, b) => {
    const pa = a.modelProb ?? a.impliedProb;
    const pb = b.modelProb ?? b.impliedProb;
    return pb - pa;
  });

  // Normalizer for coverage: prefer model probs (already true probs, sum ~1),
  // else normalize market asks by their total (removes overround/vig).
  const usingModel = ranked.some(s => typeof s.modelProb === 'number');
  const totalAsk = match.scorelines.reduce((s, x) => s + x.ask, 0) || 1;
  const probOf = (s: Scoreline): number =>
    usingModel ? (s.modelProb ?? 0) : s.ask / totalAsk;

  const baskets: Basket[] = [];
  let cumCost = 0;
  let cumCoverage = 0;
  const picked: Scoreline[] = [];

  for (let k = 0; k < ranked.length; k++) {
    const s = ranked[k];
    cumCost += s.ask;
    cumCoverage += probOf(s);
    picked.push(s);
    if (cumCost >= 100) break; // no longer a guaranteed-profit Dutch basket

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

  // Candidate: best EXPECTED VALUE (edge) within [minPicks, maxPicks].
  const inRange = baskets.filter(b => b.numPicks >= minPicks && b.numPicks <= maxPicks);
  const pool = inRange.length > 0 ? inRange : baskets;
  let best: Basket | null = null;
  for (const b of pool) {
    if (!best || b.expectedValue > best.expectedValue) best = b;
  }

  // Gate the recommendation on a real positive edge AND (optionally) a
  // low-scoring signal. A Dutch basket with no modelled edge only locks in the
  // bookmaker's overround, and high-scoring games are the largest historical
  // loss driver — so we refuse to recommend either.
  let recommended: Basket | null = null;
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

  const bestMargin = baskets.reduce((m, b) => Math.max(m, b.dutchMargin), 0);
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
 * Buy the SAME contract count in every leg so any single winning scoreline
 * pays count * 100c >= total cost.
 */
export function calculateBasketStake(
  basket: Basket,
  totalStakeDollars: number,
  slippageCents: number = 1
): {
  contracts: number;
  legBidPrices: { ticker: string; bidPrice: number }[];
  costPerUnit: number;      // sum of leg bid prices (cents)
  totalCostCents: number;
  expectedPayoutCents: number;
  profitIfWinCents: number;
} {
  const totalStakeCents = Math.round(totalStakeDollars * 100);
  const legBidPrices = basket.scorelines.map(s => ({
    ticker: s.ticker,
    bidPrice: Math.min(s.ask + slippageCents, 99),
  }));
  const costPerUnit = legBidPrices.reduce((s, x) => s + x.bidPrice, 0);

  if (costPerUnit >= 100 || costPerUnit <= 0) {
    return { contracts: 0, legBidPrices, costPerUnit, totalCostCents: 0, expectedPayoutCents: 0, profitIfWinCents: 0 };
  }

  const contracts = Math.max(1, Math.floor(totalStakeCents / costPerUnit));
  const totalCostCents = contracts * costPerUnit;
  const expectedPayoutCents = contracts * 100; // $1 per contract if any covered score hits
  const profitIfWinCents = expectedPayoutCents - totalCostCents;

  return { contracts, legBidPrices, costPerUnit, totalCostCents, expectedPayoutCents, profitIfWinCents };
}

/**
 * Fetch a single exact-score event by its event ticker (used by the research
 * endpoint to enrich one match at a time).
 */
export async function fetchMatchByEvent(
  eventTicker: string,
  environment: string = 'production'
): Promise<CorrectScoreMatch | null> {
  try {
    const result = await kalshiPublicFetch(
      `/events/${eventTicker}?with_nested_markets=true`,
      environment
    );
    const event = result?.event ?? result;
    const rawMarkets = event?.markets ?? [];
    if (rawMarkets.length < 3) return null;

    const seriesTicker = eventTicker.split('-')[0] ?? '';
    const known = SCORE_SERIES.find(s => s.ticker === seriesTicker);
    const league = known?.league ?? 'Soccer';

    const scorelines: Scoreline[] = [];
    for (const mk of rawMarkets) {
      const sl = parseScoreline(mk, eventTicker);
      if (sl && sl.ask > 0 && sl.ask < 100) scorelines.push(sl);
    }
    if (scorelines.length < 3) return null;

    const { teamA, teamB } = parseTeams(event?.title ?? '');
    const overround = scorelines.reduce((s, x) => s + x.ask, 0) - 100;

    return {
      eventTicker,
      seriesTicker,
      league,
      matchTitle: `${teamA} vs ${teamB}`,
      subTitle: event?.sub_title ?? '',
      teamA,
      teamB,
      matchDate: extractMatchDate(eventTicker),
      expirationTime: rawMarkets[0]?.expiration_time ?? '',
      scorelines,
      overround,
    };
  } catch (err: any) {
    console.log(`[CorrectScore] fetchMatchByEvent ${eventTicker} error: ${err?.message}`);
    return null;
  }
}

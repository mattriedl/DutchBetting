/**
 * Soccer Dutch Betting Library
 * 
 * Fetches soccer match markets from Kalshi and calculates 2-way Dutch bets:
 * Buy Favorite WIN + DRAW contracts. If either hits, you win $1.00 per contract.
 * The only loss scenario is when the underdog wins outright.
 * 
 * Profit when combined cost (fav_win_ask + draw_ask) < $1.00.
 */

import { kalshiPublicFetch } from '@/lib/kalshi-api';

// Supported soccer series on Kalshi
export const SOCCER_SERIES = [
  // Verified against Kalshi GET /series?category=Sports on 2026-11-10.
  { ticker: 'KXEPLGAME', league: 'English Premier League', active: true },
  { ticker: 'KXLALIGAGAME', league: 'La Liga', active: true },
  { ticker: 'KXSERIEAGAME', league: 'Serie A', active: true },
  { ticker: 'KXBUNDESLIGAGAME', league: 'Bundesliga', active: true },
  { ticker: 'KXLIGUE1GAME', league: 'Ligue 1', active: true },
  { ticker: 'KXUCLGAME', league: 'UEFA Champions League', active: true },
  { ticker: 'KXUELGAME', league: 'UEFA Europa League', active: true },
  { ticker: 'KXUECLGAME', league: 'UEFA Conference League', active: true },
  { ticker: 'KXUEFANLGAME', league: 'UEFA Nations League', active: true },
  { ticker: 'KXUEFAGAME', league: 'UEFA', active: true },
  { ticker: 'KXINTLFRIENDLYGAME', league: 'International Friendly', active: true },
  { ticker: 'KXFIFAGAME', league: 'FIFA', active: true },
  { ticker: 'KXWCGAME', league: 'FIFA World Cup', active: true },
  { ticker: 'KXCLUBWCGAME', league: 'Club World Cup', active: true },
  { ticker: 'KXEREDIVISIEGAME', league: 'Eredivisie', active: true },
  { ticker: 'KXLIGAPORTUGALGAME', league: 'Primeira Liga', active: true },
  { ticker: 'KXEFLCHAMPIONSHIPGAME', league: 'EFL Championship', active: true },
  { ticker: 'KXFACUPGAME', league: 'FA Cup', active: true },
  { ticker: 'KXEFLCUPGAME', league: 'EFL Cup', active: true },
  { ticker: 'KXMLSGAME', league: 'MLS', active: true },
  { ticker: 'KXLIGAMXGAME', league: 'Liga MX', active: true },
  { ticker: 'KXBRASILEIROGAME', league: 'Brasileirão', active: true },
  { ticker: 'KXCONMEBOLLIBGAME', league: 'Copa Libertadores', active: true },
  { ticker: 'KXCONCACAFCCUPGAME', league: 'CONCACAF Champions Cup', active: true },
  { ticker: 'KXCANPLGAME', league: 'Canadian Premier League', active: true },
  { ticker: 'KXAFCCLGAME', league: 'AFC Champions League', active: true },
] as const;

export interface SoccerMatch {
  eventTicker: string;
  seriesTicker: string;
  league: string;
  matchTitle: string;
  subTitle: string;
  teamA: string;         // first team in matchup
  teamB: string;         // second team
  teamATicker: string;   // market ticker for team A win
  teamBTicker: string;   // market ticker for team B win
  drawTicker: string;    // market ticker for draw
  teamAAsk: number;      // YES ask price in cents
  teamBAsk: number;
  drawAsk: number;
  teamABid: number;      // YES bid price in cents
  teamBBid: number;
  drawBid: number;
  teamALast: number;
  teamBLast: number;
  drawLast: number;
  expirationTime: string;
  matchDate: string;     // extracted date (YYYY-MM-DD)
}

export interface SoccerDutchAnalysis {
  match: SoccerMatch;
  favorite: 'teamA' | 'teamB';
  favoriteName: string;
  underdogName: string;
  // Dutch bet: Favorite Win + Draw
  favWinAsk: number;     // cents
  drawAsk: number;       // cents
  combinedCost: number;  // favWinAsk + drawAsk (cents)
  dutchProfit: number;   // 100 - combinedCost (cents per contract pair)
  dutchMargin: number;   // profit % = (100 - combinedCost) / combinedCost * 100
  // Reverse Dutch: Underdog Win + Draw
  underdogWinAsk: number;
  reverseCombinedCost: number;
  reverseDutchMargin: number;
  // Stake allocation
  isViable: boolean;     // combinedCost < 100 (profitable)
  rating: 'excellent' | 'good' | 'marginal' | 'none';
  // Additional context
  impliedFavWinProb: number;   // favWinAsk / 100
  impliedDrawProb: number;
  impliedUnderdogProb: number;
  overround: number;     // sum of all 3 asks - 100 (vig)
}

function parseDollarsToCents(val: any): number {
  if (val == null) return 0;
  const parsed = parseFloat(String(val));
  return isNaN(parsed) ? 0 : Math.round(parsed * 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract match date from event ticker.
 * e.g. KXWCGAME-26JUN27JORARG -> 2026-06-27
 */
function extractMatchDate(eventTicker: string): string {
  const m = eventTicker.match(/(\d{2})([A-Z]{3})(\d{2})[A-Z]/);
  if (!m) return '';
  const mm: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
  };
  return `20${m[1]}-${mm[m[2]] ?? '01'}-${m[3]}`;
}

/**
 * Extract team name from market subtitle or ticker suffix.
 */
function extractTeamFromMarket(market: any, eventTicker: string): string {
  // subtitle is most reliable (e.g. "Argentina", "Jordan")
  if (market?.subtitle) return market.subtitle;
  // Fallback: parse from ticker (e.g. KXWCGAME-26JUN27JORARG-ARG -> ARG)
  const suffix = market?.ticker?.replace(eventTicker + '-', '') ?? '';
  return suffix || 'Unknown';
}

/**
 * Fetch all open soccer match events from Kalshi.
 * Returns parsed SoccerMatch objects for all leagues with active markets.
 */
export async function fetchSoccerMatches(
  environment: string = 'production'
): Promise<SoccerMatch[]> {
  const matches: SoccerMatch[] = [];
  const DELAY_MS = 350;

  for (let i = 0; i < SOCCER_SERIES.length; i++) {
    const series = SOCCER_SERIES[i];
    if (i > 0) await sleep(DELAY_MS);

    try {
      let cursor: string | null = null;
      let hasMore = true;

      while (hasMore) {
        const cursorParam = cursor ? `&cursor=${cursor}` : '';
        const result = await kalshiPublicFetch(
          `/events?series_ticker=${series.ticker}&status=open&limit=50&with_nested_markets=true${cursorParam}`,
          environment
        );

        const events = result?.events ?? [];
        for (const event of events) {
          const markets = event?.markets ?? [];
          // Need exactly 3 markets: Team A, Team B, Draw
          if (markets.length !== 3) continue;

          const tieMarket = markets.find((m: any) => m?.ticker?.endsWith?.('-TIE'));
          const teamMarkets = markets.filter((m: any) => !m?.ticker?.endsWith?.('-TIE'));

          if (!tieMarket || teamMarkets.length !== 2) continue;

          // Team A is the first team in the event title/ticker
          // The first non-TIE market listed is usually team A
          const teamAMarket = teamMarkets[0];
          const teamBMarket = teamMarkets[1];

          const matchDate = extractMatchDate(event.event_ticker ?? '');

          matches.push({
            eventTicker: event.event_ticker ?? '',
            seriesTicker: series.ticker,
            league: series.league,
            matchTitle: event.title ?? '',
            subTitle: event.sub_title ?? '',
            teamA: extractTeamFromMarket(teamAMarket, event.event_ticker),
            teamB: extractTeamFromMarket(teamBMarket, event.event_ticker),
            teamATicker: teamAMarket?.ticker ?? '',
            teamBTicker: teamBMarket?.ticker ?? '',
            drawTicker: tieMarket?.ticker ?? '',
            teamAAsk: parseDollarsToCents(teamAMarket?.yes_ask_dollars),
            teamBAsk: parseDollarsToCents(teamBMarket?.yes_ask_dollars),
            drawAsk: parseDollarsToCents(tieMarket?.yes_ask_dollars),
            teamABid: parseDollarsToCents(teamAMarket?.yes_bid_dollars),
            teamBBid: parseDollarsToCents(teamBMarket?.yes_bid_dollars),
            drawBid: parseDollarsToCents(tieMarket?.yes_bid_dollars),
            teamALast: parseDollarsToCents(teamAMarket?.last_price_dollars),
            teamBLast: parseDollarsToCents(teamBMarket?.last_price_dollars),
            drawLast: parseDollarsToCents(tieMarket?.last_price_dollars),
            expirationTime: teamAMarket?.expiration_time ?? '',
            matchDate,
          });
        }

        cursor = result?.cursor ?? null;
        hasMore = !!cursor && events.length > 0;
        if (hasMore) await sleep(DELAY_MS);
      }

      const count = matches.filter(m => m.seriesTicker === series.ticker).length;
      if (count > 0) {
        console.log(`[Soccer] ${series.ticker} (${series.league}): ${count} matches`);
      }
    } catch (err: any) {
      console.log(`[Soccer] ${series.ticker} error: ${err?.message}`);
      if (err?.message?.includes?.('429')) {
        await sleep(3000);
      }
    }
  }

  return matches;
}

/**
 * Analyze a soccer match for 2-way Dutch betting (Favorite Win + Draw).
 * 
 * Strategy: Buy favorite's WIN contract + DRAW contract.
 * - If favorite wins: WIN contract pays $1.00, DRAW pays $0 → net = $1.00 - cost
 * - If match draws: DRAW pays $1.00, WIN pays $0 → net = $1.00 - cost
 * - If underdog wins: both pay $0 → loss = -cost
 * 
 * Profitable when combinedCost < $1.00 (100¢)
 */
export function analyzeSoccerDutch(match: SoccerMatch): SoccerDutchAnalysis {
  // Determine favorite: team with higher ask price is more likely to win
  const teamAAsk = match.teamAAsk || match.teamALast || 0;
  const teamBAsk = match.teamBAsk || match.teamBLast || 0;
  const drawAsk = match.drawAsk || match.drawLast || 0;

  const favorite: 'teamA' | 'teamB' = teamAAsk >= teamBAsk ? 'teamA' : 'teamB';
  const favWinAsk = favorite === 'teamA' ? teamAAsk : teamBAsk;
  const underdogWinAsk = favorite === 'teamA' ? teamBAsk : teamAAsk;
  const favoriteName = favorite === 'teamA' ? match.teamA : match.teamB;
  const underdogName = favorite === 'teamA' ? match.teamB : match.teamA;

  // Dutch bet: Favorite Win + Draw
  const combinedCost = favWinAsk + drawAsk;
  const dutchProfit = 100 - combinedCost;
  const dutchMargin = combinedCost > 0 ? (dutchProfit / combinedCost) * 100 : 0;

  // Reverse Dutch: Underdog Win + Draw (alternative strategy)
  const reverseCombinedCost = underdogWinAsk + drawAsk;
  const reverseDutchMargin = reverseCombinedCost > 0
    ? ((100 - reverseCombinedCost) / reverseCombinedCost) * 100
    : 0;

  // Overround (vig) — sum of all 3 implied probabilities should be ~100%
  const overround = teamAAsk + teamBAsk + drawAsk - 100;

  const isViable = combinedCost > 0 && combinedCost < 100;

  let rating: 'excellent' | 'good' | 'marginal' | 'none' = 'none';
  if (isViable) {
    if (dutchMargin >= 15) rating = 'excellent';
    else if (dutchMargin >= 8) rating = 'good';
    else if (dutchMargin >= 3) rating = 'marginal';
  }

  return {
    match,
    favorite,
    favoriteName,
    underdogName,
    favWinAsk,
    drawAsk,
    combinedCost,
    dutchProfit,
    dutchMargin: Math.round(dutchMargin * 100) / 100,
    underdogWinAsk,
    reverseCombinedCost,
    reverseDutchMargin: Math.round(reverseDutchMargin * 100) / 100,
    isViable,
    rating,
    impliedFavWinProb: favWinAsk / 100,
    impliedDrawProb: drawAsk / 100,
    impliedUnderdogProb: underdogWinAsk / 100,
    overround,
  };
}

/**
 * Calculate stake allocation for a soccer Dutch bet.
 * Since both legs pay $1.00 per contract, we buy the same number of contracts for each.
 * The number of contracts = floor(totalStake / combinedCostPerPair)
 */
export function calculateSoccerStake(
  analysis: SoccerDutchAnalysis,
  totalStakeDollars: number,
  slippageCents: number = 2
): {
  favWinContracts: number;
  drawContracts: number;
  favWinBidPrice: number;   // price with slippage
  drawBidPrice: number;     // price with slippage
  totalCostCents: number;
  expectedPayoutCents: number;
  profitIfWinCents: number;
} {
  const totalStakeCents = Math.round(totalStakeDollars * 100);

  // Apply slippage to each leg
  const favWinBidPrice = Math.min(analysis.favWinAsk + slippageCents, 99);
  const drawBidPrice = Math.min(analysis.drawAsk + slippageCents, 99);
  const costPerPair = favWinBidPrice + drawBidPrice;

  if (costPerPair >= 100 || costPerPair <= 0) {
    return {
      favWinContracts: 0,
      drawContracts: 0,
      favWinBidPrice,
      drawBidPrice,
      totalCostCents: 0,
      expectedPayoutCents: 0,
      profitIfWinCents: 0,
    };
  }

  // Buy equal contracts for both legs
  const numContracts = Math.floor(totalStakeCents / costPerPair);
  if (numContracts <= 0) {
    return {
      favWinContracts: 0,
      drawContracts: 0,
      favWinBidPrice,
      drawBidPrice,
      totalCostCents: 0,
      expectedPayoutCents: 0,
      profitIfWinCents: 0,
    };
  }

  const totalCostCents = numContracts * costPerPair;
  const expectedPayoutCents = numContracts * 100; // $1 per contract if either leg wins
  const profitIfWinCents = expectedPayoutCents - totalCostCents;

  return {
    favWinContracts: numContracts,
    drawContracts: numContracts,
    favWinBidPrice,
    drawBidPrice,
    totalCostCents,
    expectedPayoutCents,
    profitIfWinCents,
  };
}

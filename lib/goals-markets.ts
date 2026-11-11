/**
 * Goals Markets Library (Phase A)
 *
 * Applies directional value betting to two Kalshi soccer market families:
 *   1. BTTS  — "Both Teams To Score" (a single binary YES/NO market).
 *      Series: KX<LEAGUE>BTTS, market suffix "-BTTS".
 *   2. TOTAL — "Total Goals" over/under ladder (Over 0.5 / 1.5 / 2.5 / 3.5 ...).
 *      Series: KX<LEAGUE>TOTAL, market suffixes -1 (Over 0.5) .. -N.
 *
 * Unlike correct-score (a Dutch BASKET across scorelines), these are SINGLE
 * binary markets. The play is a directional value bet: compare a model
 * probability (AI/Poisson) to the market-implied price and bet the side with a
 * positive edge. Our completed 440-bet analysis proved the durable edge is on
 * the LOW-SCORING side (games <=2 goals = +11% ROI; exactly 2 = +16.5%; 3+ is
 * catastrophic), so the analyzer favours "Under 2.5" and "No BTTS" picks and can
 * be gated to recommend ONLY the low-scoring side.
 *
 * Both BTTS and TOTAL for the same fixture are SEPARATE Kalshi events that
 * share a match key (date + team code, e.g. 26JUL31NYCTOR); the fetcher joins
 * them into one GoalsMatch.
 */

import { kalshiPublicFetch } from '@/lib/kalshi-api';
import { calibrateProb, hasProbCalibration, type CalibrationParams } from '@/lib/calibration';

// League code (the token between KX and BTTS/TOTAL) + display name. Series that
// aren't currently live simply return zero events and are skipped, so probing a
// broad list is safe and picks up new competitions automatically.
export const GOALS_LEAGUES = [
  // Each code must exist on Kalshi as both KX<code>BTTS and KX<code>TOTAL.
  // Verified against GET /series?category=Sports on 2026-11-10.
  { code: 'MLS', league: 'MLS' },
  { code: 'UCL', league: 'UEFA Champions League' },
  { code: 'UEL', league: 'UEFA Europa League' },
  { code: 'UECL', league: 'UEFA Conference League' },
  { code: 'UEFANL', league: 'UEFA Nations League' },
  { code: 'INTLFRIENDLY', league: 'International Friendly' },
  { code: 'EPL', league: 'English Premier League' },
  { code: 'LALIGA', league: 'La Liga' },
  { code: 'SERIEA', league: 'Serie A' },
  { code: 'BUNDESLIGA', league: 'Bundesliga' },
  { code: 'LIGUE1', league: 'Ligue 1' },
  { code: 'EREDIVISIE', league: 'Eredivisie' },
  { code: 'LIGAPORTUGAL', league: 'Primeira Liga' },
  { code: 'EFLCHAMPIONSHIP', league: 'EFL Championship' },
  { code: 'SCOTTISHPREM', league: 'Scottish Premiership' },
  { code: 'BELGIANPL', league: 'Belgian Pro League' },
  { code: 'SUPERLIG', league: 'Turkish Süper Lig' },
  { code: 'SAUDIPL', league: 'Saudi Pro League' },
  { code: 'FACUP', league: 'FA Cup' },
  { code: 'EFLCUP', league: 'EFL Cup' },
  { code: 'COPADELREY', league: 'Copa del Rey' },
  { code: 'DFBPOKAL', league: 'DFB-Pokal' },
  { code: 'COPPAITALIA', league: 'Coppa Italia' },
  { code: 'COUPEDEFRANCE', league: 'Coupe de France' },
  { code: 'LIGAMX', league: 'Liga MX' },
  { code: 'BRASILEIRO', league: 'Brasileirão' },
  { code: 'CONMEBOLLIB', league: 'Copa Libertadores' },
  { code: 'CONCACAFCCUP', league: 'CONCACAF Champions Cup' },
  { code: 'LEAGUESCUP', league: 'Leagues Cup' },
  { code: 'USOPENCUP', league: 'US Open Cup' },
  { code: 'NWSL', league: 'NWSL' },
  { code: 'ALEAGUE', league: 'A-League' },
  { code: 'JLEAGUE', league: 'J1 League' },
  { code: 'WC', league: 'FIFA World Cup' },
  { code: 'CLUBWC', league: 'Club World Cup' },
] as const;

export interface BttsMarket {
  ticker: string;    // full market ticker (..-BTTS)
  yesAsk: number;    // cents to buy YES (Both teams score)
  yesBid: number;    // cents (bid)
  last: number;
}

export interface TotalLine {
  ticker: string;    // full market ticker (..-3)
  line: number;      // over line, e.g. 2.5
  yesAsk: number;    // cents to buy YES = "Over <line>"
  yesBid: number;
  last: number;
}

export interface GoalsMatch {
  matchKey: string;       // league code + date/team suffix, e.g. "MLS::26JUL31NYCTOR" (Kalshi) or the Polymarket event slug
  source?: 'kalshi' | 'polymarket'; // data source (defaults to kalshi when omitted)
  league: string;
  leagueCode: string;
  teamA: string;
  teamB: string;
  matchTitle: string;     // "New York City vs Toronto"
  matchDate: string;      // YYYY-MM-DD
  expirationTime: string;
  bttsEventTicker?: string;
  bttsSeriesTicker?: string;
  btts?: BttsMarket;
  totalEventTicker?: string;
  totalSeriesTicker?: string;
  totalLadder: TotalLine[]; // sorted ascending by line
}

export type PickSide = 'under' | 'over' | 'btts_no' | 'btts_yes';

export interface GoalsPick {
  marketType: 'total' | 'btts';
  line?: number;              // for totals
  side: PickSide;
  label: string;              // "Under 2.5 Goals" / "No BTTS" / ...
  isLowScoring: boolean;      // true for under / no-btts
  marketTicker: string;
  seriesTicker: string;
  eventTicker: string;
  cost: number;               // cents to enter this side (ask of the side)
  bid: number;                // cents on the other direction (for reference)
  impliedProb: number;        // cost/100 (market implied, includes vig)
  modelProb?: number;         // CALIBRATED model probability (0-1) of THIS side winning
  rawModelProb?: number;      // model probability before the reliability curve
  edge?: number;              // modelProb*100 - cost (cents/unit) when model available
}

export interface GoalsAnalysis {
  match: GoalsMatch;
  picks: GoalsPick[];          // all candidate picks (both sides of each market)
  recommended: GoalsPick | null;
  bestEdge: number;            // best edge among candidate picks (cents/unit)
  bestOverall: GoalsPick | null; // best +EV pick across ALL sides (ignores low-scoring filter)
  edgeThreshold: number;
  lowScore?: number;
  expectedTotalGoals?: number;
  gateReason: string | null;
  rating: 'excellent' | 'good' | 'marginal' | 'none';
  researched: boolean;
  calibrated: boolean;         // true when probabilities went through the learned reliability curve
}

function parseDollarsToCents(val: any): number {
  if (val == null) return 0;
  const parsed = parseFloat(String(val));
  return isNaN(parsed) ? 0 : Math.round(parsed * 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Extract match date from event ticker e.g. KXMLSTOTAL-26JUL31NYCTOR -> 2026-07-31 */
function extractMatchDate(eventTicker: string): string {
  const m = eventTicker.match(/(\d{2})([A-Z]{3})(\d{2})[A-Z]/);
  if (!m) return '';
  const mm: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
  };
  return `20${m[1]}-${mm[m[2]] ?? '01'}-${m[3]}`;
}

/** The suffix after the series ticker, e.g. KXMLSTOTAL-26JUL31NYCTOR -> 26JUL31NYCTOR */
function eventSuffix(eventTicker: string): string {
  const idx = eventTicker.indexOf('-');
  return idx >= 0 ? eventTicker.slice(idx + 1) : eventTicker;
}

/** Parse teams from an event title like "New York City vs Toronto: BTTS". */
function parseTeams(title: string): { teamA: string; teamB: string } {
  const beforeColon = (title ?? '').split(':')[0] ?? '';
  const parts = beforeColon.split(/\s+vs\.?\s+/i);
  return {
    teamA: (parts[0] ?? '').trim() || 'Team A',
    teamB: (parts[1] ?? '').trim() || 'Team B',
  };
}

/** Parse the over-line (e.g. 2.5) out of a totals sub-title "Over 2.5 goals scored". */
function parseOverLine(subTitle: string): number | null {
  const m = (subTitle ?? '').match(/over\s+([\d.]+)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return isFinite(v) ? v : null;
}

interface RawEvent {
  eventTicker: string;
  seriesTicker: string;
  title: string;
  markets: any[];
}

/** Fetch open events for one series ticker (BTTS or TOTAL). */
async function fetchSeriesEvents(seriesTicker: string, environment: string): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  const fetchPage = async (cursorParam: string): Promise<any> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await kalshiPublicFetch(
          `/events?series_ticker=${seriesTicker}&status=open&limit=50&with_nested_markets=true${cursorParam}`,
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
        out.push({
          eventTicker: event?.event_ticker ?? '',
          seriesTicker,
          title: event?.title ?? '',
          markets: event?.markets ?? [],
        });
      }
      cursor = result?.cursor ?? null;
      hasMore = !!cursor && events.length > 0;
      if (hasMore) await sleep(200);
    }
  } catch (err: any) {
    if (err?.message?.includes?.('429')) await sleep(2000);
    // otherwise: series not live / not found — silently skip
  }
  return out;
}

function buildBttsMarket(ev: RawEvent): BttsMarket | undefined {
  const mk = (ev.markets ?? []).find((m: any) =>
    String(m?.ticker ?? '').toUpperCase().endsWith('-BTTS')
  ) ?? (ev.markets ?? [])[0];
  if (!mk) return undefined;
  const yesAsk = parseDollarsToCents(mk?.yes_ask_dollars);
  const yesBid = parseDollarsToCents(mk?.yes_bid_dollars);
  if (yesAsk <= 0 || yesAsk >= 100) return undefined;
  return {
    ticker: mk?.ticker ?? '',
    yesAsk,
    yesBid,
    last: parseDollarsToCents(mk?.last_price_dollars),
  };
}

function buildTotalLadder(ev: RawEvent): TotalLine[] {
  const ladder: TotalLine[] = [];
  for (const mk of ev.markets ?? []) {
    const line = parseOverLine(mk?.yes_sub_title ?? '');
    if (line == null) continue;
    const yesAsk = parseDollarsToCents(mk?.yes_ask_dollars);
    const yesBid = parseDollarsToCents(mk?.yes_bid_dollars);
    if (yesAsk <= 0 || yesAsk >= 100) continue;
    ladder.push({
      ticker: mk?.ticker ?? '',
      line,
      yesAsk,
      yesBid,
      last: parseDollarsToCents(mk?.last_price_dollars),
    });
  }
  ladder.sort((a, b) => a.line - b.line);
  return ladder;
}

/**
 * Fetch all open BTTS + Total goals matches from Kalshi and join them by match.
 */
export async function fetchGoalsMatches(environment: string = 'production'): Promise<GoalsMatch[]> {
  const byKey = new Map<string, GoalsMatch>();

  const BATCH_SIZE = 3;
  for (let i = 0; i < GOALS_LEAGUES.length; i += BATCH_SIZE) {
    const batch = GOALS_LEAGUES.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.flatMap(lg => [
        fetchSeriesEvents(`KX${lg.code}BTTS`, environment).then(evs => ({ lg, kind: 'btts' as const, evs })),
        fetchSeriesEvents(`KX${lg.code}TOTAL`, environment).then(evs => ({ lg, kind: 'total' as const, evs })),
      ])
    );

    for (const { lg, kind, evs } of results) {
      for (const ev of evs) {
        if (!ev.eventTicker) continue;
        const suffix = eventSuffix(ev.eventTicker);
        const key = `${lg.code}::${suffix}`;
        const { teamA, teamB } = parseTeams(ev.title);

        let gm = byKey.get(key);
        if (!gm) {
          gm = {
            matchKey: key,
            source: 'kalshi',
            league: lg.league,
            leagueCode: lg.code,
            teamA,
            teamB,
            matchTitle: `${teamA} vs ${teamB}`,
            matchDate: extractMatchDate(ev.eventTicker),
            expirationTime: (ev.markets?.[0]?.expiration_time) ?? '',
            totalLadder: [],
          };
          byKey.set(key, gm);
        }

        if (kind === 'btts') {
          const btts = buildBttsMarket(ev);
          if (btts) {
            gm.btts = btts;
            gm.bttsEventTicker = ev.eventTicker;
            gm.bttsSeriesTicker = ev.seriesTicker;
          }
        } else {
          const ladder = buildTotalLadder(ev);
          if (ladder.length > 0) {
            gm.totalLadder = ladder;
            gm.totalEventTicker = ev.eventTicker;
            gm.totalSeriesTicker = ev.seriesTicker;
          }
        }
      }
    }
    if (i + BATCH_SIZE < GOALS_LEAGUES.length) await sleep(400);
  }

  // Keep only matches that expose at least one tradeable market.
  const matches = [...byKey.values()].filter(m => m.btts || m.totalLadder.length > 0);
  if (matches.length > 0) console.log(`[GoalsMarkets] ${matches.length} matches with goals markets`);
  return matches;
}

/** Fetch a single match by league code + suffix (used by the research endpoint). */
export async function fetchGoalsMatchByKey(
  matchKey: string,
  environment: string = 'production'
): Promise<GoalsMatch | null> {
  const [code, suffix] = matchKey.split('::');
  if (!code || !suffix) return null;
  const lg = GOALS_LEAGUES.find(l => l.code === code);
  const league = lg?.league ?? 'Soccer';

  const [bttsEvs, totalEvs] = await Promise.all([
    fetchSeriesEvents(`KX${code}BTTS`, environment),
    fetchSeriesEvents(`KX${code}TOTAL`, environment),
  ]);
  const bttsEv = bttsEvs.find(e => eventSuffix(e.eventTicker) === suffix);
  const totalEv = totalEvs.find(e => eventSuffix(e.eventTicker) === suffix);
  if (!bttsEv && !totalEv) return null;

  const srcTitle = totalEv?.title ?? bttsEv?.title ?? '';
  const srcEvent = totalEv?.eventTicker ?? bttsEv?.eventTicker ?? '';
  const { teamA, teamB } = parseTeams(srcTitle);

  const gm: GoalsMatch = {
    matchKey,
    source: 'kalshi',
    league,
    leagueCode: code,
    teamA,
    teamB,
    matchTitle: `${teamA} vs ${teamB}`,
    matchDate: extractMatchDate(srcEvent),
    expirationTime: (totalEv?.markets?.[0]?.expiration_time) ?? (bttsEv?.markets?.[0]?.expiration_time) ?? '',
    totalLadder: [],
  };
  if (bttsEv) {
    const btts = buildBttsMarket(bttsEv);
    if (btts) { gm.btts = btts; gm.bttsEventTicker = bttsEv.eventTicker; gm.bttsSeriesTicker = bttsEv.seriesTicker; }
  }
  if (totalEv) {
    const ladder = buildTotalLadder(totalEv);
    if (ladder.length > 0) { gm.totalLadder = ladder; gm.totalEventTicker = totalEv.eventTicker; gm.totalSeriesTicker = totalEv.seriesTicker; }
  }
  return (gm.btts || gm.totalLadder.length > 0) ? gm : null;
}

// ─────────────────────── analysis ───────────────────────

/**
 * Build candidate picks for a match. Each binary market yields two candidate
 * sides (yes/no). When model probabilities are supplied (via research), each
 * pick gets an edge = modelProb*100 - cost. The recommended pick is the highest
 * positive-edge pick, optionally restricted to the low-scoring side.
 *
 * Model probabilities (0-1 of the YES event happening) are supplied per market:
 *   - bttsYesProb: P(both teams score)
 *   - overProbByLine: map line -> P(total goals > line)
 */
export function analyzeGoals(
  match: GoalsMatch,
  opts: {
    minEdge?: number;
    lowScoringOnly?: boolean;
    minLowScore?: number;
    lowScore?: number;
    expectedTotalGoals?: number;
    bttsYesProb?: number;
    overProbByLine?: Record<string, number>;
    slippageCents?: number;
    minProb?: number;
    calibration?: CalibrationParams | null;
  } = {}
): GoalsAnalysis {
  const minEdge = opts.minEdge ?? 3;
  const lowScoringOnly = opts.lowScoringOnly ?? true;
  const minLowScore = opts.minLowScore ?? 0;
  const slippage = opts.slippageCents ?? 1;
  // Win-probability floor for a RECOMMENDATION. A positive cent-edge on an
  // extreme longshot line (e.g. Over 5.5 / Under 0.5) is usually a spread
  // artifact, and betting a ~5-10% shot flatly contradicts a ~2.5-goal
  // projection. We never recommend a single-leg side below this hit chance.
  const minProb = opts.minProb ?? 0.35;
  const researched = typeof opts.bttsYesProb === 'number' || !!opts.overProbByLine;

  // The model has historically overstated its confidence, so every stated
  // probability is mapped through the learned reliability curve BEFORE it is
  // turned into an edge. This is what keeps EV honest — an uncalibrated 84%
  // claim that realizes at 71% manufactures edge that does not exist.
  const cal = opts.calibration ?? null;
  const calibrated = hasProbCalibration(cal);
  const cp = (p: number | undefined): number | undefined =>
    typeof p === 'number' && isFinite(p) ? calibrateProb(p, cal) : undefined;

  const picks: GoalsPick[] = [];

  // ── Totals: focus on the 2.5 line (the analysis sweet spot) but include any line present ──
  for (const tl of match.totalLadder) {
    const overCost = Math.min(tl.yesAsk + slippage, 99);      // buy YES = Over
    const underCost = Math.min(100 - tl.yesBid + slippage, 99); // buy NO = Under
    const overRaw = opts.overProbByLine?.[String(tl.line)];
    const underRaw = typeof overRaw === 'number' ? 1 - overRaw : undefined;
    const overModel = cp(overRaw);
    const underModel = cp(underRaw);

    // Over (higher-scoring)
    picks.push({
      marketType: 'total', line: tl.line, side: 'over',
      label: `Over ${tl.line} Goals`, isLowScoring: false,
      marketTicker: tl.ticker, seriesTicker: match.totalSeriesTicker ?? '', eventTicker: match.totalEventTicker ?? '',
      cost: overCost, bid: tl.yesBid, impliedProb: overCost / 100,
      modelProb: overModel, rawModelProb: overRaw,
      edge: typeof overModel === 'number' ? Math.round((overModel * 100 - overCost) * 100) / 100 : undefined,
    });
    // Under — only genuinely low-scoring lines (Under 2.5 and below) get the
    // proven edge-side treatment. Under 3.5+ (which includes 3-goal games, a
    // historically losing bucket) is judged on raw model edge only.
    picks.push({
      marketType: 'total', line: tl.line, side: 'under',
      label: `Under ${tl.line} Goals`, isLowScoring: tl.line <= 2.5,
      marketTicker: tl.ticker, seriesTicker: match.totalSeriesTicker ?? '', eventTicker: match.totalEventTicker ?? '',
      cost: underCost, bid: 100 - tl.yesAsk, impliedProb: underCost / 100,
      modelProb: underModel, rawModelProb: underRaw,
      edge: typeof underModel === 'number' ? Math.round((underModel * 100 - underCost) * 100) / 100 : undefined,
    });
  }

  // ── BTTS ──
  if (match.btts) {
    const b = match.btts;
    const yesCost = Math.min(b.yesAsk + slippage, 99);      // buy YES = both score
    const noCost = Math.min(100 - b.yesBid + slippage, 99); // buy NO = not both score
    const yesRaw = opts.bttsYesProb;
    const noRaw = typeof yesRaw === 'number' ? 1 - yesRaw : undefined;
    const yesModel = cp(yesRaw);
    const noModel = cp(noRaw);

    picks.push({
      marketType: 'btts', side: 'btts_yes',
      label: 'BTTS — Yes', isLowScoring: false,
      marketTicker: b.ticker, seriesTicker: match.bttsSeriesTicker ?? '', eventTicker: match.bttsEventTicker ?? '',
      cost: yesCost, bid: b.yesBid, impliedProb: yesCost / 100,
      modelProb: yesModel, rawModelProb: yesRaw,
      edge: typeof yesModel === 'number' ? Math.round((yesModel * 100 - yesCost) * 100) / 100 : undefined,
    });
    picks.push({
      marketType: 'btts', side: 'btts_no',
      label: 'No BTTS', isLowScoring: true,
      marketTicker: b.ticker, seriesTicker: match.bttsSeriesTicker ?? '', eventTicker: match.bttsEventTicker ?? '',
      cost: noCost, bid: 100 - b.yesAsk, impliedProb: noCost / 100,
      modelProb: noModel, rawModelProb: noRaw,
      edge: typeof noModel === 'number' ? Math.round((noModel * 100 - noCost) * 100) / 100 : undefined,
    });
  }

  // Candidate pool for a recommendation.
  const pool = lowScoringOnly ? picks.filter(p => p.isLowScoring) : picks;

  // Best edge among candidates with a model probability (for the bestEdge
  // display — not gated by the probability floor).
  let best: GoalsPick | null = null;
  for (const p of pool) {
    if (typeof p.edge !== 'number') continue;
    if (!best || (p.edge ?? -999) > (best.edge ?? -999)) best = p;
  }
  const bestEdge = best?.edge ?? 0;

  // Best edge among candidates that ALSO clear the win-probability floor — this
  // is what actually becomes the recommendation, so longshots are excluded.
  let bestReco: GoalsPick | null = null;
  for (const p of pool) {
    if (typeof p.edge !== 'number') continue;
    if (typeof p.modelProb !== 'number' || p.modelProb < minProb) continue;
    if (!bestReco || (p.edge ?? -999) > (bestReco.edge ?? -999)) bestReco = p;
  }

  // Best +EV pick across ALL sides (ignores the low-scoring filter) so the UI
  // can surface a strong Over / BTTS-Yes even when low-scoring-only is on.
  // Also gated by the probability floor so we never surface a longshot Over.
  let bestOverall: GoalsPick | null = null;
  for (const p of picks) {
    if (typeof p.edge !== 'number') continue;
    if (typeof p.modelProb !== 'number' || p.modelProb < minProb) continue;
    if (!bestOverall || (p.edge ?? -999) > (bestOverall.edge ?? -999)) bestOverall = p;
  }

  let recommended: GoalsPick | null = null;
  let gateReason: string | null = null;
  if (!researched) {
    gateReason = 'Run Research to price a model edge before recommending a side.';
  } else if (!best) {
    gateReason = 'No priced market available for a recommendation.';
  } else {
    const lowBlocked = minLowScore > 0 && typeof opts.lowScore === 'number' && opts.lowScore < minLowScore;
    const bestIsLongshot = (best.edge ?? -999) >= minEdge
      && (typeof best.modelProb !== 'number' || best.modelProb < minProb);
    if ((bestReco?.edge ?? -999) < minEdge) {
      if (bestIsLongshot) {
        // The only +edge side is a low-probability longshot — skip it.
        gateReason = `Best +EV side (${best.label}) is a longshot at ~${Math.round((best.modelProb ?? 0) * 100)}% model win chance — skipped as a high-variance, low-probability bet that contradicts the projected scoreline.`;
      } else {
        gateReason = `No side clears the +${minEdge.toFixed(1)}¢ edge threshold (best modelled edge ${bestEdge.toFixed(1)}¢).`;
      }
    } else if (lowBlocked) {
      gateReason = `Low-scoring signal ${opts.lowScore}/100 is below your ${minLowScore} threshold — the model projects a higher-scoring game.`;
    } else {
      recommended = bestReco;
    }
  }

  let rating: GoalsAnalysis['rating'] = 'none';
  if (recommended) {
    const e = recommended.edge ?? 0;
    if (e >= 8) rating = 'excellent';
    else if (e >= 5) rating = 'good';
    else rating = 'marginal';
  }

  return {
    match,
    picks,
    recommended,
    bestEdge,
    bestOverall,
    edgeThreshold: minEdge,
    lowScore: opts.lowScore,
    expectedTotalGoals: opts.expectedTotalGoals,
    gateReason,
    rating,
    researched,
    calibrated,
  };
}

/** Uniform contract allocation for a single-leg goals bet. */
export function calculateGoalsStake(
  costCents: number,
  totalStakeDollars: number
): { contracts: number; totalCostCents: number; expectedPayoutCents: number; profitIfWinCents: number } {
  const totalStakeCents = Math.round(totalStakeDollars * 100);
  if (costCents <= 0 || costCents >= 100) {
    return { contracts: 0, totalCostCents: 0, expectedPayoutCents: 0, profitIfWinCents: 0 };
  }
  const contracts = Math.max(1, Math.floor(totalStakeCents / costCents));
  const totalCostCents = contracts * costCents;
  const expectedPayoutCents = contracts * 100;
  return { contracts, totalCostCents, expectedPayoutCents, profitIfWinCents: expectedPayoutCents - totalCostCents };
}

/**
 * Price a SINGLE market side from a (freshly-fetched) match, using the exact
 * same cost formula as analyzeGoals. Returns the current cost in cents to buy
 * that side (ask + slippage, capped at 99), or null when the market is not
 * currently tradeable (missing / no live quote). Used at place time to re-price
 * a bet against the live market instead of a stale, earlier-fetched price.
 *
 *   marketType 'btts'  + side 'yes' -> Both Teams To Score YES
 *   marketType 'btts'  + side 'no'  -> No BTTS
 *   marketType 'total' + side 'yes' -> Over  <line>
 *   marketType 'total' + side 'no'  -> Under <line>
 */
export function priceGoalsSide(
  match: GoalsMatch,
  marketType: 'btts' | 'total',
  line: number | null | undefined,
  side: 'yes' | 'no',
  slippageCents = 1,
): number | null {
  const slip = slippageCents;
  const tradeable = (n: number) => (isFinite(n) && n > 0 && n < 100 ? n : null);
  if (marketType === 'btts') {
    const b = match.btts;
    if (!b) return null;
    return side === 'yes'
      ? tradeable(Math.min(b.yesAsk + slip, 99))
      : tradeable(Math.min(100 - b.yesBid + slip, 99));
  }
  const tl = match.totalLadder.find(t => t.line === line);
  if (!tl) return null;
  return side === 'yes'
    ? tradeable(Math.min(tl.yesAsk + slip, 99))     // Over = buy YES
    : tradeable(Math.min(100 - tl.yesBid + slip, 99)); // Under = buy NO
}

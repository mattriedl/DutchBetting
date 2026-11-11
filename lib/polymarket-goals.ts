/**
 * Polymarket Goals Markets Library
 *
 * Mirrors lib/goals-markets.ts (Kalshi) but sources BTTS + Over/Under totals
 * from Polymarket's public Gamma API. On Polymarket these markets live under an
 * event slug of the form "<sport>-<home>-<away>-<date>-more-markets" alongside
 * many other props (spreads, team totals, first/second-half lines).
 *
 * We extract ONLY the full-match markets that map onto our proven directional
 * value edge:
 *   - Totals:  question "TeamA vs. TeamB: O/U 2.5"  (slug ...-total-2pt5)
 *   - BTTS:    question "TeamA vs. TeamB: Both Teams to Score" (slug ...-btts)
 *
 * Unlike Kalshi (where Under is the NO-side of a single Over market), Polymarket
 * exposes Over and Under as two separate tokens. To reuse analyzeGoals()
 * unchanged we set yesAsk = yesBid = the Over/Yes mid price (from outcomePrices),
 * so analyzeGoals derives overCost = mid + slippage and underCost = 100 - mid +
 * slippage. Using the outcomePrices mid (rather than the wide, illiquid
 * bestAsk/bestBid book) avoids injecting fake vig from thin order books.
 *
 * All money values are normalized to CENTS (integers) to match the rest of the
 * codebase.
 */

import type { GoalsMatch, BttsMarket, TotalLine } from '@/lib/goals-markets';

const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const SOCCER_TAG_ID = 100639; // Gamma "Soccer" tag

// Map a Polymarket sport / series code to a friendly league label. Anything not
// listed falls back to a cleaned-up version of the code so new competitions
// still show a sensible name.
const LEAGUE_LABELS: Record<string, string> = {
  mls: 'MLS',
  epl: 'English Premier League',
  ucl: 'UEFA Champions League',
  uel: 'UEFA Europa League',
  uecl: 'UEFA Conference League',
  laliga: 'La Liga',
  seriea: 'Serie A',
  bundesliga: 'Bundesliga',
  ligue1: 'Ligue 1',
  eredivisie: 'Eredivisie',
  primeira: 'Primeira Liga',
  championship: 'EFL Championship',
  ligamx: 'Liga MX',
  brasileirao: 'Brasileirão',
  bra1: 'Brasileirão',
  lib: 'Copa Libertadores',
  libertadores: 'Copa Libertadores',
  sudamericana: 'Copa Sudamericana',
  leaguescup: 'Leagues Cup',
  nwsl: 'NWSL',
  wc: 'FIFA World Cup',
  clubwc: 'Club World Cup',
  euro: 'UEFA Euro',
  copa: 'Copa América',
  nations: 'UEFA Nations League',
  auc: 'Australia Cup',
  aleague: 'A-League',
  bol1: 'Bolivia Primera',
  nor: 'Norway Eliteserien',
  per1: 'Peru Liga 1',
  ven1: 'Venezuela Primera',
  col1: 'Colombia Primera A',
  col2: 'Colombia Primera B',
  arg1: 'Argentina Primera',
  chi1: 'Chile Primera',
  ecu1: 'Ecuador Serie A',
  par1: 'Paraguay Primera',
  uru1: 'Uruguay Primera',
  usl: 'USL Championship',
  mxliga: 'Liga MX',
  jleague: 'J1 League',
  kleague: 'K League',
};

function leagueLabel(sport: string, seriesSlug: string): string {
  const key = (sport || '').toLowerCase();
  if (LEAGUE_LABELS[key]) return LEAGUE_LABELS[key];
  const sKey = (seriesSlug || '').replace(/^soccer-/, '').replace(/-games$/, '').replace(/-\d{4}$/, '').toLowerCase();
  if (LEAGUE_LABELS[sKey]) return LEAGUE_LABELS[sKey];
  // Fallback: title-case the series slug (e.g. "liga-1" -> "Liga 1").
  const src = sKey || key;
  if (!src) return 'Soccer';
  return src.split(/[-_]/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

function dollarsToCents(val: any): number {
  if (val == null) return 0;
  const n = parseFloat(String(val));
  return isNaN(n) ? 0 : Math.round(n * 100);
}

function safeJsonArray(val: any): any[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const p = JSON.parse(val);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function gammaFetch(path: string): Promise<any> {
  const res = await fetch(`${GAMMA_HOST}${path}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Gamma ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return res.json();
}

function polyKickoffIso(v: any): string {
  // gameStartTime looks like "2026-11-12 17:30:00+00"
  const t = Date.parse(String(v ?? '').replace(' ', 'T').replace(/\+00$/, 'Z'));
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

/** Extract YYYY-MM-DD from an event slug like "mls-nyc-tor-2026-07-31-more-markets". */
function extractDateFromSlug(slug: string): string {
  const m = (slug ?? '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/** Parse "TeamA vs. TeamB - More Markets" (or the market question prefix) into teams. */
function parseTeams(title: string): { teamA: string; teamB: string } {
  let base = (title ?? '').replace(/\s*-\s*More Markets\s*$/i, '');
  base = base.split(':')[0];
  const parts = base.split(/\s+vs\.?\s+/i);
  return {
    teamA: (parts[0] ?? '').trim() || 'Team A',
    teamB: (parts[1] ?? '').trim() || 'Team B',
  };
}

/**
 * Full-match totals question: "TeamA vs. TeamB: O/U 2.5".
 * Excludes "1st Half O/U", "2nd Half O/U" and team totals ("TeamA O/U") because
 * those have extra text between the colon and "O/U".
 */
function parseFullMatchOverLine(question: string): number | null {
  const m = (question ?? '').match(/:\s*O\/U\s+([\d.]+)\s*$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return isFinite(v) ? v : null;
}

/** Full-match BTTS question ends exactly with ": Both Teams to Score". */
function isFullMatchBtts(question: string): boolean {
  return /:\s*Both Teams to Score\s*$/i.test(question ?? '');
}

/** Mid price (cents) of the first outcome (Over / Yes) from outcomePrices. */
function firstOutcomeMidCents(mk: any): number {
  const prices = safeJsonArray(mk?.outcomePrices);
  const p0 = prices.length >= 1 ? parseFloat(String(prices[0])) : NaN;
  const p1 = prices.length >= 2 ? parseFloat(String(prices[1])) : NaN;

  // Polymarket reports outcomePrices ["0.5","0.5"] as a DEFAULT for markets that
  // have never traded, even when the real order book is very wide (e.g. bid 0.03 /
  // ask 0.97). Trusting that 0.5 mid makes a near-certain line look like a coin
  // flip, producing a falsely "generous" price and phantom edge. Never use it.
  const isUntradedDefault =
    isFinite(p0) && isFinite(p1) &&
    Math.abs(p0 - 0.5) < 1e-6 && Math.abs(p1 - 0.5) < 1e-6;

  // The mid is only meaningful on a real two-sided book. Polymarket also reports a midpoint for
  // ONE-sided or very wide books (e.g. O/U 8.5 with no bid and a 63c ask shows 0.315/0.685), which
  // priced "Under 8.5" at 69c when nobody would actually sell it there — phantom 12-16c edges that
  // the AI tracker kept picking. When Gamma gives book fields, require both sides and a tight spread.
  if ('bestBid' in (mk ?? {}) || 'bestAsk' in (mk ?? {})) {
    const bb = dollarsToCents(mk?.bestBid);
    const ba = dollarsToCents(mk?.bestAsk);
    if (!(bb > 0 && ba > 0 && ba < 100 && ba - bb <= 10)) return 0;
  }

  if (!isUntradedDefault && isFinite(p0) && p0 > 0 && p0 < 1) {
    return Math.round(p0 * 100);
  }

  // For an untraded default (or missing outcomePrices) fall back only to a REAL
  // signal: a genuine last trade, or a TIGHT book midpoint (spread <= 10c). A wide
  // book means there is no reliable price -> return 0 so the market is skipped.
  const last = dollarsToCents(mk?.lastTradePrice);
  if (last > 0 && last < 100) return last;
  const ask = dollarsToCents(mk?.bestAsk);
  const bid = dollarsToCents(mk?.bestBid);
  if (ask > 0 && bid > 0 && ask - bid <= 10) return Math.round((ask + bid) / 2);
  return 0;
}

function isMarketTradeable(mk: any, eventClosed: boolean): boolean {
  if (eventClosed) return false;
  if (mk?.closed === true) return false;
  if (mk?.acceptingOrders === false) return false;
  return true;
}

/** Build a GoalsMatch from one Gamma "-more-markets" event, or null if it has no full-match goals markets. */
function buildGoalsMatchFromEvent(ev: any): GoalsMatch | null {
  const slug: string = ev?.slug ?? '';
  if (!slug.endsWith('-more-markets')) return null;
  const eventClosed = ev?.closed === true;

  const sportObj = ev?.sport ?? {};
  const sport = String((sportObj && sportObj.sport) ?? ev?.sport ?? '').toLowerCase();
  const seriesSlug = String(ev?.seriesSlug ?? ev?.series?.[0]?.slug ?? '');
  const league = leagueLabel(sport, seriesSlug);

  const rawMarkets: any[] = ev?.markets ?? [];

  // Totals ladder (full match only).
  const ladder: TotalLine[] = [];
  let btts: BttsMarket | undefined;
  let sampleQuestion = '';

  for (const mk of rawMarkets) {
    const question = String(mk?.question ?? '');
    if (!isMarketTradeable(mk, eventClosed)) continue;

    const line = parseFullMatchOverLine(question);
    if (line != null) {
      const mid = firstOutcomeMidCents(mk);
      if (mid > 0 && mid < 100) {
        if (!sampleQuestion) sampleQuestion = question;
        ladder.push({
          ticker: String(mk?.slug ?? ''),
          line,
          yesAsk: mid,
          yesBid: mid,
          last: dollarsToCents(mk?.lastTradePrice),
        });
      }
      continue;
    }

    if (isFullMatchBtts(question)) {
      const mid = firstOutcomeMidCents(mk);
      if (mid > 0 && mid < 100) {
        if (!sampleQuestion) sampleQuestion = question;
        btts = {
          ticker: String(mk?.slug ?? ''),
          yesAsk: mid,
          yesBid: mid,
          last: dollarsToCents(mk?.lastTradePrice),
        };
      }
    }
  }

  ladder.sort((a, b) => a.line - b.line);
  if (!btts && ladder.length === 0) return null;

  const { teamA, teamB } = parseTeams(ev?.title || sampleQuestion);
  // Polymarket's eventDate/startTime follow reschedules; the slug keeps the original date
  // (e.g. cdr-csp-alb-2026-10-28 was moved to 2026-11-12).
  const evDate = String(ev?.eventDate ?? ev?.startTime ?? '').slice(0, 10);
  const matchDate = /^\d{4}-\d{2}-\d{2}$/.test(evDate) ? evDate : extractDateFromSlug(slug);

  const gm: GoalsMatch = {
    matchKey: slug, // Polymarket event slug (unique, no "::")
    league,
    leagueCode: sport.toUpperCase() || 'SOCCER',
    teamA,
    teamB,
    matchTitle: `${teamA} vs ${teamB}`,
    matchDate,
    expirationTime: ev?.endDate ?? '',
    // Exact kick-off (follows reschedules); the first market's gameStartTime is the fallback.
    bettableUntil: polyKickoffIso(ev?.startTime ?? ev?.markets?.[0]?.gameStartTime),
    source: 'polymarket',
    totalLadder: ladder,
  };

  if (btts) {
    gm.btts = btts;
    gm.bttsEventTicker = slug;
    gm.bttsSeriesTicker = seriesSlug;
  }
  if (ladder.length > 0) {
    gm.totalEventTicker = slug;
    gm.totalSeriesTicker = seriesSlug;
  }

  return gm;
}

/**
 * List all currently-open soccer BTTS + Totals matches on Polymarket.
 * Pages through the Soccer tag and keeps only "-more-markets" events that expose
 * at least one full-match BTTS or Over/Under market.
 */
export async function fetchPolymarketGoalsMatches(): Promise<GoalsMatch[]> {
  const out: GoalsMatch[] = [];
  const seen = new Set<string>();
  const LIMIT = 100;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const dateFilter = `&end_date_min=${encodeURIComponent(nowIso)}&order=endDate&ascending=true`;

  for (let offset = 0; offset < 600; offset += LIMIT) {
    let batch: any[] = [];
    try {
      batch = await gammaFetch(
        `/events?tag_id=${SOCCER_TAG_ID}&related_tags=true&active=true&closed=false&limit=${LIMIT}&offset=${offset}${dateFilter}`
      );
    } catch (err: any) {
      console.log(`[PolyGoals] gamma events offset ${offset} error: ${err?.message}`);
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const ev of batch) {
      const slug = ev?.slug ?? '';
      if (!slug.endsWith('-more-markets') || seen.has(slug)) continue;
      const endMs = new Date(ev?.endDate ?? 0).getTime();
      if (endMs && endMs < nowMs) continue;
      const gm = buildGoalsMatchFromEvent(ev);
      if (gm) {
        seen.add(slug);
        out.push(gm);
      }
    }

    if (batch.length < LIMIT) break;
    await sleep(150);
  }

  if (out.length > 0) console.log(`[PolyGoals] ${out.length} Polymarket goals matches`);
  return out;
}

/** Fetch a single Polymarket goals match by its event slug (used by research/place). */
export async function fetchPolymarketGoalsMatchByKey(slug: string): Promise<GoalsMatch | null> {
  try {
    const arr = await gammaFetch(`/events?slug=${encodeURIComponent(slug)}`);
    const ev = Array.isArray(arr) ? arr[0] : arr;
    if (!ev) return null;
    return buildGoalsMatchFromEvent(ev);
  } catch (err: any) {
    console.log(`[PolyGoals] fetchPolymarketGoalsMatchByKey ${slug} error: ${err?.message}`);
    return null;
  }
}

export interface PolyGoalsResolution {
  marketSlug: string;
  resolved: boolean;
  yesWon: boolean; // first outcome (Over / BTTS-Yes) resolved true
}

/**
 * Fetch settlement outcomes for every full-match goals market in an event.
 * A market is resolved when it (or the event) is closed and its first-outcome
 * price is definitive (>=0.99 won / <=0.01 lost). Keyed by market slug.
 */
export async function fetchPolymarketGoalsResolutions(eventSlug: string): Promise<PolyGoalsResolution[]> {
  try {
    const arr = await gammaFetch(`/events?slug=${encodeURIComponent(eventSlug)}`);
    const ev = Array.isArray(arr) ? arr[0] : arr;
    const rawMarkets: any[] = ev?.markets ?? [];
    const eventClosed = ev?.closed === true;
    const out: PolyGoalsResolution[] = [];
    for (const mk of rawMarkets) {
      const marketSlug = String(mk?.slug ?? '');
      const question = String(mk?.question ?? '');
      const isTotal = parseFullMatchOverLine(question) != null;
      const isBtts = isFullMatchBtts(question);
      if (!isTotal && !isBtts) continue;
      const prices = safeJsonArray(mk?.outcomePrices);
      const closed = mk?.closed === true || eventClosed;
      const yesPrice = prices.length > 0 ? parseFloat(String(prices[0])) : NaN;
      const resolved = closed && !isNaN(yesPrice) && (yesPrice >= 0.99 || yesPrice <= 0.01);
      const yesWon = resolved && yesPrice >= 0.99;
      out.push({ marketSlug, resolved, yesWon });
    }
    return out;
  } catch (err: any) {
    console.log(`[PolyGoals] fetchPolymarketGoalsResolutions ${eventSlug} error: ${err?.message}`);
    return [];
  }
}

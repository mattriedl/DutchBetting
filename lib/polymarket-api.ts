/**
 * Polymarket International (CLOB) API helpers.
 *
 * Two surfaces are used:
 *  1. Gamma API (https://gamma-api.polymarket.com) - PUBLIC discovery of
 *     events/markets. No auth required. Used to list soccer exact-score events.
 *  2. CLOB API (https://clob.polymarket.com) - orderbook + trading. Requires
 *     L1 (wallet EIP-712 signature to derive creds) + L2 (HMAC) auth. Handled
 *     entirely by @polymarket/clob-client. SERVER-SIDE ONLY - never expose the
 *     private key to the browser.
 *
 * All money values returned by our helpers are normalized to CENTS (integers)
 * so they line up with the rest of the Dutch-betting codebase, even though
 * Polymarket natively quotes decimal dollars ("0.042" = 4.2c).
 */

import { ClobClient, Side, OrderType, SignatureTypeV2, AssetType } from '@polymarket/clob-client-v2';
import type { ApiKeyCreds } from '@polymarket/clob-client-v2';
import { ethers } from 'ethers';
import { polymarketFeeSpec, type FeeSpec } from '@/lib/trading-fees';

const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
const SOCCER_TAG_ID = 100639; // Gamma "Soccer" tag

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolyScoreMarket {
  conditionId: string;
  groupItemTitle: string;   // e.g. "Rochedale Rovers FC 1 - 0 SD Raiders FC"
  yesTokenId: string;
  noTokenId: string;
  yesAskCents: number;      // best ask for YES in cents (true cost to buy)
  yesBidCents: number;      // best bid for YES in cents
  lastCents: number;        // last trade price in cents
  tickSize: number;         // 0.001 or 0.01 (dollars)
  minOrderSize: number;     // minimum contracts per order (usually 5)
  fee: FeeSpec;             // this market's taker fee schedule (sports: 5%)
  acceptingOrders: boolean;
  negRisk: boolean;
  isAnyOther: boolean;      // true for the "Any Other Score" catch-all leg
}

export interface PolyExactScoreEvent {
  slug: string;
  title: string;            // e.g. "Rochedale Rovers FC vs. SD Raiders FC - Exact Score"
  eventId: string;
  seriesSlug: string;
  sport: string;            // e.g. "auc", "mls"
  league: string;           // human label derived from sport/series
  startDate: string;
  endDate: string;
  /** Kick-off date (YYYY-MM-DD) as Polymarket reports it; follows reschedules, unlike the slug. */
  eventDate: string;
  negRisk: boolean;
  negRiskMarketId: string;
  active: boolean;
  closed: boolean;
  markets: PolyScoreMarket[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Map a Polymarket sport/series code to a friendly league label. */
const LEAGUE_LABELS: Record<string, string> = {
  mls: 'MLS',
  epl: 'English Premier League',
  ucl: 'UEFA Champions League',
  laliga: 'La Liga',
  seriea: 'Serie A',
  bundesliga: 'Bundesliga',
  ligue1: 'Ligue 1',
  lib: 'Copa Libertadores',
  auc: 'Australia Cup',
  bol1: 'Bolivia Primera',
  nor: 'Norway Eliteserien',
};

function leagueLabel(sport: string, seriesSlug: string): string {
  const key = (sport || '').toLowerCase();
  if (LEAGUE_LABELS[key]) return LEAGUE_LABELS[key];
  const sKey = (seriesSlug || '').replace(/^soccer-/, '').toLowerCase();
  if (LEAGUE_LABELS[sKey]) return LEAGUE_LABELS[sKey];
  return 'Soccer';
}

/** Parse one Gamma market object into a PolyScoreMarket (or null). */
function parseMarket(mk: any): PolyScoreMarket | null {
  const conditionId: string = mk?.conditionId ?? '';
  const groupItemTitle: string = mk?.groupItemTitle ?? mk?.question ?? '';
  const tokenIds = safeJsonArray(mk?.clobTokenIds);
  if (tokenIds.length < 2) return null;

  const prices = safeJsonArray(mk?.outcomePrices); // ["0.042","0.958"] => [yes,no]
  const yesPrice = prices.length > 0 ? prices[0] : mk?.lastTradePrice;

  const bestAsk = mk?.bestAsk != null ? dollarsToCents(mk.bestAsk) : dollarsToCents(yesPrice);
  const bestBid = mk?.bestBid != null ? dollarsToCents(mk.bestBid) : 0;
  const last = dollarsToCents(mk?.lastTradePrice ?? yesPrice);

  const isAnyOther = /any other/i.test(groupItemTitle);

  return {
    conditionId,
    groupItemTitle,
    yesTokenId: String(tokenIds[0]),
    noTokenId: String(tokenIds[1]),
    yesAskCents: bestAsk,
    yesBidCents: bestBid,
    lastCents: last,
    tickSize: parseFloat(String(mk?.orderPriceMinTickSize ?? '0.01')) || 0.01,
    minOrderSize: parseInt(String(mk?.orderMinSize ?? '5'), 10) || 5,
    fee: polymarketFeeSpec(mk),
    acceptingOrders: mk?.acceptingOrders !== false,
    negRisk: mk?.negRisk === true,
    isAnyOther,
  };
}

/** Parse a Gamma event object into a PolyExactScoreEvent (or null). */
function parseEvent(ev: any): PolyExactScoreEvent | null {
  const slug: string = ev?.slug ?? '';
  if (!slug.endsWith('-exact-score')) return null;

  const rawMarkets = ev?.markets ?? [];
  const markets: PolyScoreMarket[] = [];
  for (const mk of rawMarkets) {
    const parsed = parseMarket(mk);
    if (parsed) markets.push(parsed);
  }
  if (markets.length < 3) return null;

  const sportObj = ev?.sport ?? {};
  const sport = String(sportObj?.sport ?? ev?.sport ?? '').toLowerCase();
  const seriesSlug = String(ev?.seriesSlug ?? ev?.series?.[0]?.slug ?? '');

  return {
    slug,
    title: ev?.title ?? '',
    eventId: String(ev?.id ?? ''),
    seriesSlug,
    sport,
    league: leagueLabel(sport, seriesSlug),
    startDate: ev?.startDate ?? '',
    endDate: ev?.endDate ?? '',
    eventDate: String(ev?.eventDate ?? ev?.startTime ?? '').slice(0, 10),
    negRisk: ev?.negRisk === true,
    negRiskMarketId: ev?.negRiskMarketID ?? ev?.negRiskMarketId ?? '',
    active: ev?.active !== false,
    closed: ev?.closed === true,
    markets,
  };
}

// ---------------------------------------------------------------------------
// Gamma public discovery
// ---------------------------------------------------------------------------

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

/**
 * List all currently-open soccer EXACT-SCORE events on Polymarket.
 * Pages through the Soccer tag and keeps only `-exact-score` event slugs.
 */
export async function fetchSoccerExactScoreEvents(): Promise<PolyExactScoreEvent[]> {
  const out: PolyExactScoreEvent[] = [];
  const seen = new Set<string>();
  const LIMIT = 100;
  const nowMs = Date.now();
  // Only events whose result is NOT yet determined (endDate in the future),
  // ordered by soonest end date first. Without this filter Gamma returns a
  // large backlog of already-ended events (still flagged active/!closed) that
  // crowd out the live/upcoming matches beyond the pagination window.
  const nowIso = new Date(nowMs).toISOString();
  const dateFilter = `&end_date_min=${encodeURIComponent(nowIso)}&order=endDate&ascending=true`;

  for (let offset = 0; offset < 600; offset += LIMIT) {
    let batch: any[] = [];
    try {
      batch = await gammaFetch(
        `/events?tag_id=${SOCCER_TAG_ID}&related_tags=true&active=true&closed=false&limit=${LIMIT}&offset=${offset}${dateFilter}`
      );
    } catch (err: any) {
      console.log(`[Polymarket] gamma events offset ${offset} error: ${err?.message}`);
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const ev of batch) {
      const slug = ev?.slug ?? '';
      if (!slug.endsWith('-exact-score') || seen.has(slug)) continue;
      // Defensive: skip anything that has already ended.
      const endMs = new Date(ev?.endDate ?? 0).getTime();
      if (endMs && endMs < nowMs) continue;
      const parsed = parseEvent(ev);
      if (parsed) {
        seen.add(slug);
        out.push(parsed);
      }
    }

    if (batch.length < LIMIT) break;
    await sleep(150);
  }

  console.log(`[Polymarket] found ${out.length} upcoming soccer exact-score events`);
  return out;
}

export interface PolyMarketResolution {
  yesTokenId: string;
  title: string;
  resolved: boolean;   // market has settled
  yesWon: boolean;     // the YES outcome (this exact score) resolved true
}

/**
 * Fetch settlement outcomes for every scoreline market in an exact-score event.
 * A market is resolved when it is closed and its YES outcome price is 1 (won)
 * or 0 (lost). Returns a map keyed by the YES clob token id.
 */
export async function fetchPolyResolutions(slug: string): Promise<PolyMarketResolution[]> {
  try {
    const arr = await gammaFetch(`/events?slug=${encodeURIComponent(slug)}`);
    const ev = Array.isArray(arr) ? arr[0] : arr;
    const rawMarkets = ev?.markets ?? [];
    const out: PolyMarketResolution[] = [];
    for (const mk of rawMarkets) {
      const tokenIds = safeJsonArray(mk?.clobTokenIds);
      if (tokenIds.length < 2) continue;
      const yesTokenId = String(tokenIds[0]);
      const prices = safeJsonArray(mk?.outcomePrices); // [yes, no]
      const closed = mk?.closed === true || ev?.closed === true;
      const yesPrice = prices.length > 0 ? parseFloat(String(prices[0])) : NaN;
      // Resolved markets report a definitive 0/1 outcome price.
      const resolved = closed && !isNaN(yesPrice) && (yesPrice >= 0.99 || yesPrice <= 0.01);
      const yesWon = resolved && yesPrice >= 0.99;
      out.push({
        yesTokenId,
        title: mk?.groupItemTitle ?? mk?.question ?? '',
        resolved,
        yesWon,
      });
    }
    return out;
  } catch (err: any) {
    console.log(`[Polymarket] fetchPolyResolutions ${slug} error: ${err?.message}`);
    return [];
  }
}

/** Fetch a single exact-score event by its slug. */
export async function fetchExactScoreEventBySlug(slug: string): Promise<PolyExactScoreEvent | null> {
  try {
    const arr = await gammaFetch(`/events?slug=${encodeURIComponent(slug)}`);
    const ev = Array.isArray(arr) ? arr[0] : arr;
    if (!ev) return null;
    return parseEvent(ev);
  } catch (err: any) {
    console.log(`[Polymarket] fetchExactScoreEventBySlug ${slug} error: ${err?.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLOB authenticated client (server-side only)
// ---------------------------------------------------------------------------

let _clientCache: { client: ClobClient; address: string; cacheKey: string } | null = null;

/**
 * Map old numeric signatureType to V2 enum.
 *   0 = EOA, 1 = POLY_PROXY, 2 = POLY_GNOSIS_SAFE, 3 = POLY_1271
 * Default is POLY_1271 (3) which works with Polymarket deposit wallets.
 */
function toSigTypeV2(n: number): SignatureTypeV2 {
  switch (n) {
    case 0: return SignatureTypeV2.EOA;
    case 1: return SignatureTypeV2.POLY_PROXY;
    case 2: return SignatureTypeV2.POLY_GNOSIS_SAFE;
    case 3: return SignatureTypeV2.POLY_1271;
    default: return SignatureTypeV2.POLY_1271;
  }
}

/**
 * Build (and cache) an authenticated CLOB V2 client from the server-side
 * wallet private key. Derives L2 API creds on first use.
 *
 * signatureType / funderAddress control WHERE the USDC funds live:
 *   0 = EOA (funds in the wallet itself)
 *   1 = email/Magic proxy wallet
 *   2 = Gnosis Safe proxy wallet
 *   3 = POLY_1271 (Polymarket deposit wallet) <- default & recommended
 * funderAddress defaults to the signing wallet address.
 */
export async function getClobClient(
  signatureType: number = 3,
  funderAddress?: string
): Promise<{ client: ClobClient; address: string }> {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) throw new Error('POLYMARKET_PRIVATE_KEY not configured');

  const wallet = new ethers.Wallet(pk);
  const address = await wallet.getAddress();
  const sigV2 = toSigTypeV2(signatureType);
  const funder = funderAddress || address;
  const cacheKey = `${sigV2}:${funder}`;

  // Reuse cached client when signature settings are unchanged.
  if (_clientCache && _clientCache.cacheKey === cacheKey) {
    return _clientCache;
  }

  // Step 1: bootstrap client to derive L2 API creds.
  const bootstrap = new ClobClient({
    host: CLOB_HOST,
    chain: POLYGON_CHAIN_ID as any,
    signer: wallet as any,
    signatureType: sigV2,
    funderAddress: funder,
  });
  const creds: ApiKeyCreds = await bootstrap.createOrDeriveApiKey();
  console.log(`[Polymarket] L2 creds derived, key prefix: ${creds?.key?.slice(0, 8)}`);

  // Step 2: authenticated client used for orderbook reads + trading.
  const client = new ClobClient({
    host: CLOB_HOST,
    chain: POLYGON_CHAIN_ID as any,
    signer: wallet as any,
    creds,
    signatureType: sigV2,
    funderAddress: funder,
  });

  const result = { client, address, cacheKey };
  _clientCache = result;
  return result;
}

/** Return the server wallet address (no order side-effects). */
export async function getWalletAddress(): Promise<string> {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) throw new Error('POLYMARKET_PRIVATE_KEY not configured');
  return new ethers.Wallet(pk).getAddress();
}

/** Fetch USDC balance/allowance available to the CLOB for trading. */
export async function fetchUsdcBalance(
  signatureType: number = 3,
  funderAddress?: string
): Promise<number | null> {
  try {
    const { client } = await getClobClient(signatureType, funderAddress);
    const bal: any = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const raw = bal?.balance ?? bal?.available ?? null;
    if (raw == null) return null;
    // USDC has 6 decimals on Polygon.
    return Number(raw) / 1e6;
  } catch (err: any) {
    console.log(`[Polymarket] balance error: ${err?.message}`);
    return null;
  }
}

/**
 * Fetch both the USDC balance AND the max exchange allowance for the trading
 * wallet, both normalized to dollars. Trading requires BOTH: funds to spend
 * and an allowance granted to the Polymarket exchange contract(s). If either
 * is zero, orders will never fill.
 */
export async function fetchBalanceAllowanceDollars(
  signatureType: number = 3,
  funderAddress?: string
): Promise<{ balanceDollars: number; maxAllowanceDollars: number } | null> {
  try {
    const { client } = await getClobClient(signatureType, funderAddress);
    const bal: any = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const balanceRaw = Number(bal?.balance ?? bal?.available ?? 0);
    const allowanceObj = bal?.allowances ?? {};
    let maxAllowanceRaw = 0;
    for (const v of Object.values(allowanceObj)) {
      const n = Number(v ?? 0);
      if (!isNaN(n) && n > maxAllowanceRaw) maxAllowanceRaw = n;
    }
    // USDC has 6 decimals on Polygon.
    return {
      balanceDollars: balanceRaw / 1e6,
      maxAllowanceDollars: maxAllowanceRaw / 1e6,
    };
  } catch (err: any) {
    console.log(`[Polymarket] balance/allowance error: ${err?.message}`);
    return null;
  }
}

export interface PlaceLegResult {
  tokenId: string;
  label: string;
  priceDollars: number;
  size: number;
  orderId: string;
  status: string; // matched | live | failed
  error?: string;
}

/**
 * Place a single limit BUY order for a YES token via the CLOB.
 * price is in DOLLARS (e.g. 0.05), size is contract count.
 */
export async function placeClobBuyOrder(params: {
  tokenId: string;
  priceDollars: number;
  size: number;
  tickSize: number;
  negRisk: boolean;
  signatureType?: number;
  funderAddress?: string;
}): Promise<PlaceLegResult> {
  const { tokenId, priceDollars, size, tickSize, negRisk } = params;
  const label = tokenId.slice(0, 8);
  try {
    const { client } = await getClobClient(params.signatureType ?? 3, params.funderAddress);

    const tickStr = (tickSize && tickSize > 0 ? tickSize : 0.01).toString() as any;
    const resp: any = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: priceDollars,
        size,
        side: Side.BUY,
      },
      { tickSize: tickStr, negRisk },
      OrderType.GTC
    );

    // Log the raw CLOB response so order failures are always diagnosable.
    console.log(`[Polymarket] order resp for ${label}: ${JSON.stringify(resp)}`);

    const orderId = resp?.orderID ?? resp?.orderId ?? resp?.id ?? '';
    const rawStatus = String(resp?.status ?? '').toLowerCase();
    // A genuine order ALWAYS comes back with a non-empty orderID. If the CLOB
    // returns success===false, or no orderID, the order did NOT rest/fill —
    // treat it as a hard failure so we never report a phantom "partial" bet.
    const success = resp?.success !== false && !!orderId;
    let status: string;
    if (!success) status = 'failed';
    else if (rawStatus === 'matched') status = 'matched';
    else if (rawStatus === 'live' || rawStatus === 'delayed') status = rawStatus;
    else status = 'live';
    return {
      tokenId,
      label,
      priceDollars,
      size,
      orderId,
      status,
      error: success
        ? undefined
        : (resp?.errorMsg || resp?.error || (!orderId ? 'Order not accepted (no order ID returned) — check wallet USDC balance and exchange allowance' : 'Order rejected')),
    };
  } catch (err: any) {
    return {
      tokenId,
      label,
      priceDollars,
      size,
      orderId: '',
      status: 'failed',
      error: err?.message ?? 'Order failed',
    };
  }
}

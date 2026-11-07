export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { kalshiFetch } from '@/lib/kalshi-api';
import { calculateGoalsStake, fetchGoalsMatchByKey, priceGoalsSide } from '@/lib/goals-markets';
import { fetchPolymarketGoalsMatchByKey } from '@/lib/polymarket-goals';
import { placeClobBuyOrder, fetchBalanceAllowanceDollars } from '@/lib/polymarket-api';

/**
 * POST /api/goals/place
 * Place a single-leg goals bet (BTTS or Over/Under total goals).
 *
 * Body: {
 *   matchKey, league, marketType('btts'|'total'), line?, seriesTicker,
 *   eventTicker, marketTicker, matchTitle, teamA, teamB, matchDate,
 *   side('yes'|'no'), pickLabel, price(cents), modelProb?, edge?, lowScore?,
 *   researchNote?, totalStake?(dollars)
 * }
 *
 * In paper mode (default for this project) no real order is placed; the pick is
 * simulated at its entry price and settled later against the real market result.
 * Live NO-side orders are not supported through the quick-order path, so live
 * mode only accepts YES-side picks.
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const body = await req.json();
    const {
      matchKey, league, marketType, line, seriesTicker, eventTicker, marketTicker,
      matchTitle, teamA, teamB, matchDate, side, pickLabel, price,
      modelProb, edge, lowScore, researchNote, totalStake, source,
    } = body ?? {};

    const betSource = source === 'polymarket' ? 'polymarket' : 'kalshi';

    if (!marketTicker || !eventTicker || (side !== 'yes' && side !== 'no')) {
      return NextResponse.json({ error: 'Missing bet details (marketTicker, eventTicker, side)' }, { status: 400 });
    }
    let entryPrice = Math.round(Number(price));
    if (!isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 100) {
      return NextResponse.json({ error: 'Invalid price' }, { status: 400 });
    }
    // The price the user was shown when they clicked (may be stale by now).
    const shownPrice = entryPrice;

    const config = await prisma.goalsMarketConfig.findUnique({ where: { userId } });
    const maxDaily = config?.maxDailySpend ?? 50;
    const defaultStake = config?.minStakePerBet ?? 2;
    const maxStake = config?.maxStakePerBet ?? 5;
    const paperMode = config?.paperMode ?? true;

    let stakeArg = totalStake ?? defaultStake;
    if (stakeArg > maxStake) stakeArg = maxStake;

    // Daily spend across all bet types (only real, filled/partial orders count).
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [tempDaily, soccerDaily, csDaily, goalsDaily] = await Promise.all([
      prisma.autoBetOrder.findMany({ where: { userId, createdAt: { gte: today }, status: { in: ['filled', 'partial'] } }, select: { totalCost: true } }),
      prisma.soccerBetOrder.findMany({ where: { userId, createdAt: { gte: today }, status: { in: ['filled', 'partial'] } }, select: { totalCost: true } }),
      prisma.correctScoreBetOrder.findMany({ where: { userId, createdAt: { gte: today }, status: { in: ['filled', 'partial'] } }, select: { totalCost: true } }),
      prisma.goalsBetOrder.findMany({ where: { userId, createdAt: { gte: today }, status: { in: ['filled', 'partial'] }, isPaper: false }, select: { totalCost: true } }),
    ]);
    const dailySpentDollars = [...tempDaily, ...soccerDaily, ...csDaily, ...goalsDaily].reduce((s, o) => s + (o.totalCost ?? 0), 0) / 100;

    if (!paperMode && dailySpentDollars + stakeArg > maxDaily) {
      return NextResponse.json({ error: `Daily spend limit exceeded. Spent: $${dailySpentDollars.toFixed(2)}, limit: $${maxDaily.toFixed(2)}` }, { status: 400 });
    }

    // Duplicate check: one active bet per market side, per mode. A demo bet must
    // not block a live bet on the same side (and vice versa).
    const existing = await prisma.goalsBetOrder.findFirst({
      where: { userId, marketTicker, side, isPaper: paperMode, status: { in: ['filled', 'partial', 'pending'] } },
    });
    if (existing) {
      return NextResponse.json({ error: `Already have an active ${paperMode ? 'demo' : 'live'} bet on ${pickLabel} for ${matchTitle}` }, { status: 400 });
    }

    // For Kalshi live bets, need Kalshi creds; for Polymarket live bets, need
    // POLYMARKET_PRIVATE_KEY (checked inside placeClobBuyOrder).
    const creds = await prisma.apiCredential.findFirst({ where: { userId }, orderBy: { updatedAt: 'desc' } });
    if (!paperMode && betSource === 'kalshi' && (!creds?.keyId || !creds?.privateKey)) {
      return NextResponse.json({ error: 'Kalshi credentials not configured' }, { status: 400 });
    }
    if (!paperMode && betSource === 'polymarket' && !process.env.POLYMARKET_PRIVATE_KEY) {
      return NextResponse.json({ error: 'Polymarket private key not configured — set POLYMARKET_PRIVATE_KEY in Settings.' }, { status: 400 });
    }
    if (!paperMode && side === 'no') {
      return NextResponse.json({ error: 'Live NO-side orders (Under / No BTTS) are not supported through the quick-order path. Use Paper mode for these picks.' }, { status: 400 });
    }

    const env = paperMode ? 'production' : (creds?.environment ?? config?.environment ?? 'demo');

    // ── Place-time price refresh ────────────────────────────────────────────
    // Prices move constantly, so the `price` sent from the board can be stale by
    // the time the user actually clicks (especially after working down a long
    // list of matches). Re-fetch the CURRENT quote for THIS market/side and
    // re-price the bet against it. In live mode an adverse move beyond the
    // slippage tolerance is rejected so the user is never filled at a materially
    // worse price than they saw; in paper mode we silently record the true
    // current price so demo fills track reality.
    const normSide: 'yes' | 'no' = side === 'yes' ? 'yes' : 'no';
    const normType: 'btts' | 'total' = marketType === 'btts' ? 'btts' : 'total';
    const slippageCents = config?.slippageCents ?? 1;
    // Tolerable adverse move (cents) above the shown price before we reject.
    const MAX_ADVERSE_MOVE = Math.max(slippageCents, 3);
    try {
      const freshMatch = betSource === 'polymarket'
        ? await fetchPolymarketGoalsMatchByKey(matchKey)
        : await fetchGoalsMatchByKey(matchKey, 'production');
      const freshPrice = freshMatch
        ? priceGoalsSide(freshMatch, normType, typeof line === 'number' ? line : null, normSide, slippageCents)
        : null;

      if (freshPrice != null) {
        if (!paperMode && freshPrice - shownPrice > MAX_ADVERSE_MOVE) {
          return NextResponse.json({
            error: `Price moved against you — was ${shownPrice}¢ when shown, now ${freshPrice}¢. Refresh this match and retry if the new price still has an edge.`,
            priceMoved: true, shownPrice, currentPrice: freshPrice,
          }, { status: 409 });
        }
        // Use the true current price (favorable or within tolerance).
        entryPrice = freshPrice;
      } else if (!paperMode) {
        // Live bet but we couldn't confirm a live quote — refuse rather than
        // place at a price we can't verify.
        return NextResponse.json({
          error: 'Could not verify a live price for this market (it may have just closed or become untradeable). Refresh this match and retry.',
          priceUnavailable: true,
        }, { status: 409 });
      }
      // paper mode + no fresh price: fall back to the shown price so the demo
      // pick is still tracked.
    } catch (e: any) {
      if (!paperMode) {
        return NextResponse.json({
          error: 'Could not refresh the live price for this market. Refresh this match and retry.',
          priceUnavailable: true,
        }, { status: 409 });
      }
      // paper mode: ignore refresh failure and keep the shown price.
    }

    const { contracts, totalCostCents, expectedPayoutCents } = calculateGoalsStake(entryPrice, stakeArg);
    if (contracts <= 0) {
      return NextResponse.json({ error: 'Stake too small for this price' }, { status: 400 });
    }

    let status = 'failed';
    let orderId = '';
    let errorMessage: string | null = null;

    if (paperMode) {
      status = 'filled';
      orderId = `PAPER-${marketTicker}`;
    } else if (betSource === 'polymarket') {
      // ── Live Polymarket CLOB order ──────────────────────────────────────
      // marketTicker is the Gamma market slug (e.g. "brco-san-cre-...-btts").
      // We need to look up clobTokenIds, tickSize, and negRisk from Gamma.
      try {
        const GAMMA_HOST = 'https://gamma-api.polymarket.com';
        const gammaResp = await fetch(`${GAMMA_HOST}/markets?slug=${encodeURIComponent(marketTicker)}`);
        if (!gammaResp.ok) throw new Error(`Gamma lookup failed (${gammaResp.status})`);
        const gammaData = await gammaResp.json();
        const mk = Array.isArray(gammaData) ? gammaData[0] : gammaData;
        if (!mk) throw new Error(`Market not found on Polymarket for slug: ${marketTicker}`);

        const rawTokenIds = (() => {
          try {
            const v = mk?.clobTokenIds;
            if (Array.isArray(v)) return v;
            if (typeof v === 'string') return JSON.parse(v);
          } catch { /* fall through */ }
          return [];
        })();
        if (rawTokenIds.length < 2) {
          throw new Error('Market does not have CLOB token IDs — cannot place a live order.');
        }
        // YES token is always index 0
        const yesTokenId = String(rawTokenIds[0]);
        const tickSize = parseFloat(String(mk?.orderPriceMinTickSize ?? '0.01')) || 0.01;
        const negRisk = mk?.negRisk === true;

        // Read Polymarket wallet config (signatureType, funderAddress) from PolymarketConfig
        const polyConfig = await prisma.polymarketConfig.findUnique({ where: { userId } });
        const signatureType = polyConfig?.signatureType ?? 3;
        const funderAddress = polyConfig?.funderAddress || undefined;

        // Pre-flight: check wallet balance + exchange allowance
        const totalCostDollars = (totalCostCents / 100);
        const funds = await fetchBalanceAllowanceDollars(signatureType, funderAddress);
        if (funds) {
          if (funds.balanceDollars < totalCostDollars) {
            return NextResponse.json({
              error: `Insufficient USDC in Polymarket wallet. Needed $${totalCostDollars.toFixed(2)}, available $${funds.balanceDollars.toFixed(2)}.`,
            }, { status: 400 });
          }
          if (funds.maxAllowanceDollars < totalCostDollars) {
            return NextResponse.json({
              error: `Polymarket exchange allowance too low (allowance $${funds.maxAllowanceDollars.toFixed(2)}, need $${totalCostDollars.toFixed(2)}). Make one manual trade on Polymarket to set the allowance.`,
            }, { status: 400 });
          }
        } else {
          console.log('[Goals/Poly] WARNING: could not verify balance/allowance before placing');
        }

        const priceDollars = entryPrice / 100;
        const result = await placeClobBuyOrder({
          tokenId: yesTokenId,
          priceDollars,
          size: contracts,
          tickSize,
          negRisk,
          signatureType,
          funderAddress,
        });

        orderId = result.orderId;
        status = result.status === 'matched' ? 'filled'
               : result.status === 'live' ? 'pending'
               : 'failed';
        if (result.error) errorMessage = result.error;
      } catch (err: any) {
        errorMessage = err?.message ?? 'Polymarket order failed';
        status = 'failed';
      }
    } else {
      // ── Live Kalshi order ───────────────────────────────────────────────
      try {
        const priceDollars = (entryPrice / 100).toFixed(2);
        const countStr = contracts.toFixed(2);
        const orderResult = await kalshiFetch(
          '/portfolio/events/orders', creds!.keyId, creds!.privateKey, env,
          { method: 'POST', body: JSON.stringify({
            ticker: marketTicker, side: 'bid', count: countStr, price: priceDollars,
            time_in_force: 'good_till_canceled', self_trade_prevention_type: 'taker_at_cross',
          }) }
        );
        const order = orderResult?.order ?? orderResult;
        orderId = order?.order_id ?? order?.id ?? '';
        const remainingCount = parseInt(order?.remaining_count ?? String(contracts), 10);
        const fillCount = parseInt(order?.fill_count ?? '0', 10);
        status = remainingCount === 0 ? 'filled' : fillCount > 0 ? 'partial' : 'pending';
      } catch (err: any) {
        errorMessage = err?.message ?? 'Order failed';
        status = 'failed';
      }
    }

    const record = await prisma.goalsBetOrder.create({
      data: {
        userId,
        league: league ?? 'Soccer',
        marketType: marketType === 'btts' ? 'btts' : 'total',
        line: marketType === 'total' && typeof line === 'number' ? line : null,
        seriesTicker: seriesTicker ?? '',
        eventTicker,
        marketTicker,
        matchTitle: matchTitle ?? '',
        teamA: teamA ?? '',
        teamB: teamB ?? '',
        matchDate: matchDate ?? '',
        side,
        source: betSource,
        pickLabel: pickLabel ?? side,
        entryPrice,
        modelProb: typeof modelProb === 'number' ? modelProb : null,
        edgeCents: typeof edge === 'number' ? edge : null,
        lowScore: typeof lowScore === 'number' ? Math.round(lowScore) : null,
        contracts,
        totalStake: stakeArg,
        totalCost: status === 'failed' ? 0 : totalCostCents,
        expectedPayout: expectedPayoutCents,
        researchNote: researchNote ?? null,
        environment: env,
        isPaper: paperMode,
        status,
        errorMessage,
        settledResult: 'pending',
      },
    });

    return NextResponse.json({
      success: status !== 'failed',
      paper: paperMode,
      order: {
        id: record.id,
        status,
        isPaper: paperMode,
        pickLabel: record.pickLabel,
        contracts,
        entryPrice,
        totalCost: `$${(totalCostCents / 100).toFixed(2)}`,
        expectedPayout: `$${(expectedPayoutCents / 100).toFixed(2)}`,
        error: errorMessage ?? undefined,
      },
    });
  } catch (error: any) {
    console.error('[Goals] Place error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}

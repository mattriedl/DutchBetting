export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { kalshiFetch } from '@/lib/kalshi-api';

/**
 * POST /api/correct-score/place
 * Place a multi-leg correct-score Dutch basket. Buys a uniform contract count
 * across every scoreline in the basket so any single covered score pays
 * contracts * 100c >= total cost.
 *
 * Body: {
 *   eventTicker, seriesTicker, league, matchTitle, teamA, teamB, matchDate,
 *   scorelines: [{ ticker, label, price(cents) }],
 *   combinedCost(cents), dutchMargin, researchNote?, totalStake?(dollars)
 * }
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const body = await req.json();
    const {
      eventTicker,
      seriesTicker,
      league,
      matchTitle,
      teamA,
      teamB,
      matchDate,
      scorelines,
      combinedCost,
      dutchMargin,
      researchNote,
      totalStake,
    } = body ?? {};

    if (!eventTicker || !Array.isArray(scorelines) || scorelines.length < 2) {
      return NextResponse.json({ error: 'Missing basket details (need at least 2 scorelines)' }, { status: 400 });
    }

    // Config: slippage, stake limits. (environment is derived from credentials below)
    const config = await prisma.correctScoreConfig.findUnique({ where: { userId } });
    const slippage = config?.slippageCents ?? 1;
    const maxDaily = config?.maxDailySpend ?? 50;
    const defaultStake = config?.minStakePerBet ?? 2;
    const maxStake = config?.maxStakePerBet ?? 5;
    const paperMode = config?.paperMode ?? false; // paper/demo: track picks, place NO real orders

    let stakeArg = totalStake ?? defaultStake;
    if (stakeArg > maxStake) stakeArg = maxStake; // cap to configured max

    // Daily spend across ALL bet types (temperature + soccer + correct-score).
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [tempDaily, soccerDaily, csDaily] = await Promise.all([
      prisma.autoBetOrder.findMany({
        where: { userId, createdAt: { gte: today }, status: { in: ['filled', 'partial'] } },
        select: { totalCost: true },
      }),
      prisma.soccerBetOrder.findMany({
        where: { userId, createdAt: { gte: today }, status: { in: ['filled', 'partial'] } },
        select: { totalCost: true },
      }),
      prisma.correctScoreBetOrder.findMany({
        where: { userId, createdAt: { gte: today }, status: { in: ['filled', 'partial'] } },
        select: { totalCost: true },
      }),
    ]);
    const dailySpentDollars =
      [...tempDaily, ...soccerDaily, ...csDaily].reduce((s, o) => s + (o.totalCost ?? 0), 0) / 100;

    // Paper/demo baskets never touch real money, so the daily spend cap does not apply to them.
    if (!paperMode && dailySpentDollars + stakeArg > maxDaily) {
      return NextResponse.json({
        error: `Daily spend limit exceeded. Spent: $${dailySpentDollars.toFixed(2)}, limit: $${maxDaily.toFixed(2)}`,
      }, { status: 400 });
    }

    // Duplicate check for same match — only block a basket in the SAME mode so a
    // demo basket never prevents a live one (and vice versa).
    const existing = await prisma.correctScoreBetOrder.findFirst({
      where: { userId, eventTicker, isPaper: paperMode, status: { in: ['filled', 'partial', 'pending'] } },
    });
    if (existing) {
      return NextResponse.json({
        error: `Already have an active ${paperMode ? 'demo' : 'live'} basket on ${matchTitle}`,
      }, { status: 400 });
    }

    // Kalshi credentials. In paper mode we place NO real orders, so credentials
    // are optional. Real markets are always production, so paper baskets settle
    // against the production market results.
    const creds = await prisma.apiCredential.findFirst({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
    if (!paperMode && (!creds?.keyId || !creds?.privateKey)) {
      return NextResponse.json({ error: 'Kalshi credentials not configured' }, { status: 400 });
    }

    // Environment MUST match the environment the credentials are valid for.
    // Kalshi keys are environment-specific: production keys sent to the demo
    // endpoint (or vice-versa) return a 401 authentication_error. So we derive
    // the environment from the stored credential, falling back to config.
    // Paper baskets always use production (markets shown are production).
    const env = paperMode ? 'production' : (creds?.environment ?? config?.environment ?? 'demo');

    // Uniform contracts: cost per unit basket = sum of leg bid prices (with slippage).
    const legs = scorelines.map((s: any) => ({
      ticker: s.ticker as string,
      label: (s.label ?? '') as string,
      price: (s.price ?? 0) as number,
      bidPrice: Math.min((s.price ?? 0) + slippage, 99),
      // Model probability (0-1) for this scoreline at the time of the bet, used
      // later for calibration (predicted hit-rate vs. actual). May be undefined
      // when the basket was placed without running research.
      modelProb: typeof s.modelProb === 'number' ? s.modelProb : null,
    }));
    const costPerUnit = legs.reduce((sum: number, l: any) => sum + l.bidPrice, 0);
    if (costPerUnit >= 100 || costPerUnit <= 0) {
      return NextResponse.json({ error: 'Basket no longer profitable after slippage' }, { status: 400 });
    }

    const stakeCents = Math.round(stakeArg * 100);
    const contracts = Math.max(1, Math.floor(stakeCents / costPerUnit));

    // Place each leg, cheapest first for fill quality.
    legs.sort((a: any, b: any) => a.bidPrice - b.bidPrice);

    const placed: any[] = [];
    let totalCostCents = 0;
    let allFilled = true;
    let anyFilled = false;
    const errors: string[] = [];
    let overallStatus = 'failed';

    if (paperMode) {
      // PAPER/DEMO: no real orders. Simulate a full fill of every leg at its
      // bid price so the basket can be tracked and settled later exactly like a
      // real one, but without spending any money.
      for (const leg of legs) {
        placed.push({
          ticker: leg.ticker, label: leg.label, price: leg.price, bidPrice: leg.bidPrice,
          modelProb: leg.modelProb,
          contracts, orderId: `PAPER-${leg.ticker}`, fillStatus: 'filled',
        });
        totalCostCents += contracts * leg.bidPrice;
      }
      overallStatus = 'filled';
    } else {
    for (const leg of legs) {
      try {
        const priceDollars = (leg.bidPrice / 100).toFixed(2);
        const countStr = contracts.toFixed(2);
        const orderResult = await kalshiFetch(
          '/portfolio/events/orders',
          creds!.keyId,
          creds!.privateKey,
          env,
          {
            method: 'POST',
            body: JSON.stringify({
              ticker: leg.ticker,
              side: 'bid',
              count: countStr,
              price: priceDollars,
              time_in_force: 'good_till_canceled',
              self_trade_prevention_type: 'taker_at_cross',
            }),
          }
        );
        const order = orderResult?.order ?? orderResult;
        const orderId = order?.order_id ?? order?.id ?? '';
        const fillCount = parseInt(order?.fill_count ?? '0', 10);
        const remainingCount = parseInt(order?.remaining_count ?? String(contracts), 10);
        const fillStatus = remainingCount === 0 ? 'filled' : fillCount > 0 ? 'partial' : 'resting';

        placed.push({ ticker: leg.ticker, label: leg.label, price: leg.price, bidPrice: leg.bidPrice, modelProb: leg.modelProb, contracts, orderId, fillStatus });
        totalCostCents += contracts * leg.bidPrice;

        if (fillStatus !== 'filled') allFilled = false;
        if (fillStatus === 'filled' || fillStatus === 'partial') anyFilled = true;

        await new Promise(r => setTimeout(r, 250));
      } catch (err: any) {
        const errMsg = err?.message ?? 'Order failed';
        errors.push(`${leg.label}: ${errMsg}`);
        placed.push({ ticker: leg.ticker, label: leg.label, price: leg.price, bidPrice: leg.bidPrice, modelProb: leg.modelProb, contracts, fillStatus: 'failed', error: errMsg });
        allFilled = false;
      }
    }

    if (allFilled && placed.every(o => o.orderId)) overallStatus = 'filled';
    else if (anyFilled || placed.some(o => o.orderId)) overallStatus = 'partial';
    else if (placed.some(o => o.fillStatus === 'resting')) overallStatus = 'pending';
    }

    const record = await prisma.correctScoreBetOrder.create({
      data: {
        userId,
        league: league ?? 'Unknown',
        seriesTicker: seriesTicker ?? '',
        eventTicker,
        matchTitle: matchTitle ?? '',
        teamA: teamA ?? '',
        teamB: teamB ?? '',
        matchDate: matchDate ?? '',
        numPicks: legs.length,
        scorelines: JSON.stringify(placed),
        totalCost: totalCostCents,
        combinedCost: combinedCost ?? costPerUnit,
        dutchMargin: dutchMargin ?? 0,
        contracts,
        totalStake: stakeArg,
        expectedPayout: contracts * 100,
        researchNote: researchNote ?? null,
        environment: env,
        isPaper: paperMode,
        status: overallStatus,
        errorMessage: errors.length > 0 ? errors.join('; ') : null,
        settledResult: 'pending',
      },
    });

    return NextResponse.json({
      success: overallStatus !== 'failed',
      paper: paperMode,
      order: {
        id: record.id,
        status: overallStatus,
        isPaper: paperMode,
        totalCost: `$${(totalCostCents / 100).toFixed(2)}`,
        contracts,
        numPicks: legs.length,
        legs: placed,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (error: any) {
    console.error('[CorrectScore] Place error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}

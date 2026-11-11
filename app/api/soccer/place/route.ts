export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { kalshiFetch } from '@/lib/kalshi-api';

/**
 * POST /api/soccer/place
 * Place a 2-way Dutch bet on a soccer match (Favorite Win + Draw).
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
      favorite,
      favWinTicker,
      favWinPrice,  // ask price in cents (no slippage)
      drawTicker,
      drawPrice,    // ask price in cents (no slippage)
      combinedCost,
      dutchMargin,
      totalStake,   // dollars
    } = body ?? {};

    if (!eventTicker || !favWinTicker || !drawTicker) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Get auto-bet config for environment and slippage
    const config = await prisma.autoBetConfig.findUnique({ where: { userId } });
    const env = config?.environment ?? 'demo';
    const slippage = config?.slippageCents ?? 2;
    const maxDaily = config?.maxDailySpend ?? 100;

    // "demo" means PAPER mode: track the pick and simulate fills, place NO real
    // Kalshi orders. Kalshi keys are environment-specific and there is no demo
    // account, so sending a demo order with production credentials returns a 401
    // authentication_error. Only "production" places a real order.
    const paperMode = env !== 'production';

    // Check daily spend (including both temp and soccer bets)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [tempDailyOrders, soccerDailyOrders] = await Promise.all([
      prisma.autoBetOrder.findMany({
        where: { userId, createdAt: { gte: today }, status: { in: ['filled', 'partial', 'pending'] } },
        select: { totalCost: true },
      }),
      prisma.soccerBetOrder.findMany({
        where: { userId, createdAt: { gte: today }, status: { in: ['filled', 'partial', 'pending'] } },
        select: { totalCost: true },
      }),
    ]);
    const dailySpentCents = [...tempDailyOrders, ...soccerDailyOrders].reduce(
      (sum, o) => sum + (o.totalCost ?? 0), 0
    );
    const dailySpentDollars = dailySpentCents / 100;

    if (dailySpentDollars + (totalStake ?? 10) > maxDaily) {
      return NextResponse.json({
        error: `Daily spend limit exceeded. Spent: $${dailySpentDollars.toFixed(2)}, limit: $${maxDaily.toFixed(2)}`,
      }, { status: 400 });
    }

    // Check for duplicate bet on same match
    const existing = await prisma.soccerBetOrder.findFirst({
      where: { userId, eventTicker, status: { in: ['filled', 'partial', 'pending'] } },
    });
    if (existing) {
      return NextResponse.json({ error: `Already have an active bet on ${matchTitle}` }, { status: 400 });
    }

    // Get Kalshi credentials. In paper (demo) mode we place NO real orders, so
    // credentials are optional. Real markets are always production, so paper bets
    // settle against the production market results.
    const creds = await prisma.apiCredential.findFirst({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
    if (!paperMode && (!creds?.keyId || !creds?.privateKey)) {
      return NextResponse.json({ error: 'Kalshi credentials not configured' }, { status: 400 });
    }

    // Environment MUST match what the credentials are valid for. Kalshi keys are
    // environment-specific: a production key sent to the demo endpoint returns a
    // 401 authentication_error. Real orders use the credential's own environment.
    // Paper bets always reference production (the markets shown are production).
    const orderEnv = paperMode ? 'production' : (creds?.environment ?? 'production');

    // Apply slippage
    const favWinBidPrice = Math.min((favWinPrice ?? 0) + slippage, 99);
    const drawBidPrice = Math.min((drawPrice ?? 0) + slippage, 99);
    const costPerPair = favWinBidPrice + drawBidPrice;

    // Calculate contracts
    const stakeArg = totalStake ?? (config?.maxStakePerBet ?? 10);
    const stakeCents = Math.round(stakeArg * 100);
    const numContracts = Math.max(1, Math.floor(stakeCents / costPerPair));

    const orders: { leg: string; ticker: string; bidPrice: number; count: number; orderId?: string; fillStatus?: string; error?: string }[] = [];
    let totalCostCents = 0;
    let allFilled = true;
    let anyFilled = false;
    const errors: string[] = [];

    // Place both legs: Favorite Win first (usually more liquid), then Draw
    const legs = [
      { leg: 'favWin', ticker: favWinTicker, bidPrice: favWinBidPrice },
      { leg: 'draw', ticker: drawTicker, bidPrice: drawBidPrice },
    ];

    // Sort legs cheapest first for better fill rates
    legs.sort((a, b) => a.bidPrice - b.bidPrice);

    if (paperMode) {
      // PAPER/DEMO: no real orders. Simulate a full fill of every leg at its bid
      // price so the bet can be tracked and settled exactly like a real one, but
      // without spending any money or touching Kalshi's authenticated endpoint.
      for (const legInfo of legs) {
        orders.push({ ...legInfo, count: numContracts, orderId: `PAPER-${legInfo.ticker}`, fillStatus: 'filled' });
        totalCostCents += numContracts * legInfo.bidPrice;
        anyFilled = true;
      }
    } else {
    for (const legInfo of legs) {
      try {
        const priceDollars = (legInfo.bidPrice / 100).toFixed(2);
        const countStr = numContracts.toFixed(2);

        const orderResult = await kalshiFetch(
          '/portfolio/events/orders',
          creds!.keyId,
          creds!.privateKey,
          orderEnv,
          {
            method: 'POST',
            body: JSON.stringify({
              ticker: legInfo.ticker,
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
        const remainingCount = parseInt(order?.remaining_count ?? String(numContracts), 10);
        const fillStatus = remainingCount === 0 ? 'filled' : fillCount > 0 ? 'partial' : 'resting';

        orders.push({ ...legInfo, count: numContracts, orderId, fillStatus });
        totalCostCents += numContracts * legInfo.bidPrice;

        if (fillStatus !== 'filled') allFilled = false;
        if (fillStatus === 'filled' || fillStatus === 'partial') anyFilled = true;

        await new Promise(r => setTimeout(r, 200));
      } catch (err: any) {
        const errMsg = err?.message ?? 'Order failed';
        errors.push(`${legInfo.leg}: ${errMsg}`);
        orders.push({ ...legInfo, count: numContracts, fillStatus: 'failed', error: errMsg });
        allFilled = false;
      }
    }
    }

    let overallStatus = 'failed';
    if (allFilled && orders.every(o => o.orderId)) overallStatus = 'filled';
    else if (anyFilled || orders.some(o => o.orderId)) overallStatus = 'partial';
    else if (orders.some(o => o.fillStatus === 'resting')) overallStatus = 'pending';

    const favWinOrder = orders.find(o => o.leg === 'favWin');
    const drawOrder = orders.find(o => o.leg === 'draw');

    // Save to database
    const favName = favorite === 'teamA' ? teamA : teamB;
    const record = await prisma.soccerBetOrder.create({
      data: {
        userId,
        league: league ?? 'Unknown',
        seriesTicker: seriesTicker ?? '',
        eventTicker,
        matchTitle: matchTitle ?? '',
        teamA: teamA ?? '',
        teamB: teamB ?? '',
        matchDate: matchDate ?? '',
        favorite: favName ?? '',
        favWinTicker,
        favWinPrice: favWinPrice ?? 0,
        drawTicker,
        drawPrice: drawPrice ?? 0,
        combinedCost: combinedCost ?? 0,
        dutchMargin: dutchMargin ?? 0,
        favWinContracts: numContracts,
        drawContracts: numContracts,
        favWinOrderId: favWinOrder?.orderId ?? null,
        drawOrderId: drawOrder?.orderId ?? null,
        favWinBidPrice: favWinBidPrice,
        drawBidPrice: drawBidPrice,
        totalStake: stakeArg,
        totalCost: totalCostCents,
        expectedPayout: numContracts * 100, // $1 per contract if either leg wins
        environment: orderEnv,
        status: overallStatus,
        errorMessage: errors.length > 0 ? errors.join('; ') : null,
        settledResult: 'pending',
      },
    });

    return NextResponse.json({
      success: overallStatus !== 'failed',
      order: {
        id: record.id,
        status: overallStatus,
        totalCost: `$${(totalCostCents / 100).toFixed(2)}`,
        contracts: numContracts,
        legs: orders,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (error: any) {
    console.error('[Soccer] Place bet error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}

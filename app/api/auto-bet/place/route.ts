export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { kalshiFetch } from '@/lib/kalshi-api';
import { isMarketStillBettable } from '@/lib/market-timing';
import { calculateUniformContracts } from '@/lib/dutch-betting';

interface BinOrder {
  ticker: string;
  range: string;
  price: number; // yes price in cents
  count: number; // number of contracts
  stake: number; // dollar amount for this leg
  orderId?: string;
  fillStatus?: string;
  errorMessage?: string;
}

/**
 * Place a Dutch bet on Kalshi — 3 separate YES orders (one per bin).
 * 
 * Accepts either:
 *   - Full analysis data from the frontend (one-click mode)
 *   - Or is called internally from the refresh route (full-auto mode)
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const body = await req.json();
    const {
      city,
      state,
      marketType,
      eventTicker, // e.g., KXHIGHNY-26JUN11
      forecastDate,
      nwsForecast,
      profitMargin,
      rating,
      positions, // [{ticker, range, odds (cents), stake ($)}]
      totalStake,
      guaranteedReturn,
    } = body ?? {};

    if (!city || !positions?.length || !eventTicker) {
      return NextResponse.json({ error: 'Missing required fields: city, positions, eventTicker' }, { status: 400 });
    }

    // CRITICAL: Prevent betting on markets where the temperature extreme already occurred
    // The UI may have stale opportunities if the page was left open
    if (forecastDate && marketType) {
      const eventDateStr = typeof forecastDate === 'string' && forecastDate.length >= 10
        ? forecastDate.slice(0, 10)
        : '';
      if (eventDateStr && !isMarketStillBettable(city, eventDateStr, marketType)) {
        return NextResponse.json({
          error: `This ${marketType.toUpperCase()} market for ${city} is no longer bettable — the temperature extreme has likely already occurred today. Refresh to see current opportunities.`,
        }, { status: 400 });
      }
    }

    // Get auto-bet config for guardrails
    const config = await prisma.autoBetConfig.findUnique({ where: { userId } });
    const maxStake = config?.maxStakePerBet ?? 10;
    const maxDaily = config?.maxDailySpend ?? 100;
    const slippage = config?.slippageCents ?? 2;
    const env = config?.environment ?? 'demo';

    // Check daily spend limit
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dailyOrders = await prisma.autoBetOrder.findMany({
      where: {
        userId,
        createdAt: { gte: today },
        status: { in: ['filled', 'partial'] },
      },
      select: { totalCost: true },
    });
    const dailySpentCents = dailyOrders.reduce((sum, o) => sum + (o.totalCost ?? 0), 0);
    const dailySpentDollars = dailySpentCents / 100;

    if (dailySpentDollars + (totalStake ?? maxStake) > maxDaily) {
      return NextResponse.json({
        error: `Daily spend limit would be exceeded. Spent today: $${dailySpentDollars.toFixed(2)}, limit: $${maxDaily.toFixed(2)}`,
      }, { status: 400 });
    }

    // Check for duplicate — don't bet the same event twice
    const existing = await prisma.autoBetOrder.findFirst({
      where: { userId, eventTicker, city, status: { in: ['filled', 'partial', 'pending'] } },
    });
    if (existing) {
      return NextResponse.json({
        error: `Already have an active bet on ${city} ${eventTicker}`,
      }, { status: 400 });
    }

    // Get Kalshi credentials
    const creds = await prisma.apiCredential.findFirst({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });

    if (!creds?.keyId || !creds?.privateKey) {
      return NextResponse.json({ error: 'Kalshi API credentials not configured. Go to Settings.' }, { status: 400 });
    }

    // Place orders for each bin
    const binOrders: BinOrder[] = [];
    let totalCostCents = 0;
    let allFilled = true;
    let anyFilled = false;
    const errors: string[] = [];

    // Sort positions by price ascending (cheapest first)
    // Cheapest bins have the most liquidity and are most likely to fill immediately
    const sortedPositions = [...positions].sort((a: any, b: any) => {
      const priceA = Math.round(a.odds ?? a.price ?? 0);
      const priceB = Math.round(b.odds ?? b.price ?? 0);
      return priceA - priceB;
    });

    // UNIFORM CONTRACT ALLOCATION — buy the SAME number of contracts in every bin.
    // Each contract pays $1 (100¢) if its bin wins, so equal counts mean equal payouts
    // across all bins. This guarantees the winning bin always covers the combined cost
    // of all legs (profit when sum of bid prices < 100¢). Per-bin floor(stake/price)
    // would leave one selection short — the bug this fixes.
    const bidPrices = sortedPositions.map((p: any) => {
      const base = Math.round(p.odds ?? p.price ?? 0);
      return Math.min(base + slippage, 99);
    });
    const totalStakeCentsForBet = Math.round((totalStake ?? maxStake) * 100);
    const uniformCount = calculateUniformContracts(bidPrices, totalStakeCentsForBet);

    for (const pos of sortedPositions) {
      const basePrice = Math.round(pos.odds ?? pos.price ?? 0);
      // Apply slippage buffer — bid higher to improve fill rate
      const bidPrice = Math.min(basePrice + slippage, 99);
      if (basePrice <= 0 || basePrice >= 100) {
        binOrders.push({
          ticker: pos.ticker,
          range: pos.range,
          price: basePrice,
          count: 0,
          stake: pos.stake ?? 0,
          fillStatus: 'skipped',
          errorMessage: `Invalid price: ${basePrice}¢`,
        });
        allFilled = false;
        continue;
      }

      // Same contract count for every bin so all payouts match and cover total cost
      const count = uniformCount;
      const costCents = count * bidPrice;

      try {
        // Use Kalshi Create Order V2 API with buffered price
        const priceDollars = (bidPrice / 100).toFixed(2);
        const countStr = count.toFixed(2);
        const orderResult = await kalshiFetch(
          '/portfolio/events/orders',
          creds.keyId,
          creds.privateKey,
          env,
          {
            method: 'POST',
            body: JSON.stringify({
              ticker: pos.ticker,
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
        // V2 uses fill_count/remaining_count instead of status
        const fillCount = parseInt(order?.fill_count ?? '0', 10);
        const remainingCount = parseInt(order?.remaining_count ?? String(count), 10);
        const fillStatus = remainingCount === 0 ? 'filled' : fillCount > 0 ? 'partial' : 'resting';

        binOrders.push({
          ticker: pos.ticker,
          range: pos.range,
          price: bidPrice,
          count,
          stake: pos.stake ?? 0,
          orderId,
          fillStatus,
        });

        if (fillStatus !== 'filled') {
          allFilled = false;
        } else {
          anyFilled = true;
        }
        totalCostCents += costCents;

        // Small delay between orders to avoid rate limits
        await new Promise(r => setTimeout(r, 200));

      } catch (orderErr: any) {
        const errMsg = orderErr?.message ?? 'Unknown order error';
        errors.push(`${pos.ticker}: ${errMsg}`);
        binOrders.push({
          ticker: pos.ticker,
          range: pos.range,
          price: bidPrice,
          count,
          stake: pos.stake ?? 0,
          fillStatus: 'failed',
          errorMessage: errMsg,
        });
        allFilled = false;
      }
    }

    // Determine overall status
    let overallStatus = 'failed';
    if (allFilled && binOrders.every(b => b.orderId)) overallStatus = 'filled';
    else if (anyFilled || binOrders.some(b => b.orderId)) overallStatus = 'partial';
    else if (binOrders.some(b => b.fillStatus === 'resting')) overallStatus = 'pending';

    // Save order record
    const order = await prisma.autoBetOrder.create({
      data: {
        userId,
        city: city ?? '',
        state: state ?? '',
        marketType: marketType ?? 'high',
        eventTicker: eventTicker ?? '',
        forecastDate: forecastDate ?? '',
        nwsForecast: nwsForecast ?? 0,
        profitMargin: profitMargin ?? 0,
        rating: rating ?? 'none',
        totalStake: totalStake ?? maxStake,
        totalCost: totalCostCents,
        expectedPayout: (totalStake ?? maxStake) + (guaranteedReturn ?? 0),
        environment: env,
        status: overallStatus,
        errorMessage: errors.length > 0 ? errors.join('; ') : null,
        bins: JSON.stringify(binOrders),
        settledResult: 'pending',
      },
    });

    return NextResponse.json({
      success: overallStatus !== 'failed',
      order: {
        id: order.id,
        status: overallStatus,
        totalCost: `$${(totalCostCents / 100).toFixed(2)}`,
        bins: binOrders,
        errors: errors.length > 0 ? errors : undefined,
      },
    });

  } catch (error: any) {
    console.error('AutoBet place error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}

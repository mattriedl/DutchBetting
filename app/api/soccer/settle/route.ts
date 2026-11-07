export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { kalshiPublicFetch } from '@/lib/kalshi-api';

/**
 * POST /api/soccer/settle
 * Checks Kalshi for settled soccer markets and resolves open bets.
 * 
 * For each unsettled SoccerBetOrder:
 *   1. Fetch event from Kalshi to check if markets are settled
 *   2. Determine match result (team_a_win, draw, team_b_win)
 *   3. Calculate payout: if fav_win or draw, payout = contracts * 100¢; else 0
 *   4. Update order with settlement data
 */
export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    // Get all unsettled soccer orders
    const pendingOrders = await prisma.soccerBetOrder.findMany({
      where: {
        userId,
        settledResult: 'pending',
        status: { in: ['filled', 'partial'] },
      },
    });

    if (pendingOrders.length === 0) {
      return NextResponse.json({ message: 'No pending soccer bets to settle', settled: 0 });
    }

    let settledCount = 0;
    const results: any[] = [];

    for (const order of pendingOrders) {
      try {
        // Check each market in the event
        // The favWinTicker and drawTicker markets will have 'result' field when settled
        const [favWinMarket, drawMarket] = await Promise.all([
          kalshiPublicFetch(`/markets/${order.favWinTicker}`, order.environment).catch(() => null),
          kalshiPublicFetch(`/markets/${order.drawTicker}`, order.environment).catch(() => null),
        ]);

        const favResult = favWinMarket?.market?.result;
        const drawResult = drawMarket?.market?.result;

        // If neither is settled yet, skip
        if (!favResult && !drawResult) {
          results.push({ eventTicker: order.eventTicker, status: 'not_settled_yet' });
          continue;
        }

        // Determine match result
        let matchResult: string;
        let won: boolean;
        let payoutCents: number;

        if (favResult === 'yes') {
          // Favorite won
          matchResult = order.favorite === order.teamA ? 'team_a_win' : 'team_b_win';
          won = true;
          payoutCents = order.favWinContracts * 100;
        } else if (drawResult === 'yes') {
          // Draw
          matchResult = 'draw';
          won = true;
          payoutCents = order.drawContracts * 100;
        } else if (favResult === 'no' && drawResult === 'no') {
          // Underdog won (both our legs lost)
          matchResult = order.favorite === order.teamA ? 'team_b_win' : 'team_a_win';
          won = false;
          payoutCents = 0;
        } else {
          // Partial settlement — skip for now
          results.push({ eventTicker: order.eventTicker, status: 'partial_settlement' });
          continue;
        }

        const netProfit = payoutCents - (order.totalCost ?? 0);

        await prisma.soccerBetOrder.update({
          where: { id: order.id },
          data: {
            settledResult: won ? 'won' : 'lost',
            settledPayout: payoutCents,
            matchResult,
            netProfit,
          },
        });

        settledCount++;
        results.push({
          eventTicker: order.eventTicker,
          matchTitle: order.matchTitle,
          matchResult,
          won,
          payout: `$${(payoutCents / 100).toFixed(2)}`,
          netProfit: `$${(netProfit / 100).toFixed(2)}`,
        });

        // Rate limit
        await new Promise(r => setTimeout(r, 300));
      } catch (err: any) {
        console.error(`[Soccer Settle] Error for ${order.eventTicker}:`, err?.message);
        results.push({ eventTicker: order.eventTicker, status: 'error', error: err?.message });
      }
    }

    return NextResponse.json({ settled: settledCount, total: pendingOrders.length, results });
  } catch (error: any) {
    console.error('[Soccer Settle] Error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Settlement failed' }, { status: 500 });
  }
}

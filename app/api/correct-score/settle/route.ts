export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { kalshiPublicFetch } from '@/lib/kalshi-api';
import { computeAndStoreCalibration } from '@/lib/calibration';

/**
 * POST /api/correct-score/settle
 * Resolve open correct-score baskets. For each basket, check every covered
 * scoreline market's `result`. If any covered scoreline settled 'yes', the
 * basket won (payout = contracts * 100c). If all covered scorelines settled
 * 'no', the basket lost.
 */
export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const pendingOrders = await prisma.correctScoreBetOrder.findMany({
      where: { userId, settledResult: 'pending', status: { in: ['filled', 'partial'] } },
    });

    if (pendingOrders.length === 0) {
      return NextResponse.json({ message: 'No pending baskets to settle', settled: 0 });
    }

    let settledCount = 0;
    const results: any[] = [];

    for (const order of pendingOrders) {
      try {
        let legs: any[] = [];
        try { legs = JSON.parse(order.scorelines ?? '[]'); } catch { legs = []; }
        if (legs.length === 0) {
          results.push({ eventTicker: order.eventTicker, status: 'no_legs' });
          continue;
        }

        // Fetch each covered market's result.
        const marketResults: { label: string; result: string | undefined }[] = [];
        let anySettled = false;
        for (const leg of legs) {
          const mk = await kalshiPublicFetch(`/markets/${leg.ticker}`, order.environment).catch(() => null);
          const result = mk?.market?.result;
          if (result === 'yes' || result === 'no') anySettled = true;
          marketResults.push({ label: leg.label, result });
          await new Promise(r => setTimeout(r, 200));
        }

        if (!anySettled) {
          results.push({ eventTicker: order.eventTicker, status: 'not_settled_yet' });
          continue;
        }

        const winner = marketResults.find(m => m.result === 'yes');
        const allNo = marketResults.every(m => m.result === 'no');

        let won: boolean;
        let payoutCents: number;
        let winningScore: string | null = null;
        let finalScore: string | null = null;

        if (winner) {
          won = true;
          payoutCents = (order.contracts ?? 0) * 100;
          winningScore = winner.label;
          finalScore = winner.label; // the covered leg that hit IS the final score
        } else if (allNo) {
          won = false;
          payoutCents = 0;
          // None of the covered legs hit. Discover the actual final score by
          // scanning every scoreline market in the event for the one that
          // resolved 'yes'.
          try {
            const ev = await kalshiPublicFetch(
              `/events/${order.eventTicker}?with_nested_markets=true`,
              order.environment
            ).catch(() => null);
            const evMarkets = ev?.event?.markets ?? ev?.markets ?? [];
            const hit = evMarkets.find((mk: any) => mk?.result === 'yes');
            if (hit) {
              const rawSub: string = hit?.yes_sub_title ?? '';
              finalScore = rawSub.replace(/^Reg(ulation)?\s*Time:\s*/i, '').trim() || null;
            }
          } catch { /* best-effort: final score stays null */ }
        } else {
          // Some covered legs still not settled; wait until fully resolved.
          results.push({ eventTicker: order.eventTicker, status: 'partial_settlement' });
          continue;
        }

        const netProfit = payoutCents - (order.totalCost ?? 0);

        await prisma.correctScoreBetOrder.update({
          where: { id: order.id },
          data: {
            settledResult: won ? 'won' : 'lost',
            settledPayout: payoutCents,
            winningScore,
            finalScore,
            netProfit,
          },
        });

        settledCount++;
        results.push({
          eventTicker: order.eventTicker,
          matchTitle: order.matchTitle,
          won,
          winningScore,
          finalScore,
          payout: `$${(payoutCents / 100).toFixed(2)}`,
          netProfit: `$${(netProfit / 100).toFixed(2)}`,
        });
      } catch (err: any) {
        console.error(`[CorrectScore Settle] Error for ${order.eventTicker}:`, err?.message);
        results.push({ eventTicker: order.eventTicker, status: 'error', error: err?.message });
      }
    }

    // Newly-settled outcomes change the learned model calibration, so refresh it
    // automatically (best-effort — never let a calibration failure break settlement).
    if (settledCount > 0) {
      try {
        await computeAndStoreCalibration(userId, 'global');
      } catch (e: any) {
        console.error('[CorrectScore Settle] calibration recompute failed:', e?.message);
      }
    }

    return NextResponse.json({ settled: settledCount, total: pendingOrders.length, results });
  } catch (error: any) {
    console.error('[CorrectScore Settle] Error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Settlement failed' }, { status: 500 });
  }
}

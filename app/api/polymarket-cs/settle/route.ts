export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { fetchPolyResolutions } from '@/lib/polymarket-api';
import { computeAndStoreCalibration } from '@/lib/calibration';

/**
 * POST /api/polymarket-cs/settle
 * Resolve open Polymarket exact-score baskets (real AND paper). For each basket,
 * check every covered scoreline market's resolution via the Gamma API. If any
 * covered YES token resolved true, the basket won (payout = contracts * $1). If
 * every covered scoreline resolved false, the basket lost. Paper baskets settle
 * exactly like real ones so tracked demo picks can be evaluated.
 */
export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const pendingOrders = await prisma.polymarketBetOrder.findMany({
      where: { userId, settledResult: 'pending', status: { in: ['filled', 'partial'] } },
    });

    if (pendingOrders.length === 0) {
      return NextResponse.json({ message: 'No pending baskets to settle', settled: 0, pending: 0 });
    }

    let settledCount = 0;
    const results: any[] = [];

    for (const order of pendingOrders) {
      try {
        let legs: any[] = [];
        try { legs = JSON.parse(order.scorelines ?? '[]'); } catch { legs = []; }
        if (legs.length === 0) {
          results.push({ eventSlug: order.eventSlug, status: 'no_legs' });
          continue;
        }

        const resolutions = await fetchPolyResolutions(order.eventSlug);
        if (resolutions.length === 0) {
          results.push({ eventSlug: order.eventSlug, status: 'not_settled_yet' });
          continue;
        }
        const byToken = new Map(resolutions.map(r => [r.yesTokenId, r]));

        // A basket is only fully settleable once every market it references has
        // a definitive resolution. Otherwise wait.
        let anyResolved = false;
        let allResolved = true;
        let winnerLabel: string | null = null;
        for (const leg of legs) {
          const res = byToken.get(String(leg.tokenId));
          if (res?.resolved) {
            anyResolved = true;
            if (res.yesWon) winnerLabel = leg.label ?? res.title;
          } else {
            allResolved = false;
          }
        }

        if (!anyResolved) {
          results.push({ eventSlug: order.eventSlug, status: 'not_settled_yet' });
          continue;
        }
        // If a covered leg won, we can settle immediately (basket won). If none
        // won yet but some legs are unresolved, wait for full resolution.
        if (!winnerLabel && !allResolved) {
          results.push({ eventSlug: order.eventSlug, status: 'partial_settlement' });
          continue;
        }

        const won = !!winnerLabel;
        const payoutCents = won ? (order.contracts ?? 0) * 100 : 0;
        const netProfit = payoutCents - (order.totalCost ?? 0);

        // Actual final score of the match = the whole-event market that resolved
        // YES (works whether or not our basket covered it).
        const eventWinner = resolutions.find(r => r.resolved && r.yesWon);
        const finalScore = eventWinner?.title ?? winnerLabel ?? null;

        await prisma.polymarketBetOrder.update({
          where: { id: order.id },
          data: {
            settledResult: won ? 'won' : 'lost',
            settledPayout: payoutCents,
            winningScore: winnerLabel,
            finalScore,
            netProfit,
          },
        });
        settledCount++;
        results.push({
          eventSlug: order.eventSlug,
          status: won ? 'won' : 'lost',
          winningScore: winnerLabel,
          finalScore,
          netProfit: `$${(netProfit / 100).toFixed(2)}`,
          isPaper: order.isPaper,
        });

        await new Promise(r => setTimeout(r, 200));
      } catch (err: any) {
        results.push({ eventSlug: order.eventSlug, status: 'error', error: err?.message });
      }
    }

    // Newly-settled outcomes change the learned model calibration, so refresh it
    // automatically (best-effort — never let a calibration failure break settlement).
    if (settledCount > 0) {
      try {
        await computeAndStoreCalibration(userId, 'global');
      } catch (e: any) {
        console.error('[Polymarket] calibration recompute failed:', e?.message);
      }
    }

    return NextResponse.json({
      message: `Settled ${settledCount} of ${pendingOrders.length} baskets`,
      settled: settledCount,
      pending: pendingOrders.length - settledCount,
      results,
    });
  } catch (error: any) {
    console.error('[Polymarket] Settle error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}

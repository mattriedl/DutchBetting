export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { kalshiPublicFetch } from '@/lib/kalshi-api';
import { fetchPolymarketGoalsResolutions } from '@/lib/polymarket-goals';
import { computeAndStoreCalibration } from '@/lib/calibration';

/**
 * POST /api/goals/settle
 * Resolve open goals bets. For each bet, read the market result. A 'yes'-side
 * bet wins when the market settles 'yes'; a 'no'-side bet wins when it settles
 * 'no'. Payout = contracts * 100c.
 */
export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const pending = await prisma.goalsBetOrder.findMany({
      where: { userId, settledResult: 'pending', status: { in: ['filled', 'partial'] } },
    });
    if (pending.length === 0) {
      return NextResponse.json({ message: 'No pending bets to settle', settled: 0 });
    }

    let settledCount = 0;
    const results: any[] = [];

    // Cache Polymarket event resolutions so multiple bets on the same event
    // (e.g. Under 2.5 + No BTTS) only trigger one Gamma lookup.
    const polyResCache = new Map<string, Awaited<ReturnType<typeof fetchPolymarketGoalsResolutions>>>();

    for (const order of pending) {
      try {
        // ── Polymarket settlement via Gamma resolution data ──
        if ((order as any).source === 'polymarket') {
          let res = polyResCache.get(order.eventTicker);
          if (!res) {
            res = await fetchPolymarketGoalsResolutions(order.eventTicker);
            polyResCache.set(order.eventTicker, res);
          }
          const r = res.find(x => x.marketSlug === order.marketTicker);
          if (!r || !r.resolved) {
            results.push({ marketTicker: order.marketTicker, status: 'not_settled_yet' });
            continue;
          }
          const wonP = (order.side === 'yes' && r.yesWon) || (order.side === 'no' && !r.yesWon);
          const payoutCentsP = wonP ? (order.contracts ?? 0) * 100 : 0;
          const netProfitP = payoutCentsP - (order.totalCost ?? 0);
          await prisma.goalsBetOrder.update({
            where: { id: order.id },
            data: {
              settledResult: wonP ? 'won' : 'lost',
              settledPayout: payoutCentsP,
              marketResult: r.yesWon ? 'yes' : 'no',
              finalGoals: null,
              netProfit: netProfitP,
            },
          });
          settledCount++;
          results.push({
            marketTicker: order.marketTicker,
            matchTitle: order.matchTitle,
            pick: order.pickLabel,
            won: wonP,
            payout: `$${(payoutCentsP / 100).toFixed(2)}`,
            netProfit: `$${(netProfitP / 100).toFixed(2)}`,
          });
          continue;
        }

        const mk = await kalshiPublicFetch(`/markets/${order.marketTicker}`, order.environment).catch(() => null);
        const result = mk?.market?.result;
        if (result !== 'yes' && result !== 'no') {
          results.push({ marketTicker: order.marketTicker, status: 'not_settled_yet' });
          continue;
        }

        const won = (order.side === 'yes' && result === 'yes') || (order.side === 'no' && result === 'no');
        const payoutCents = won ? (order.contracts ?? 0) * 100 : 0;
        const netProfit = payoutCents - (order.totalCost ?? 0);

        // Best-effort: fetch actual total goals from the totals ladder if this was
        // a totals event (the highest Over line that settled 'yes' + 0 gives a
        // floor; we record the market result rather than guessing an exact count).
        let finalGoals: number | null = null;
        if (order.marketType === 'total' && order.eventTicker) {
          try {
            const ev = await kalshiPublicFetch(`/events/${order.eventTicker}?with_nested_markets=true`, order.environment).catch(() => null);
            const evMarkets = ev?.event?.markets ?? ev?.markets ?? [];
            // Highest over-line that resolved yes => at least that many goals.
            let maxYesLine = -1;
            for (const m of evMarkets) {
              const sub = String(m?.yes_sub_title ?? '');
              const lm = sub.match(/over\s+([\d.]+)/i);
              if (lm && m?.result === 'yes') maxYesLine = Math.max(maxYesLine, Math.ceil(parseFloat(lm[1])));
            }
            if (maxYesLine >= 0) finalGoals = maxYesLine;
          } catch { /* ignore */ }
        }

        await prisma.goalsBetOrder.update({
          where: { id: order.id },
          data: {
            settledResult: won ? 'won' : 'lost',
            settledPayout: payoutCents,
            marketResult: result,
            finalGoals,
            netProfit,
          },
        });

        settledCount++;
        results.push({
          marketTicker: order.marketTicker,
          matchTitle: order.matchTitle,
          pick: order.pickLabel,
          won,
          payout: `$${(payoutCents / 100).toFixed(2)}`,
          netProfit: `$${(netProfit / 100).toFixed(2)}`,
        });
      } catch (err: any) {
        console.error(`[Goals Settle] Error for ${order.marketTicker}:`, err?.message);
        results.push({ marketTicker: order.marketTicker, status: 'error', error: err?.message });
      }
    }

    // Newly-settled outcomes change the learned model calibration, so refresh it
    // automatically (best-effort — never let a calibration failure break settlement).
    if (settledCount > 0) {
      try {
        await computeAndStoreCalibration(userId, 'global');
      } catch (e: any) {
        console.error('[Goals Settle] calibration recompute failed:', e?.message);
      }
    }

    return NextResponse.json({ settled: settledCount, total: pending.length, results });
  } catch (error: any) {
    console.error('[Goals Settle] Error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Settlement failed' }, { status: 500 });
  }
}

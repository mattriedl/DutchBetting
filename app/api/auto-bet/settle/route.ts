export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { kalshiPublicFetch } from '@/lib/kalshi-api';
import { fetchCF6Data, CITY_STATION_MAP } from '@/lib/nws-climate';

const DELAY_MS = 300;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * POST /api/auto-bet/settle — Check Kalshi for settled markets and resolve auto-bet orders.
 * 
 * For each unsettled order:
 *   1. Query Kalshi markets for the event_ticker
 *   2. If all markets settled, find the winning bin (result === 'yes')
 *   3. Check if any of our 3 bins matches the winner
 *   4. Calculate actual payout and P&L
 */
export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    // Find all unsettled orders (filled or partial, not already resolved)
    const unsettled = await prisma.autoBetOrder.findMany({
      where: {
        userId,
        status: { in: ['filled', 'partial', 'pending'] },
        OR: [
          { settledResult: null },
          { settledResult: 'pending' },
        ],
      },
    });

    if (unsettled.length === 0) {
      return NextResponse.json({ success: true, checked: 0, resolved: 0, message: 'No unsettled orders' });
    }

    let resolved = 0;
    let checked = 0;
    const errors: string[] = [];

    // Group by event ticker + environment to minimize API calls
    // (demo and production have separate market data)
    const byEvent: Record<string, typeof unsettled> = {};
    for (const order of unsettled) {
      const eventKey = `${order.eventTicker}__${order.environment ?? 'production'}`;
      if (!byEvent[eventKey]) byEvent[eventKey] = [];
      byEvent[eventKey].push(order);
    }

    // Pre-fetch NWS CF6 data for all cities that have unsettled orders
    const citiesNeeded = new Set(unsettled.map(o => o.city));
    const cf6Cache: Record<string, Record<string, { maxTemp: number | null; minTemp: number | null }>> = {};
    for (const city of citiesNeeded) {
      if (!CITY_STATION_MAP[city]) continue;
      try {
        const temps = await fetchCF6Data(city);
        if (temps.length > 0) {
          cf6Cache[city] = {};
          for (const t of temps) {
            cf6Cache[city][t.date] = { maxTemp: t.maxTemp, minTemp: t.minTemp };
          }
        }
        await sleep(200);
      } catch (e: any) {
        console.error(`CF6 fetch failed for ${city}:`, e?.message);
      }
    }
    console.log(`Fetched CF6 data for ${Object.keys(cf6Cache).length} cities`);

    for (const [eventKey, orders] of Object.entries(byEvent)) {
      const [eventTicker, orderEnv] = eventKey.split('__');
      checked++;
      await sleep(DELAY_MS);

      try {
        const result = await kalshiPublicFetch(
          `/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=50`,
          orderEnv ?? 'production'
        );
        const markets = result?.markets ?? [];

        // Check if the event has fully settled
        const allSettled = markets.length > 0 && markets.every((m: any) => m?.result === 'yes' || m?.result === 'no');
        if (!allSettled) continue;

        // Find the winning bin (result === 'yes')
        const winner = markets.find((m: any) => m?.result === 'yes');
        if (!winner) continue;

        // Build winning bin label
        let winningBinLabel = '';
        let kalshiFallbackTemp: number | null = null;
        if (winner.strike_type === 'between') {
          winningBinLabel = `${winner.floor_strike}-${winner.cap_strike}`;
          kalshiFallbackTemp = ((winner.floor_strike ?? 0) + (winner.cap_strike ?? 0)) / 2;
        } else if (winner.strike_type === 'less') {
          winningBinLabel = `≤${(winner.cap_strike ?? 0) - 1}`;
          kalshiFallbackTemp = (winner.cap_strike ?? 0) - 1;
        } else if (winner.strike_type === 'greater') {
          winningBinLabel = `≥${(winner.floor_strike ?? 0) + 1}`;
          kalshiFallbackTemp = (winner.floor_strike ?? 0) + 1;
        }

        // For each order on this event, check if any of our bins match the winner
        for (const order of orders) {
          // Try NWS CF6 for actual temp first, fall back to Kalshi bin midpoint
          let actualTemp: number | null = null;
          let tempSource = 'Kalshi-estimate';
          const cityObs = cf6Cache[order.city];
          const dateStr = order.forecastDate; // Already YYYY-MM-DD string
          if (cityObs && dateStr && cityObs[dateStr]) {
            actualTemp = order.marketType === 'high' ? cityObs[dateStr].maxTemp : cityObs[dateStr].minTemp;
            if (actualTemp != null) {
              tempSource = 'NWS-CF6';
              console.log(`${order.city} ${order.marketType} ${dateStr}: actual=${actualTemp}°F (NWS-CF6)`);
            }
          }
          if (actualTemp == null) {
            actualTemp = kalshiFallbackTemp;
            if (actualTemp != null) {
              console.log(`${order.city} ${order.marketType} ${dateStr}: actual≈${actualTemp}°F (Kalshi fallback)`);
            }
          }
          let bins: any[] = [];
          try { bins = JSON.parse(order.bins); } catch {}

          let won = false;
          let winningOrderBin: any = null;

          for (const bin of bins) {
            // Match by ticker
            if (bin.ticker && bin.ticker === winner.ticker) {
              won = true;
              winningOrderBin = bin;
              break;
            }
            // Match by range label
            if (bin.range && bin.range === winningBinLabel) {
              won = true;
              winningOrderBin = bin;
              break;
            }
            // Match by floor/cap for between bins
            if (winner.strike_type === 'between' && bin.range) {
              const rangeMatch = bin.range.match(/(\d+).*?(\d+)/);
              if (rangeMatch) {
                const rLow = parseInt(rangeMatch[1]);
                const rHigh = parseInt(rangeMatch[2]);
                if (rLow === winner.floor_strike && rHigh === winner.cap_strike) {
                  won = true;
                  winningOrderBin = bin;
                  break;
                }
              }
            }
          }

          // Calculate payout
          // If won: each contract in the winning bin pays $1 (100¢)
          // totalCost is already in cents
          // Payout = winningBin.count * 100 (cents) — each YES contract pays $1
          let settledPayoutCents = 0;
          if (won && winningOrderBin) {
            settledPayoutCents = (winningOrderBin.count ?? 0) * 100;
          }

          const netProfitCents = settledPayoutCents - (order.totalCost ?? 0);

          await prisma.autoBetOrder.update({
            where: { id: order.id },
            data: {
              settledResult: won ? 'won' : 'lost',
              settledPayout: settledPayoutCents,
              actualTemp: actualTemp ?? kalshiFallbackTemp,
              tempSource,
              winningBin: winningBinLabel,
              netProfit: netProfitCents,
            },
          });
          resolved++;
        }
      } catch (err: any) {
        if (err?.message?.includes?.('429')) await sleep(3000);
        errors.push(`${eventKey}: ${err?.message}`);
      }
    }

    return NextResponse.json({
      success: true,
      checked,
      resolved,
      remainingUnsettled: unsettled.length - resolved,
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
    });
  } catch (error: any) {
    console.error('AutoBet settle error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}

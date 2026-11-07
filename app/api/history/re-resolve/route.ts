export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { fetchAllObservedTemps } from '@/lib/nws-climate';

/**
 * POST /api/history/re-resolve
 * Re-resolves all previously resolved predictions using NWS CF6 official data.
 * Only updates predictions where CF6 data is available for their city+date.
 * Useful for replacing Kalshi bin midpoint estimates with exact NWS observed temps.
 */
export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Fetch CF6 data for all cities
    console.log('Re-resolve: Fetching NWS CF6 data for all cities...');
    const observedTemps = await fetchAllObservedTemps();
    const citiesWithData = Object.keys(observedTemps).length;
    const totalDays = Object.values(observedTemps).reduce((s, d) => s + Object.keys(d).length, 0);
    console.log(`Re-resolve: Got CF6 data for ${citiesWithData} cities, ${totalDays} day-records`);

    if (citiesWithData === 0) {
      return NextResponse.json({ success: false, error: 'No CF6 data available', updated: 0 });
    }

    // Find all resolved predictions (that could benefit from CF6 update)
    const resolved = await prisma.predictionHistory.findMany({
      where: {
        dutchBetResult: { in: ['won', 'lost'] },
      },
    });

    console.log(`Re-resolve: Found ${resolved.length} resolved predictions to check`);

    let updated = 0;
    let skipped = 0;
    let alreadyCf6 = 0;

    for (const pred of resolved) {
      const dateStr = pred.forecastDate?.toISOString?.().slice(0, 10) ?? '';
      const city = pred.city ?? '';
      const marketType = pred.marketType ?? 'high';

      // Skip if already resolved with CF6
      if (pred.tempSource === 'NWS-CF6') {
        alreadyCf6++;
        continue;
      }

      // Check if CF6 has data for this city+date
      const cityObs = observedTemps[city];
      const dayObs = cityObs?.[dateStr];
      if (!dayObs) {
        skipped++;
        continue;
      }

      const actualTemp = marketType === 'high' ? dayObs.maxTemp : dayObs.minTemp;
      if (actualTemp == null) {
        skipped++;
        continue;
      }

      // Re-calculate resolution with exact NWS temp
      const forecastError = actualTemp - (pred.nwsForecast ?? 0);
      const absError = Math.abs(forecastError);

      let wouldHaveWon = false;
      if (pred.dutchBetBins) {
        try {
          const bins = JSON.parse(pred.dutchBetBins as string) as { range: string }[];
          for (const bin of bins) {
            const m = bin.range.match(/(\d+).*?-.*?(\d+)/);
            if (m) {
              const lo = parseInt(m[1], 10);
              const hi = parseInt(m[2], 10);
              if (actualTemp >= lo && actualTemp <= hi) {
                wouldHaveWon = true;
                break;
              }
            }
          }
        } catch { /* ignore */ }
      } else if (pred.centerRange) {
        const rm = (pred.centerRange ?? '').match(/(\d+).*?-.*?(\d+)/);
        if (rm) {
          const cLow = parseInt(rm[1], 10);
          const cHigh = parseInt(rm[2], 10);
          const rw = cHigh - cLow;
          if (rw <= 2) {
            wouldHaveWon = actualTemp >= (cLow - 2) && actualTemp <= (cHigh + 2);
          } else {
            wouldHaveWon = actualTemp >= cLow && actualTemp <= cHigh;
          }
        }
      }

      await prisma.predictionHistory.update({
        where: { id: pred.id },
        data: {
          actualTemp,
          tempSource: 'NWS-CF6',
          forecastError,
          absError,
          wouldHaveWon,
          dutchBetResult: wouldHaveWon ? 'won' : 'lost',
          resolvedAt: new Date(),
        },
      });
      updated++;
    }

    console.log(`Re-resolve complete: ${updated} updated, ${skipped} skipped (no CF6), ${alreadyCf6} already CF6`);

    return NextResponse.json({
      success: true,
      updated,
      skipped,
      alreadyCf6,
      totalChecked: resolved.length,
    });
  } catch (error: any) {
    console.error('Re-resolve error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}

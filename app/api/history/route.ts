export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const city = url.searchParams.get('city');
    const marketType = url.searchParams.get('marketType') ?? 'all';
    const limit = parseInt(url.searchParams.get('limit') ?? '1000', 10);

    // Auto-resolve any pending predictions before returning history
    try {
      const { resolvePendingPredictions } = await import('@/lib/resolve-predictions');
      const resolvedCount = await resolvePendingPredictions();
      if (resolvedCount > 0) {
        console.log(`Auto-resolved ${resolvedCount} predictions on history page load`);
      }
    } catch (resolveErr: any) {
      console.error('Auto-resolve on history load failed:', resolveErr?.message);
    }

    const where: any = {};
    if (marketType && marketType !== 'all') where.marketType = marketType;
    if (city) where.city = city;

    const history = await prisma.predictionHistory.findMany({
      where,
      orderBy: { forecastDate: 'desc' },
      take: Math.min(limit, 500),
    });

    // Calculate accuracy stats by city
    const resolved = history.filter((h: any) => h?.actualTemp != null);
    const cityStats: Record<string, any> = {};

    for (const entry of resolved) {
      const c = entry?.city ?? 'Unknown';
      if (!cityStats[c]) {
        cityStats[c] = {
          city: c,
          totalPredictions: 0,
          within1Degree: 0,
          within2Degrees: 0,
          within3Degrees: 0,
          dutchBetWins: 0,
          avgAbsError: 0,
          totalAbsError: 0,
        };
      }
      cityStats[c].totalPredictions++;
      const absErr = entry?.absError ?? Math.abs((entry?.actualTemp ?? 0) - (entry?.nwsForecast ?? 0));
      cityStats[c].totalAbsError += absErr;
      if (absErr <= 1) cityStats[c].within1Degree++;
      if (absErr <= 2) cityStats[c].within2Degrees++;
      if (absErr <= 3) cityStats[c].within3Degrees++;
      if (entry?.wouldHaveWon) cityStats[c].dutchBetWins++;
    }

    // Compute averages
    for (const stats of Object.values(cityStats)) {
      const s = stats as any;
      if (s.totalPredictions > 0) {
        s.avgAbsError = Math.round((s.totalAbsError / s.totalPredictions) * 100) / 100;
        s.within1Rate = Math.round((s.within1Degree / s.totalPredictions) * 100);
        s.within2Rate = Math.round((s.within2Degrees / s.totalPredictions) * 100);
        s.within3Rate = Math.round((s.within3Degrees / s.totalPredictions) * 100);
        s.dutchWinRate = Math.round((s.dutchBetWins / s.totalPredictions) * 100);
      }
      delete s.totalAbsError;
    }

    return NextResponse.json({
      history: history.map((h: any) => ({
        ...h,
        forecastDate: h?.forecastDate?.toISOString?.() ?? '',
        resolvedAt: h?.resolvedAt?.toISOString?.() ?? null,
        createdAt: h?.createdAt?.toISOString?.() ?? '',
      })),
      cityStats: Object.values(cityStats),
      totalEntries: history.length,
      resolvedEntries: resolved.length,
    });
  } catch (error: any) {
    console.error('History GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST to update actual temperatures and resolve predictions
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { id, actualTemp } = body ?? {};

    if (!id || actualTemp == null) {
      return NextResponse.json({ error: 'ID and actual temperature required' }, { status: 400 });
    }

    const entry = await prisma.predictionHistory.findUnique({ where: { id } });
    if (!entry) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const forecastError = actualTemp - (entry?.nwsForecast ?? 0);
    const absError = Math.abs(forecastError);

    // Determine if the dutch bet would have won by checking all 3 bins
    let wouldHaveWon = false;
    if (entry?.dutchBetBins) {
      try {
        const bins = JSON.parse(entry.dutchBetBins as string) as { range: string }[];
        for (const bin of bins) {
          const rm = bin.range.match(/(\d+).*?-.*?(\d+)/);
          if (rm && actualTemp >= parseInt(rm[1], 10) && actualTemp <= parseInt(rm[2], 10)) {
            wouldHaveWon = true;
            break;
          }
        }
      } catch {}
    } else if (entry?.centerRange) {
      const rm = (entry.centerRange ?? '').match(/(\d+).*?-.*?(\d+)/);
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

    const updated = await prisma.predictionHistory.update({
      where: { id },
      data: {
        actualTemp,
        forecastError,
        absError,
        wouldHaveWon,
        dutchBetResult: wouldHaveWon ? 'won' : 'lost',
        resolvedAt: new Date(),
      },
    });

    return NextResponse.json({
      ...updated,
      forecastDate: updated?.forecastDate?.toISOString?.() ?? '',
      resolvedAt: updated?.resolvedAt?.toISOString?.() ?? null,
      createdAt: updated?.createdAt?.toISOString?.() ?? '',
    });
  } catch (error: any) {
    console.error('History POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

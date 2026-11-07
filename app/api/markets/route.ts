export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const markets = await prisma.marketData.findMany({
      orderBy: [{ city: 'asc' }, { tempRangeLow: 'asc' }],
    });

    // Group by city
    const grouped: Record<string, any> = {};
    (markets ?? []).forEach((m: any) => {
      const key = m?.city ?? 'Unknown';
      if (!grouped[key]) {
        grouped[key] = {
          city: m?.city ?? 'Unknown',
          state: m?.state ?? '',
          eventTicker: m?.eventTicker ?? '',
          expirationTime: m?.expirationTime?.toISOString?.() ?? '',
          markets: [],
        };
      }
      grouped[key].markets.push({
        id: m?.id ?? '',
        kalshiMarketId: m?.kalshiMarketId ?? '',
        tempRangeLow: m?.tempRangeLow ?? 0,
        tempRangeHigh: m?.tempRangeHigh ?? 0,
        yesPrice: m?.yesPrice ?? 0,
        yesBid: m?.yesBid ?? 0,
        yesAsk: m?.yesAsk ?? 0,
        lastPrice: m?.lastPrice ?? 0,
        noPrice: m?.noPrice ?? 0,
        volume: m?.volume ?? 0,
        openInterest: m?.openInterest ?? 0,
        lastUpdated: m?.lastUpdated?.toISOString?.() ?? '',
      });
    });

    return NextResponse.json({ cities: Object.values(grouped) });
  } catch (error: any) {
    console.error('Markets GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

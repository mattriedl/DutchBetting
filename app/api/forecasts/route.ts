export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const forecasts = await prisma.nwsForecast.findMany({
      orderBy: { forecastDate: 'asc' },
    });

    // Get the soonest forecast per city (today's if available, otherwise tomorrow's)
    const latestByCity: Record<string, any> = {};
    (forecasts ?? []).forEach((f: any) => {
      const key = f?.city ?? 'Unknown';
      if (!latestByCity[key]) {
        latestByCity[key] = {
          id: f?.id ?? '',
          city: f?.city ?? '',
          state: f?.state ?? '',
          forecastHigh: f?.forecastHigh ?? null,
          forecastLow: f?.forecastLow ?? null,
          forecastDate: f?.forecastDate?.toISOString?.() ?? '',
          retrievedAt: f?.retrievedAt?.toISOString?.() ?? '',
          confidence: f?.confidence ?? 'normal',
        };
      }
    });

    return NextResponse.json({ forecasts: Object.values(latestByCity) });
  } catch (error: any) {
    console.error('Forecasts GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

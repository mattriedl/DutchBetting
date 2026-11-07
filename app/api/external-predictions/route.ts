export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { getSourceAccuracy, EXT_SOURCES } from '@/lib/external-predictions';

/**
 * GET /api/external-predictions?status=all|open|settled&source=
 * Returns tracked third-party predictions plus the per-source accuracy scoreboard.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const status = req.nextUrl.searchParams.get('status') ?? 'all';
    const source = req.nextUrl.searchParams.get('source') ?? '';

    const where: any = {};
    if (status === 'open' || status === 'settled' || status === 'void') where.status = status;
    if (source) where.source = source;

    const [predictions, accuracy] = await Promise.all([
      prisma.externalPrediction.findMany({
        where,
        orderBy: [{ matchDate: 'desc' }, { fetchedAt: 'desc' }],
        take: 300,
      }),
      getSourceAccuracy(),
    ]);

    return NextResponse.json({
      predictions,
      accuracy,
      sources: EXT_SOURCES,
      footystatsConfigured: !!process.env.FOOTYSTATS_API_KEY,
      apiFootballConfigured: !!process.env.API_FOOTBALL_KEY,
    });
  } catch (error: any) {
    console.error('[ExternalPredictions API] GET error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Failed to load predictions' }, { status: 500 });
  }
}

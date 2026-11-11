export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { getShadowStats, SHADOW_STAKE_DOLLARS, SHADOW_MIN_EDGE_CENTS, SHADOW_MIN_PROB, lastShadowRun } from '@/lib/shadow-analyst';

/**
 * GET /api/shadow?status=all|open|settled
 * Returns the autonomous AI shadow picks plus their realized ROI / accuracy.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const status = req.nextUrl.searchParams.get('status') ?? 'all';
    const where: any = {};
    if (status === 'open' || status === 'settled') where.status = status;

    const [picks, stats] = await Promise.all([
      prisma.shadowPick.findMany({
        where,
        orderBy: [{ status: 'asc' }, { matchDate: 'desc' }, { createdAt: 'desc' }],
        take: 300,
      }),
      getShadowStats(),
    ]);

    return NextResponse.json({
      picks,
      stats,
      config: {
        stakeDollars: SHADOW_STAKE_DOLLARS,
        minEdgeCents: SHADOW_MIN_EDGE_CENTS,
        minProb: SHADOW_MIN_PROB,
        // Set on hosts where a scheduler calls /api/shadow/run (e.g. "every hour"); null = manual only.
        autoRun: process.env.SHADOW_AUTORUN_LABEL || null,
        lastRun: lastShadowRun,
      },
    });
  } catch (error: any) {
    console.error('[Shadow API] GET error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Failed to load shadow picks' }, { status: 500 });
  }
}

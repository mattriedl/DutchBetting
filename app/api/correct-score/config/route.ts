export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';

const DEFAULTS = {
  enabled: false,
  mode: 'one-click',
  minProfitMargin: 3.0,
  maxPicks: 6,
  minPicks: 5,
  minStakePerBet: 2.0,
  maxStakePerBet: 5.0,
  maxDailySpend: 50.0,
  slippageCents: 1,
  minResearchScore: 0.0,
  minEdgeCents: 2.0,
  minLowScore: 0,
  environment: 'demo',
  paperMode: false,
};

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const config = await prisma.correctScoreConfig.findUnique({ where: { userId } });
    return NextResponse.json({ config: config ?? DEFAULTS });
  } catch (error: any) {
    console.error('[CorrectScore] Config GET error:', error?.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const body = await req.json();
    const data = {
      enabled: body?.enabled ?? DEFAULTS.enabled,
      mode: body?.mode ?? DEFAULTS.mode,
      minProfitMargin: body?.minProfitMargin ?? DEFAULTS.minProfitMargin,
      maxPicks: body?.maxPicks ?? DEFAULTS.maxPicks,
      minPicks: body?.minPicks ?? DEFAULTS.minPicks,
      minStakePerBet: body?.minStakePerBet ?? DEFAULTS.minStakePerBet,
      maxStakePerBet: body?.maxStakePerBet ?? DEFAULTS.maxStakePerBet,
      maxDailySpend: body?.maxDailySpend ?? DEFAULTS.maxDailySpend,
      slippageCents: body?.slippageCents ?? DEFAULTS.slippageCents,
      minResearchScore: body?.minResearchScore ?? DEFAULTS.minResearchScore,
      minEdgeCents: body?.minEdgeCents ?? DEFAULTS.minEdgeCents,
      minLowScore: body?.minLowScore ?? DEFAULTS.minLowScore,
      environment: body?.environment ?? DEFAULTS.environment,
      paperMode: body?.paperMode ?? DEFAULTS.paperMode,
    };

    const config = await prisma.correctScoreConfig.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });

    return NextResponse.json({ config });
  } catch (error: any) {
    console.error('[CorrectScore] Config POST error:', error?.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';

const DEFAULTS = {
  enabled: false,
  minStakePerBet: 2.0,
  maxStakePerBet: 5.0,
  maxDailySpend: 50.0,
  slippageCents: 1,
  minEdgeCents: 3.0,
  minLowScore: 0,
  lowScoringOnly: true,
  environment: 'demo',
  paperMode: true,
};

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;
    const config = await prisma.goalsMarketConfig.findUnique({ where: { userId } });
    return NextResponse.json({ config: config ?? DEFAULTS });
  } catch (error: any) {
    console.error('[Goals] Config GET error:', error?.message);
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
      minStakePerBet: body?.minStakePerBet ?? DEFAULTS.minStakePerBet,
      maxStakePerBet: body?.maxStakePerBet ?? DEFAULTS.maxStakePerBet,
      maxDailySpend: body?.maxDailySpend ?? DEFAULTS.maxDailySpend,
      slippageCents: body?.slippageCents ?? DEFAULTS.slippageCents,
      minEdgeCents: body?.minEdgeCents ?? DEFAULTS.minEdgeCents,
      minLowScore: body?.minLowScore ?? DEFAULTS.minLowScore,
      lowScoringOnly: body?.lowScoringOnly ?? DEFAULTS.lowScoringOnly,
      environment: body?.environment ?? DEFAULTS.environment,
      paperMode: body?.paperMode ?? DEFAULTS.paperMode,
    };

    const config = await prisma.goalsMarketConfig.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });

    return NextResponse.json({ config });
  } catch (error: any) {
    console.error('[Goals] Config POST error:', error?.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

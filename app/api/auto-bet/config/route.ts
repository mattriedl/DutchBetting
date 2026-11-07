export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const config = await prisma.autoBetConfig.findUnique({ where: { userId } });

    return NextResponse.json({
      config: config ?? {
        enabled: false,
        mode: 'one-click',
        minProfitMargin: 5.0,
        minRating: 'good',
        maxStakePerBet: 10.0,
        maxDailySpend: 100.0,
        slippageCents: 2,
        environment: 'demo',
      },
    });
  } catch (error: any) {
    console.error('AutoBet config GET error:', error?.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const body = await req.json();
    const {
      enabled,
      mode,
      minProfitMargin,
      minRating,
      maxStakePerBet,
      maxDailySpend,
      slippageCents,
      environment,
    } = body ?? {};

    const config = await prisma.autoBetConfig.upsert({
      where: { userId },
      update: {
        enabled: enabled ?? false,
        mode: mode ?? 'one-click',
        minProfitMargin: minProfitMargin ?? 5.0,
        minRating: minRating ?? 'good',
        maxStakePerBet: maxStakePerBet ?? 10.0,
        maxDailySpend: maxDailySpend ?? 100.0,
        slippageCents: slippageCents ?? 2,
        environment: environment ?? 'demo',
      },
      create: {
        userId,
        enabled: enabled ?? false,
        mode: mode ?? 'one-click',
        minProfitMargin: minProfitMargin ?? 5.0,
        minRating: minRating ?? 'good',
        maxStakePerBet: maxStakePerBet ?? 10.0,
        maxDailySpend: maxDailySpend ?? 100.0,
        slippageCents: slippageCents ?? 2,
        environment: environment ?? 'demo',
      },
    });

    return NextResponse.json({ config });
  } catch (error: any) {
    console.error('AutoBet config POST error:', error?.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

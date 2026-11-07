export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any)?.id;

    const opportunities = await prisma.opportunity.findMany({
      where: { userId },
      include: { betPlacements: true },
      orderBy: { analyzedAt: 'desc' },
    });

    return NextResponse.json({
      opportunities: (opportunities ?? []).map((o: any) => ({
        ...o,
        analyzedAt: o?.analyzedAt?.toISOString?.() ?? '',
        expirationTime: o?.expirationTime?.toISOString?.() ?? '',
        createdAt: o?.createdAt?.toISOString?.() ?? '',
        betPlacements: (o?.betPlacements ?? []).map((b: any) => ({
          ...b,
          placedAt: b?.placedAt?.toISOString?.() ?? null,
          createdAt: b?.createdAt?.toISOString?.() ?? '',
          updatedAt: b?.updatedAt?.toISOString?.() ?? '',
        })),
      })),
    });
  } catch (error: any) {
    console.error('Opportunities GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any)?.id;
    const body = await req.json();

    const opportunity = await prisma.opportunity.create({
      data: {
        userId,
        city: body?.city ?? '',
        state: body?.state ?? '',
        nwsForecast: body?.nwsForecast ?? 0,
        totalStake: body?.totalStake ?? 10,
        guaranteedReturn: body?.guaranteedReturn ?? 0,
        profitMargin: body?.profitMargin ?? 0,
        position1Ticker: body?.position1Ticker ?? '',
        position1Range: body?.position1Range ?? '',
        position1Odds: body?.position1Odds ?? 0,
        position1Stake: body?.position1Stake ?? 0,
        position2Ticker: body?.position2Ticker ?? '',
        position2Range: body?.position2Range ?? '',
        position2Odds: body?.position2Odds ?? 0,
        position2Stake: body?.position2Stake ?? 0,
        position3Ticker: body?.position3Ticker ?? '',
        position3Range: body?.position3Range ?? '',
        position3Odds: body?.position3Odds ?? 0,
        position3Stake: body?.position3Stake ?? 0,
        expirationTime: body?.expirationTime ? new Date(body.expirationTime) : new Date(),
      },
    });

    return NextResponse.json({ opportunity }, { status: 201 });
  } catch (error: any) {
    console.error('Opportunities POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

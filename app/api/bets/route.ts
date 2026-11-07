export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any)?.id;
    const body = await req.json();
    const { betId, isPlaced, notes } = body ?? {};

    if (!betId) return NextResponse.json({ error: 'Bet ID required' }, { status: 400 });

    const bet = await prisma.betPlacement.findFirst({ where: { id: betId, userId } });
    if (!bet) return NextResponse.json({ error: 'Bet not found' }, { status: 404 });

    const updated = await prisma.betPlacement.update({
      where: { id: betId },
      data: {
        isPlaced: isPlaced ?? bet.isPlaced,
        placedAt: isPlaced ? new Date() : null,
        notes: notes ?? bet.notes,
      },
    });

    return NextResponse.json({ bet: { ...updated, placedAt: updated?.placedAt?.toISOString?.() ?? null, createdAt: updated?.createdAt?.toISOString?.() ?? '', updatedAt: updated?.updatedAt?.toISOString?.() ?? '' } });
  } catch (error: any) {
    console.error('Bets PATCH error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

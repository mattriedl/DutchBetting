export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';

/** GET /api/goals/orders — list this user's goals bets with summary stats. */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const orders = await prisma.goalsBetOrder.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const settled = orders.filter(o => o.settledResult === 'won' || o.settledResult === 'lost');
    const won = settled.filter(o => o.settledResult === 'won');
    const totalCost = settled.reduce((s, o) => s + (o.totalCost ?? 0), 0);
    const totalPayout = settled.reduce((s, o) => s + (o.settledPayout ?? 0), 0);
    const netProfit = totalPayout - totalCost;
    const roi = totalCost > 0 ? (netProfit / totalCost) * 100 : 0;

    const summary = {
      total: orders.length,
      pending: orders.filter(o => o.settledResult === 'pending').length,
      settled: settled.length,
      won: won.length,
      lost: settled.length - won.length,
      winRate: settled.length > 0 ? Math.round((won.length / settled.length) * 1000) / 10 : 0,
      netProfit: Math.round(netProfit) / 100,
      roi: Math.round(roi * 10) / 10,
    };

    return NextResponse.json({ orders, summary });
  } catch (error: any) {
    console.error('[Goals] Orders error:', error?.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

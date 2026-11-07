export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';

/**
 * GET /api/polymarket-cs/orders
 * Return all Polymarket exact-score bet orders for the logged-in user + stats.
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const orders = await prisma.polymarketBetOrder.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const filled = orders.filter(o => o.status === 'filled' || o.status === 'partial');
    const settled = orders.filter(o => o.settledResult === 'won' || o.settledResult === 'lost');
    const won = orders.filter(o => o.settledResult === 'won');
    const lost = orders.filter(o => o.settledResult === 'lost');
    const totalWagered = filled.reduce((s, o) => s + (o.totalCost ?? 0), 0);
    const totalPayouts = won.reduce((s, o) => s + (o.settledPayout ?? 0), 0);
    const totalPL = settled.reduce((s, o) => s + (o.netProfit ?? 0), 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todaySpent = filled.filter(o => new Date(o.createdAt) >= today)
      .reduce((s, o) => s + (o.totalCost ?? 0), 0);

    return NextResponse.json({
      orders,
      stats: {
        totalOrders: orders.length,
        filledCount: filled.length,
        wonCount: won.length,
        lostCount: lost.length,
        pendingCount: orders.filter(o => o.settledResult === 'pending').length,
        totalWagered,
        totalPayouts,
        totalPL,
        winRate: settled.length > 0 ? Math.round((won.length / settled.length) * 100) : 0,
        roi: totalWagered > 0 ? Math.round((totalPL / totalWagered) * 10000) / 100 : 0,
        todaySpent,
      },
    });
  } catch (error: any) {
    console.error('[Polymarket] Orders error:', error?.message);
    return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
  }
}

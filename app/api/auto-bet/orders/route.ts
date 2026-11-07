export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
    const status = url.searchParams.get('status');

    const where: any = { userId };
    if (status) where.status = status;

    const orders = await prisma.autoBetOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
    });

    // Calculate daily spend
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dailyOrders = await prisma.autoBetOrder.findMany({
      where: {
        userId,
        createdAt: { gte: today },
        status: { in: ['filled', 'partial'] },
      },
      select: { totalCost: true },
    });
    const dailySpent = dailyOrders.reduce((sum, o) => sum + (o.totalCost ?? 0), 0) / 100;

    // === Comprehensive Stats ===
    const allOrders = await prisma.autoBetOrder.findMany({
      where: { userId },
      select: {
        status: true,
        totalCost: true,
        totalStake: true,
        expectedPayout: true,
        settledResult: true,
        settledPayout: true,
        netProfit: true,
        profitMargin: true,
        city: true,
        marketType: true,
        environment: true,
        createdAt: true,
      },
    });

    const totalOrders = allOrders.length;
    const filledOrders = allOrders.filter(o => o.status === 'filled' || o.status === 'partial');
    const settledOrders = allOrders.filter(o => o.settledResult === 'won' || o.settledResult === 'lost');
    const wonOrders = allOrders.filter(o => o.settledResult === 'won');
    const lostOrders = allOrders.filter(o => o.settledResult === 'lost');
    const pendingSettlement = allOrders.filter(o => 
      (o.status === 'filled' || o.status === 'partial') && 
      (!o.settledResult || o.settledResult === 'pending')
    );

    // Financial stats (all in cents, convert to dollars for display)
    const totalWagered = filledOrders.reduce((s, o) => s + (o.totalCost ?? 0), 0); // cents
    const totalPayouts = wonOrders.reduce((s, o) => s + (o.settledPayout ?? 0), 0); // cents
    const totalPnL = settledOrders.reduce((s, o) => s + (o.netProfit ?? 0), 0); // cents
    const avgCostPerBet = filledOrders.length > 0 ? totalWagered / filledOrders.length : 0;
    const winRate = settledOrders.length > 0 ? (wonOrders.length / settledOrders.length) * 100 : 0;
    const roi = totalWagered > 0 ? (totalPnL / totalWagered) * 100 : 0;

    // Best and worst bets
    const settledWithProfit = settledOrders
      .filter(o => o.netProfit != null)
      .sort((a, b) => (b.netProfit ?? 0) - (a.netProfit ?? 0));
    const bestBet = settledWithProfit.length > 0 ? settledWithProfit[0] : null;
    const worstBet = settledWithProfit.length > 0 ? settledWithProfit[settledWithProfit.length - 1] : null;

    // Per-city breakdown
    const cityMap: Record<string, { wagered: number; pnl: number; wins: number; losses: number; total: number }> = {};
    for (const o of settledOrders) {
      if (!cityMap[o.city]) cityMap[o.city] = { wagered: 0, pnl: 0, wins: 0, losses: 0, total: 0 };
      cityMap[o.city].wagered += o.totalCost ?? 0;
      cityMap[o.city].pnl += o.netProfit ?? 0;
      cityMap[o.city].total++;
      if (o.settledResult === 'won') cityMap[o.city].wins++;
      else cityMap[o.city].losses++;
    }
    const cityStats = Object.entries(cityMap)
      .map(([city, s]) => ({
        city,
        wagered: Math.round(s.wagered) / 100,
        pnl: Math.round(s.pnl) / 100,
        wins: s.wins,
        losses: s.losses,
        total: s.total,
        winRate: s.total > 0 ? Math.round((s.wins / s.total) * 1000) / 10 : 0,
        roi: s.wagered > 0 ? Math.round((s.pnl / s.wagered) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.pnl - a.pnl);

    // Streak tracking
    const settledChronological = [...settledOrders].sort((a, b) => 
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    let currentStreak = 0;
    let currentStreakType: 'win' | 'loss' | null = null;
    let longestWinStreak = 0;
    let longestLossStreak = 0;
    let tempWinStreak = 0;
    let tempLossStreak = 0;
    for (const o of settledChronological) {
      if (o.settledResult === 'won') {
        tempWinStreak++;
        tempLossStreak = 0;
        if (tempWinStreak > longestWinStreak) longestWinStreak = tempWinStreak;
      } else {
        tempLossStreak++;
        tempWinStreak = 0;
        if (tempLossStreak > longestLossStreak) longestLossStreak = tempLossStreak;
      }
    }
    // Current streak
    for (let i = settledChronological.length - 1; i >= 0; i--) {
      const r = settledChronological[i].settledResult;
      if (currentStreakType === null) {
        currentStreakType = r === 'won' ? 'win' : 'loss';
        currentStreak = 1;
      } else if ((r === 'won' && currentStreakType === 'win') || (r === 'lost' && currentStreakType === 'loss')) {
        currentStreak++;
      } else {
        break;
      }
    }

    return NextResponse.json({
      orders: orders.map((o: any) => ({
        ...o,
        createdAt: o.createdAt?.toISOString?.() ?? '',
        updatedAt: o.updatedAt?.toISOString?.() ?? '',
      })),
      dailySpent,
      stats: {
        total: totalOrders,
        filled: filledOrders.length,
        won: wonOrders.length,
        lost: lostOrders.length,
        settled: settledOrders.length,
        pendingSettlement: pendingSettlement.length,
        // Financial (all in dollars)
        totalWagered: Math.round(totalWagered) / 100,
        totalPayouts: Math.round(totalPayouts) / 100,
        totalPnL: Math.round(totalPnL) / 100,
        avgCostPerBet: Math.round(avgCostPerBet) / 100,
        winRate: Math.round(winRate * 10) / 10,
        roi: Math.round(roi * 10) / 10,
        // Best/worst
        bestBet: bestBet ? { city: bestBet.city, profit: Math.round((bestBet.netProfit ?? 0)) / 100 } : null,
        worstBet: worstBet ? { city: worstBet.city, profit: Math.round((worstBet.netProfit ?? 0)) / 100 } : null,
        // Streaks
        currentStreak,
        currentStreakType,
        longestWinStreak,
        longestLossStreak,
        // Per-city
        cityStats,
      },
    });
  } catch (error: any) {
    console.error('AutoBet orders GET error:', error?.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

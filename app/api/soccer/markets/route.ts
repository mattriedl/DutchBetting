export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { fetchSoccerMatches, analyzeSoccerDutch, calculateSoccerStake } from '@/lib/soccer-dutch';

/**
 * GET /api/soccer/markets
 * Fetches all open soccer matches from Kalshi and returns Dutch bet analysis.
 * Query params:
 *   - stake: total stake per bet in dollars (default 10)
 *   - minMargin: minimum dutch margin % to include (default 0)
 *   - league: filter by league (default 'all')
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const stake = parseFloat(url?.searchParams?.get?.('stake') ?? '10') || 10;
    const minMargin = parseFloat(url?.searchParams?.get?.('minMargin') ?? '0') || 0;
    const leagueFilter = url?.searchParams?.get?.('league') ?? 'all';
    const slippage = parseInt(url?.searchParams?.get?.('slippage') ?? '2', 10) || 2;

    // Fetch all open soccer matches
    const matches = await fetchSoccerMatches('production');
    console.log(`[Soccer API] Fetched ${matches.length} total matches`);

    // Analyze each match
    let analyses = matches.map(match => {
      const analysis = analyzeSoccerDutch(match);
      const stakeCalc = calculateSoccerStake(analysis, stake, slippage);
      return { ...analysis, stakeCalc };
    });

    // Filter by league
    if (leagueFilter !== 'all') {
      analyses = analyses.filter(a => a.match.league === leagueFilter);
    }

    // Filter by minimum margin
    if (minMargin > 0) {
      analyses = analyses.filter(a => a.dutchMargin >= minMargin);
    }

    // Sort by dutch margin descending (best opportunities first)
    analyses.sort((a, b) => b.dutchMargin - a.dutchMargin);

    // Get unique leagues for filter dropdown
    const leagues = [...new Set(matches.map(m => m.league))];

    const summary = {
      totalMatches: analyses.length,
      viableCount: analyses.filter(a => a.isViable).length,
      excellentCount: analyses.filter(a => a.rating === 'excellent').length,
      goodCount: analyses.filter(a => a.rating === 'good').length,
      marginalCount: analyses.filter(a => a.rating === 'marginal').length,
      bestMargin: analyses[0]?.dutchMargin ?? 0,
      avgMargin: analyses.length > 0
        ? Math.round(analyses.reduce((s, a) => s + a.dutchMargin, 0) / analyses.length * 100) / 100
        : 0,
      leagues,
    };

    return NextResponse.json({ analyses, summary });
  } catch (error: any) {
    console.error('[Soccer API] Markets error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Failed to fetch soccer markets' }, { status: 500 });
  }
}

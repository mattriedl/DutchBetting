export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { fetchCorrectScoreMatches, analyzeCorrectScore } from '@/lib/correct-score';

/**
 * GET /api/correct-score/markets
 * Fetch all open exact-score match events and return Dutch basket analysis.
 * Query params:
 *   - minMargin: minimum recommended Dutch margin % to include (default 0)
 *   - league: filter by league (default 'all')
 *   - minPicks / maxPicks: basket size window (default 4 / 6)
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const minMargin = parseFloat(url?.searchParams?.get?.('minMargin') ?? '0') || 0;
    const leagueFilter = url?.searchParams?.get?.('league') ?? 'all';
    const minPicks = parseInt(url?.searchParams?.get?.('minPicks') ?? '4', 10) || 4;
    const maxPicks = parseInt(url?.searchParams?.get?.('maxPicks') ?? '6', 10) || 6;

    const matches = await fetchCorrectScoreMatches('production');
    console.log(`[CorrectScore API] Fetched ${matches.length} exact-score matches`);

    let analyses = matches.map(m => analyzeCorrectScore(m, { minPicks, maxPicks }));

    if (leagueFilter !== 'all') {
      analyses = analyses.filter(a => a.match.league === leagueFilter);
    }
    if (minMargin > 0) {
      // Browse view: a recommendation is only made AFTER research prices a real
      // edge, so filter on the best available basket margin, not the gated
      // recommendation (otherwise the whole board would disappear pre-research).
      analyses = analyses.filter(a => a.bestMargin >= minMargin);
    }

    // Sort by best available basket margin desc (best opportunities first).
    analyses.sort((a, b) => b.bestMargin - a.bestMargin);

    const leagues = [...new Set(matches.map(m => m.league))];
    const margins = analyses.map(a => a.bestMargin);

    const summary = {
      totalMatches: analyses.length,
      viableCount: analyses.filter(a => a.baskets.length > 0).length,
      excellentCount: analyses.filter(a => a.rating === 'excellent').length,
      goodCount: analyses.filter(a => a.rating === 'good').length,
      marginalCount: analyses.filter(a => a.rating === 'marginal').length,
      bestMargin: margins.length ? Math.max(...margins) : 0,
      avgMargin: margins.length
        ? Math.round((margins.reduce((s, m) => s + m, 0) / margins.length) * 100) / 100
        : 0,
      leagues,
    };

    return NextResponse.json({ analyses, summary });
  } catch (error: any) {
    console.error('[CorrectScore API] Markets error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Failed to fetch markets' }, { status: 500 });
  }
}

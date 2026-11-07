export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { fetchGoalsMatches, analyzeGoals, type GoalsMatch } from '@/lib/goals-markets';
import { fetchPolymarketGoalsMatches } from '@/lib/polymarket-goals';

/**
 * GET /api/goals/markets
 * Fetch all open BTTS + Total-Goals match markets and return a pre-research
 * directional analysis (no model edge until Research is run per match).
 * Query params:
 *   - league: filter by league (default 'all')
 *   - source: kalshi | polymarket | both (default 'kalshi')
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const leagueFilter = url?.searchParams?.get?.('league') ?? 'all';
    const source = (url?.searchParams?.get?.('source') ?? 'kalshi').toLowerCase();

    const tasks: Promise<GoalsMatch[]>[] = [];
    if (source === 'kalshi' || source === 'both') {
      tasks.push(fetchGoalsMatches('production').catch(e => { console.error('[Goals API] Kalshi fetch error:', e?.message); return []; }));
    }
    if (source === 'polymarket' || source === 'both') {
      tasks.push(fetchPolymarketGoalsMatches().catch(e => { console.error('[Goals API] Polymarket fetch error:', e?.message); return []; }));
    }
    const matches = (await Promise.all(tasks)).flat();
    console.log(`[Goals API] Fetched ${matches.length} goals-market matches (source=${source})`);

    let analyses = matches.map(m => analyzeGoals(m, {}));

    if (leagueFilter !== 'all') {
      analyses = analyses.filter(a => a.match.league === leagueFilter);
    }

    // Sort by soonest kickoff (date asc, then league).
    analyses.sort((a, b) => {
      const d = (a.match.matchDate || '').localeCompare(b.match.matchDate || '');
      if (d !== 0) return d;
      return a.match.league.localeCompare(b.match.league);
    });

    const leagues = [...new Set(matches.map(m => m.league))].sort();
    const summary = {
      totalMatches: analyses.length,
      bttsCount: analyses.filter(a => !!a.match.btts).length,
      totalsCount: analyses.filter(a => a.match.totalLadder.length > 0).length,
      kalshiCount: analyses.filter(a => (a.match.source ?? 'kalshi') === 'kalshi').length,
      polymarketCount: analyses.filter(a => a.match.source === 'polymarket').length,
      leagues,
    };

    return NextResponse.json({ analyses, summary });
  } catch (error: any) {
    console.error('[Goals API] Markets error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Failed to fetch markets' }, { status: 500 });
  }
}

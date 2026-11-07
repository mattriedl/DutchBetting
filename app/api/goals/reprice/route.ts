export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { fetchGoalsMatchByKey, analyzeGoals } from '@/lib/goals-markets';
import { fetchPolymarketGoalsMatchByKey } from '@/lib/polymarket-goals';
import { getActiveCalibration } from '@/lib/calibration';

/**
 * POST /api/goals/reprice
 * Lightweight price refresh for a single match. Re-fetches the CURRENT live
 * market prices and re-runs the directional analysis WITHOUT re-running the
 * expensive LLM/Poisson research — the previously-computed model probabilities
 * (bttsYesProb / overProbByLine / expectedTotalGoals / lowScore) are supplied by
 * the caller and reused. This lets the user snap a single card's prices and
 * edges back to the live market right before placing a bet, without waiting for
 * a full research pass or disturbing the other matches on the board.
 *
 * Body: {
 *   matchKey, source?('kalshi'|'polymarket'),
 *   minEdge?, minLowScore?, lowScoringOnly?,
 *   bttsYesProb?, overProbByLine?, expectedTotalGoals?, lowScore?
 * }
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const {
      matchKey, source, minEdge, minLowScore, lowScoringOnly,
      bttsYesProb, overProbByLine, expectedTotalGoals, lowScore,
    } = body ?? {};
    if (!matchKey) return NextResponse.json({ error: 'Missing matchKey' }, { status: 400 });

    const match = source === 'polymarket'
      ? await fetchPolymarketGoalsMatchByKey(matchKey)
      : await fetchGoalsMatchByKey(matchKey, 'production');
    if (!match) return NextResponse.json({ error: 'Match not found or markets closed' }, { status: 404 });

    const calibration = await getActiveCalibration('global').catch(() => null);

    const analysis = analyzeGoals(match, {
      calibration,
      minEdge: typeof minEdge === 'number' ? minEdge : 3,
      minLowScore: typeof minLowScore === 'number' ? minLowScore : 0,
      lowScoringOnly: typeof lowScoringOnly === 'boolean' ? lowScoringOnly : true,
      lowScore: typeof lowScore === 'number' ? lowScore : undefined,
      expectedTotalGoals: typeof expectedTotalGoals === 'number' ? expectedTotalGoals : undefined,
      bttsYesProb: typeof bttsYesProb === 'number' ? bttsYesProb : undefined,
      overProbByLine: overProbByLine && typeof overProbByLine === 'object' ? overProbByLine : undefined,
    });

    return NextResponse.json({ analysis, pricedAt: new Date().toISOString() });
  } catch (error: any) {
    console.error('[Goals API] Reprice error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Reprice failed' }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { fetchGoalsMatchByKey, analyzeGoals } from '@/lib/goals-markets';
import { fetchPolymarketGoalsMatchByKey } from '@/lib/polymarket-goals';
import { researchGoalsMatch } from '@/lib/goals-research';
import { getActiveCalibration } from '@/lib/calibration';

/**
 * POST /api/goals/research
 * Run the Poisson+LLM goals model for a single match and return a model-priced
 * directional analysis for its BTTS and Over/Under markets.
 * Body: { matchKey, minEdge?, minLowScore?, lowScoringOnly? }
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { matchKey, minEdge, minLowScore, lowScoringOnly, source } = body ?? {};
    if (!matchKey) return NextResponse.json({ error: 'Missing matchKey' }, { status: 400 });

    const match = source === 'polymarket'
      ? await fetchPolymarketGoalsMatchByKey(matchKey)
      : await fetchGoalsMatchByKey(matchKey, 'production');
    if (!match) return NextResponse.json({ error: 'Match not found or no open goals markets' }, { status: 404 });

    const research = await researchGoalsMatch(match);
    const lowScore = research.lowScoring?.dataAvailable ? research.lowScoring.score : undefined;
    const calibration = await getActiveCalibration('global').catch(() => null);

    const analysis = analyzeGoals(match, {
      calibration,
      minEdge: typeof minEdge === 'number' ? minEdge : 3,
      minLowScore: typeof minLowScore === 'number' ? minLowScore : 0,
      lowScoringOnly: typeof lowScoringOnly === 'boolean' ? lowScoringOnly : true,
      lowScore,
      expectedTotalGoals: research.expectedTotalGoals,
      bttsYesProb: research.bttsYesProb,
      overProbByLine: research.overProbByLine,
    });

    return NextResponse.json({ analysis, research });
  } catch (error: any) {
    console.error('[Goals API] Research error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Research failed' }, { status: 500 });
  }
}

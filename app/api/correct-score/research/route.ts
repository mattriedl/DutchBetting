export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { fetchMatchByEvent, analyzeCorrectScore } from '@/lib/correct-score';
import { researchMatch } from '@/lib/score-research';

/**
 * POST /api/correct-score/research
 * Run the Poisson + LLM research model for a single match and return a
 * research-ranked basket analysis.
 * Body: { eventTicker, minPicks?, maxPicks? }
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { eventTicker, minPicks, maxPicks, minEdge, minLowScore } = body ?? {};
    if (!eventTicker) return NextResponse.json({ error: 'Missing eventTicker' }, { status: 400 });

    const match = await fetchMatchByEvent(eventTicker, 'production');
    if (!match) return NextResponse.json({ error: 'Match not found or no open scoreline markets' }, { status: 404 });

    const { match: enriched, research } = await researchMatch(match);
    // Only feed the low-scoring gate a real signal (skip when no data was found).
    const lowScore = research.lowScoring?.dataAvailable ? research.lowScoring.score : undefined;
    const analysis = analyzeCorrectScore(enriched, {
      minPicks: minPicks ?? 4,
      maxPicks: maxPicks ?? 6,
      minEdge: typeof minEdge === 'number' ? minEdge : 2,
      minLowScore: typeof minLowScore === 'number' ? minLowScore : 0,
      lowScore,
    });

    return NextResponse.json({ analysis, research });
  } catch (error: any) {
    console.error('[CorrectScore API] Research error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Research failed' }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { fetchPolyMatchBySlug, analyzePolyCorrectScore } from '@/lib/polymarket-correct-score';
import { researchPolyMatch } from '@/lib/polymarket-score-research';

/**
 * POST /api/polymarket-cs/research
 * Run the detailed LLM + Poisson research model for a single Polymarket
 * exact-score match and return a research-ranked basket analysis.
 * Body: { slug, minPicks?, maxPicks?, includeAnyOther? }
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { slug, minPicks, maxPicks, includeAnyOther, minEdge, minLowScore } = body ?? {};
    if (!slug) return NextResponse.json({ error: 'Missing slug' }, { status: 400 });

    const match = await fetchPolyMatchBySlug(slug);
    if (!match) {
      return NextResponse.json({ error: 'Match not found or no open scoreline markets' }, { status: 404 });
    }

    const { match: enriched, research } = await researchPolyMatch(match);
    // Only feed the low-scoring gate a real signal (skip when no data was found).
    const lowScore = research.lowScoring?.dataAvailable ? research.lowScoring.score : undefined;
    const analysis = analyzePolyCorrectScore(enriched, {
      minPicks: minPicks ?? 4,
      maxPicks: maxPicks ?? 6,
      includeAnyOther: includeAnyOther ?? false,
      minEdge: typeof minEdge === 'number' ? minEdge : 2,
      minLowScore: typeof minLowScore === 'number' ? minLowScore : 0,
      lowScore,
    });

    return NextResponse.json({ analysis, research });
  } catch (error: any) {
    console.error('[PolymarketCS API] Research error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Research failed' }, { status: 500 });
  }
}

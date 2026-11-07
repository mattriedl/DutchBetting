export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { computeLowScoringConsensus } from '@/lib/low-scoring-consensus';

/**
 * POST /api/correct-score/consensus
 * Compute low-scoring consensus for a match.
 * Body: { teamA, teamB, league?, teamAXg?, teamBXg? }
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { teamA, teamB, league, teamAXg, teamBXg } = body ?? {};
    if (!teamA || !teamB) {
      return NextResponse.json({ error: 'Missing teamA and teamB' }, { status: 400 });
    }

    const consensus = await computeLowScoringConsensus({
      teamA,
      teamB,
      league,
      teamAXg,
      teamBXg,
    });

    return NextResponse.json({ consensus });
  } catch (error: any) {
    console.error('[CorrectScore API] Consensus error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Consensus analysis failed' }, { status: 500 });
  }
}

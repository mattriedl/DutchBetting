export const dynamic = 'force-dynamic';
export const maxDuration = 300; // throttled API-Football calls make settle slow

import { NextRequest, NextResponse } from 'next/server';
import { authorizeCaller } from '@/lib/automation-auth';
import { settleExternalPredictions } from '@/lib/external-predictions';

/**
 * POST /api/external-predictions/settle
 * Grades every open prediction whose kickoff has passed against the real score.
 * Callable by a signed-in user or by a scheduled job (x-automation-secret).
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await authorizeCaller(req);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const summary = await settleExternalPredictions();
    return NextResponse.json({ success: true, automated: caller.automated, summary });
  } catch (error: any) {
    console.error('[ExternalPredictions API] settle error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Settle failed' }, { status: 500 });
  }
}

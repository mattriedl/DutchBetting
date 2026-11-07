export const dynamic = 'force-dynamic';
export const maxDuration = 300; // throttled API-Football calls make ingest slow

import { NextRequest, NextResponse } from 'next/server';
import { authorizeCaller } from '@/lib/automation-auth';
import { ingestExternalPredictions } from '@/lib/external-predictions';

/**
 * POST /api/external-predictions/ingest
 * Pulls fresh third-party predictions for every currently-tradeable goals match.
 * Callable by a signed-in user or by a scheduled job (x-automation-secret).
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await authorizeCaller(req);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const summary = await ingestExternalPredictions();
    return NextResponse.json({ success: true, automated: caller.automated, summary });
  } catch (error: any) {
    console.error('[ExternalPredictions API] ingest error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Ingest failed' }, { status: 500 });
  }
}

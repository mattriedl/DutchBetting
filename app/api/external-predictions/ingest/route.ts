export const dynamic = 'force-dynamic';
export const maxDuration = 300; // throttled API-Football calls make ingest slow

import { recordRun } from '@/lib/autorun-status';
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
    recordRun('predictions-ingest', caller.automated, `${summary.matchesConsidered} matches, ${summary.apiFootball.added + summary.footystats.added} new + ${summary.apiFootball.refreshed + (summary.footystats.refreshed ?? 0)} refreshed predictions${summary.apiFootball.paused ? ' (API-Football paused)' : ''}`);
    return NextResponse.json({ success: true, automated: caller.automated, summary });
  } catch (error: any) {
    console.error('[ExternalPredictions API] ingest error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Ingest failed' }, { status: 500 });
  }
}

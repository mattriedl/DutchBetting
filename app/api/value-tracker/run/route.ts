export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { recordRun } from '@/lib/autorun-status';
import { NextRequest, NextResponse } from 'next/server';
import { authorizeCaller } from '@/lib/automation-auth';
import { ingestValuePicks } from '@/lib/value-tracker';

/**
 * POST /api/value-tracker/run
 * Scans today+tomorrow FootyStats fixtures, computes EV for every tradeable
 * selection and records a flat $10 demo pick for each that clears the value
 * thresholds. Callable by a signed-in user or a scheduled job.
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await authorizeCaller(req);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const summary = await ingestValuePicks({ userId: caller.userId });
    recordRun('value-run', caller.automated, `scanned ${summary.matchesScanned} matches, ${summary.qualifying} qualified, ${summary.added} new picks`);
    return NextResponse.json({ success: true, automated: caller.automated, summary });
  } catch (error: any) {
    console.error('[ValueTracker API] run error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Run failed' }, { status: 500 });
  }
}

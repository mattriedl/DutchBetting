export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { recordRun } from '@/lib/autorun-status';
import { NextRequest, NextResponse } from 'next/server';
import { authorizeCaller } from '@/lib/automation-auth';
import { settleValuePicks } from '@/lib/value-tracker';

/**
 * POST /api/value-tracker/settle
 * Grades every open demo pick whose kickoff has passed against the real
 * FootyStats result. Callable by a signed-in user or a scheduled job.
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await authorizeCaller(req);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const summary = await settleValuePicks();
    recordRun('value-settle', caller.automated, `checked ${summary.checked}, settled ${summary.settled} (${summary.won}W/${summary.lost}L/${summary.void}V), ${summary.stillOpen} still open`);
    return NextResponse.json({ success: true, automated: caller.automated, summary });
  } catch (error: any) {
    console.error('[ValueTracker API] settle error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Settle failed' }, { status: 500 });
  }
}

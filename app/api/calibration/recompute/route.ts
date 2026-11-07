export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { authorizeCaller } from '@/lib/automation-auth';
import { computeAndStoreCalibration } from '@/lib/calibration';

/**
 * POST /api/calibration/recompute
 * Recomputes calibration from all settled baskets and stores a new active
 * ModelCalibration row. Returns the fresh parameters.
 * Callable by a signed-in user or by a scheduled job (x-automation-secret).
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await authorizeCaller(req);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const calibration = await computeAndStoreCalibration(caller.userId, 'global');
    return NextResponse.json({ calibration, automated: caller.automated });
  } catch (error: any) {
    console.error('[Calibration API] recompute error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Failed to recompute calibration' }, { status: 500 });
  }
}

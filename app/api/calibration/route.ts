export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { getLatestCalibration } from '@/lib/calibration';

/**
 * GET /api/calibration
 * Returns the latest calibration parameters for the signed-in user (global scope).
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id as string;
    const calibration = await getLatestCalibration(userId, 'global');
    return NextResponse.json({ calibration });
  } catch (error: any) {
    console.error('[Calibration API] GET error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Failed to load calibration' }, { status: 500 });
  }
}

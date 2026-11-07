export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { authorizeCaller } from '@/lib/automation-auth';
import { getValueStats, listValuePicks } from '@/lib/value-tracker';

/**
 * GET /api/value-tracker/stats?status=&market=&model=&limit=
 * Returns the full performance statistics plus a filtered list of picks.
 */
export async function GET(req: NextRequest) {
  try {
    const caller = await authorizeCaller(req);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status') || undefined;
    const market = searchParams.get('market') || undefined;
    const model = searchParams.get('model') || undefined;
    const limit = Number(searchParams.get('limit')) || undefined;

    const [stats, picks] = await Promise.all([
      getValueStats(),
      listValuePicks({ status, market, model, limit }),
    ]);
    return NextResponse.json({ success: true, stats, picks });
  } catch (error: any) {
    console.error('[ValueTracker API] stats error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Stats failed' }, { status: 500 });
  }
}

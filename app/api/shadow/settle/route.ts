export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { authorizeCaller } from '@/lib/automation-auth';
import { settleShadowPicks } from '@/lib/shadow-analyst';

/**
 * POST /api/shadow/settle
 * Grades every open shadow pick whose match has finished.
 * Callable by a signed-in user or by a scheduled job (x-automation-secret).
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await authorizeCaller(req);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const summary = await settleShadowPicks();
    return NextResponse.json({ success: true, automated: caller.automated, summary });
  } catch (error: any) {
    console.error('[Shadow API] settle error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Shadow settle failed' }, { status: 500 });
  }
}

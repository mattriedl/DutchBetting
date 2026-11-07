export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { authorizeCaller } from '@/lib/automation-auth';
import { runShadowAnalysis } from '@/lib/shadow-analyst';

/**
 * POST /api/shadow/run { limit? }
 * Runs one autonomous analysis pass and records the AI's best +EV pick per match.
 * Callable by a signed-in user or by a scheduled job (x-automation-secret).
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await authorizeCaller(req);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({} as any));
    const limit = Math.max(1, Math.min(20, Number(body?.limit) || 8));

    const summary = await runShadowAnalysis({ userId: caller.userId, limit });
    return NextResponse.json({ success: true, automated: caller.automated, summary });
  } catch (error: any) {
    console.error('[Shadow API] run error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Shadow run failed' }, { status: 500 });
  }
}

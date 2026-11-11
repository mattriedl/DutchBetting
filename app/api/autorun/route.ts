export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { getRuns, autoRunEnabled } from '@/lib/autorun-status';

/** GET /api/autorun — whether jobs run on a schedule here, and each job's last run. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ enabled: autoRunEnabled(), runs: getRuns() });
}

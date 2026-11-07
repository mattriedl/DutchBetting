export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any)?.id;

    const prefs = await prisma.userPreference.findUnique({ where: { userId } });
    return NextResponse.json({
      oddsFormat: prefs?.oddsFormat ?? 'shares',
    });
  } catch (error: any) {
    console.error('Preferences GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any)?.id;
    const body = await req.json();

    const prefs = await prisma.userPreference.upsert({
      where: { userId },
      create: {
        userId,
        oddsFormat: body?.oddsFormat ?? 'shares',
      },
      update: {
        oddsFormat: body?.oddsFormat ?? 'shares',
      },
    });

    return NextResponse.json({ oddsFormat: prefs?.oddsFormat ?? 'shares' });
  } catch (error: any) {
    console.error('Preferences POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

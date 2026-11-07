export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { testKalshiConnection } from '@/lib/kalshi-api';

export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const userId = (session.user as any)?.id;
    const credential = await prisma.apiCredential.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (!credential || !credential?.keyId || !credential?.privateKey) {
      return NextResponse.json({ success: false, message: 'No API credentials configured. Please save your Key ID and Private Key first.' }, { status: 400 });
    }

    const result = await testKalshiConnection(
      credential.keyId,
      credential.privateKey,
      credential?.environment ?? 'demo'
    );

    await prisma.apiCredential.update({
      where: { id: credential.id },
      data: { isValid: result?.success ?? false, lastTested: new Date() },
    });

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Config test error:', error);
    return NextResponse.json({ success: false, message: error?.message ?? 'Test failed' }, { status: 500 });
  }
}

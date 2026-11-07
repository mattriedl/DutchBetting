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
    const credential = await prisma.apiCredential.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (!credential) return NextResponse.json({ configured: false });

    // Check if using new RSA key format or legacy
    const hasRsaKeys = !!(credential?.keyId && credential?.privateKey);

    return NextResponse.json({
      configured: hasRsaKeys,
      environment: credential?.environment ?? 'demo',
      isValid: credential?.isValid ?? false,
      lastTested: credential?.lastTested?.toISOString?.() ?? null,
      keyIdPreview: credential?.keyId ? `${credential.keyId.substring(0, 12)}...` : '',
    });
  } catch (error: any) {
    console.error('Config GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const userId = (session.user as any)?.id;
    const body = await req.json();
    const { keyId, privateKey, environment } = body ?? {};

    if (!keyId || !privateKey) {
      return NextResponse.json({ error: 'Key ID and Private Key are required' }, { status: 400 });
    }

    // Basic validation of PEM format
    const trimmedKey = (privateKey ?? '').trim();
    if (!trimmedKey.includes('-----BEGIN') || !trimmedKey.includes('PRIVATE KEY')) {
      return NextResponse.json(
        { error: 'Private key must be in PEM format (should start with -----BEGIN RSA PRIVATE KEY----- or -----BEGIN PRIVATE KEY-----)' },
        { status: 400 }
      );
    }

    // Upsert credentials
    const existing = await prisma.apiCredential.findFirst({ where: { userId } });
    if (existing) {
      await prisma.apiCredential.update({
        where: { id: existing.id },
        data: { keyId, privateKey: trimmedKey, environment: environment ?? 'demo' },
      });
    } else {
      await prisma.apiCredential.create({
        data: { userId, keyId, privateKey: trimmedKey, environment: environment ?? 'demo' },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Config POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

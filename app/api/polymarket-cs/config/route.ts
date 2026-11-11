export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { getWalletAddress } from '@/lib/polymarket-api';

const DEFAULTS = {
  enabled: false,
  mode: 'one-click',
  minProfitMargin: 3.0,
  maxPicks: 6,
  minPicks: 5,
  minStakePerBet: 2.0,
  maxStakePerBet: 5.0,
  maxDailySpend: 50.0,
  slippageCents: 1,
  minEdgeCents: 2.0,
  minLowScore: 0,
  includeAnyOther: false,
  signatureType: 0,
  funderAddress: null as string | null,
  paperMode: true, // safe default: paper until the user turns live on
};

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const config = await prisma.polymarketConfig.findUnique({ where: { userId } });

    // Surface the connected wallet address + whether creds are present.
    let walletAddress: string | null = null;
    let credsConfigured = false;
    try {
      if (process.env.POLYMARKET_PRIVATE_KEY) {
        walletAddress = await getWalletAddress();
        credsConfigured = true;
      }
    } catch {
      credsConfigured = false;
    }

    return NextResponse.json({
      config: config ?? DEFAULTS,
      walletAddress,
      credsConfigured,
    });
  } catch (error: any) {
    console.error('[Polymarket] Config GET error:', error?.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const body = await req.json();
    const data = {
      enabled: body?.enabled ?? DEFAULTS.enabled,
      mode: body?.mode ?? DEFAULTS.mode,
      minProfitMargin: body?.minProfitMargin ?? DEFAULTS.minProfitMargin,
      maxPicks: body?.maxPicks ?? DEFAULTS.maxPicks,
      minPicks: body?.minPicks ?? DEFAULTS.minPicks,
      minStakePerBet: body?.minStakePerBet ?? DEFAULTS.minStakePerBet,
      maxStakePerBet: body?.maxStakePerBet ?? DEFAULTS.maxStakePerBet,
      maxDailySpend: body?.maxDailySpend ?? DEFAULTS.maxDailySpend,
      slippageCents: body?.slippageCents ?? DEFAULTS.slippageCents,
      minEdgeCents: body?.minEdgeCents ?? DEFAULTS.minEdgeCents,
      minLowScore: body?.minLowScore ?? DEFAULTS.minLowScore,
      includeAnyOther: body?.includeAnyOther ?? DEFAULTS.includeAnyOther,
      signatureType: body?.signatureType ?? DEFAULTS.signatureType,
      funderAddress: body?.funderAddress || null,
      paperMode: body?.paperMode ?? DEFAULTS.paperMode,
    };

    const config = await prisma.polymarketConfig.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });

    return NextResponse.json({ config });
  } catch (error: any) {
    console.error('[Polymarket] Config POST error:', error?.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

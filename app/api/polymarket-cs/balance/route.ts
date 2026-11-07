export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { fetchUsdcBalance, getWalletAddress } from '@/lib/polymarket-api';

/**
 * GET /api/polymarket-cs/balance
 * Return the connected wallet address + USDC balance available for trading.
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    if (!process.env.POLYMARKET_PRIVATE_KEY) {
      return NextResponse.json({ credsConfigured: false, walletAddress: null, usdcBalance: null });
    }

    const config = await prisma.polymarketConfig.findUnique({ where: { userId } });
    const signatureType = config?.signatureType ?? 3;
    const funderAddress = config?.funderAddress || undefined;

    const walletAddress = await getWalletAddress();
    const usdcBalance = await fetchUsdcBalance(signatureType, funderAddress);

    return NextResponse.json({ credsConfigured: true, walletAddress, usdcBalance });
  } catch (error: any) {
    console.error('[Polymarket] Balance error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Failed to fetch balance' }, { status: 500 });
  }
}

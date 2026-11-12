export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { placeClobBuyOrder, getWalletAddress, fetchBalanceAllowanceDollars } from '@/lib/polymarket-api';
import { effectiveCents, takerFeeCents, POLYMARKET_DEFAULT_FEE, type FeeSpec } from '@/lib/trading-fees';

/**
 * POST /api/polymarket-cs/place
 * Place a multi-leg Polymarket exact-score Dutch basket. Buys a uniform
 * contract count of the YES token in each covered scoreline so any single
 * winning score pays contracts * $1.00 >= total cost.
 *
 * Body: {
 *   eventSlug, eventId, league, matchTitle, teamA, teamB, matchDate, negRisk,
 *   scorelines: [{ tokenId, label, priceCents, tickSize }],
 *   combinedCost(cents), dutchMargin, researchNote?, totalStake?(dollars),
 *   preview?: boolean   // if true, only compute allocation, do NOT post orders
 * }
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any).id;

    const body = await req.json();
    const {
      eventSlug, eventId, league, matchTitle, teamA, teamB, matchDate,
      negRisk, scorelines, combinedCost, dutchMargin, researchNote, totalStake,
      preview,
    } = body ?? {};

    if (!eventSlug || !Array.isArray(scorelines) || scorelines.length < 2) {
      return NextResponse.json({ error: 'Missing basket details (need at least 2 scorelines)' }, { status: 400 });
    }

    const config = await prisma.polymarketConfig.findUnique({ where: { userId } });
    const paperMode = config?.paperMode ?? true; // paper/demo: track picks, place NO real orders

    if (!paperMode && !process.env.POLYMARKET_PRIVATE_KEY) {
      return NextResponse.json({ error: 'Polymarket wallet not configured' }, { status: 400 });
    }

    const slippage = config?.slippageCents ?? 1;
    const maxDaily = config?.maxDailySpend ?? 50;
    const defaultStake = config?.minStakePerBet ?? 2;
    const maxStake = config?.maxStakePerBet ?? 5;
    const signatureType = config?.signatureType ?? 3;
    const funderAddress = config?.funderAddress || undefined;

    let stakeArg = totalStake ?? defaultStake;
    if (stakeArg > maxStake) stakeArg = maxStake;

    // Taker fee per leg: the market's own schedule as sent with the basket (sanity-clamped),
    // falling back to Polymarket's sports schedule.
    const legFee = (f: any): FeeSpec => {
      const rate = Number(f?.rate), exponent = Number(f?.exponent);
      return Number.isFinite(rate) && rate >= 0 && rate <= 0.2
        ? { rate, exponent: Number.isFinite(exponent) && exponent > 0 && exponent <= 3 ? exponent : 1 }
        : POLYMARKET_DEFAULT_FEE;
    };

    // Build legs with tick-rounded buy prices.
    const legs = scorelines.map((s: any) => {
      const tick = (s?.tickSize && s.tickSize > 0 ? s.tickSize : 0.01) as number;
      const tickCents = tick * 100;
      const rawBuyCents = Math.min((s?.priceCents ?? 0) + slippage, 99);
      const buyPriceCents = Math.min(99, Math.round(Math.ceil(rawBuyCents / tickCents) * tickCents));
      return {
        tokenId: s?.tokenId as string,
        label: (s?.label ?? '') as string,
        askCents: (s?.priceCents ?? 0) as number,
        buyPriceCents,
        buyPriceDollars: buyPriceCents / 100,
        tickSize: tick,
        fee: legFee(s?.fee),
        modelProb: typeof s?.modelProb === 'number' ? s.modelProb : null,
      };
    });

    const badLeg = legs.find((l: any) => !l.tokenId || !(l.askCents > 0 && l.askCents < 100));
    if (badLeg) {
      return NextResponse.json({ error: `No valid price for ${badLeg.label || 'a scoreline'}. Refresh the market and try again.` }, { status: 400 });
    }
    // Per-unit basket cost including taker fees — sizing and the profitability check are net of fees.
    const costPerUnit = legs.reduce((sum: number, l: any) => sum + effectiveCents(l.buyPriceCents, l.fee), 0);
    if (costPerUnit >= 100 || costPerUnit <= 0) {
      return NextResponse.json({ error: 'Basket no longer profitable after slippage' }, { status: 400 });
    }

    // Polymarket minimum order size (contracts) per leg — usually 5.
    const minOrderSize = Math.max(
      5,
      ...scorelines.map((s: any) => parseInt(String(s?.minOrderSize ?? 5), 10) || 5)
    );

    const stakeCents = Math.round(stakeArg * 100);
    const contracts = Math.max(minOrderSize, Math.floor(stakeCents / costPerUnit));
    const plannedFeeCents = legs.reduce((sum: number, l: any) => sum + takerFeeCents(contracts, l.buyPriceCents, l.fee), 0);
    const totalCostCents = contracts * legs.reduce((sum: number, l: any) => sum + l.buyPriceCents, 0) + plannedFeeCents;
    const totalCostDollars = totalCostCents / 100;

    // Daily spend cap across all Polymarket baskets.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dailyOrders = await prisma.polymarketBetOrder.findMany({
      where: { userId, createdAt: { gte: today }, status: { in: ['filled', 'partial', 'pending'] }, isPaper: false },
      select: { totalCost: true },
    });
    const dailySpentDollars = dailyOrders.reduce((s, o) => s + (o.totalCost ?? 0), 0) / 100;
    if (!paperMode && dailySpentDollars + totalCostDollars > maxDaily) {
      return NextResponse.json({
        error: `Daily spend limit exceeded. Spent: $${dailySpentDollars.toFixed(2)}, this bet: $${totalCostDollars.toFixed(2)}, limit: $${maxDaily.toFixed(2)}`,
      }, { status: 400 });
    }

    const walletAddress = (paperMode && !process.env.POLYMARKET_PRIVATE_KEY)
      ? 'PAPER'
      : await getWalletAddress();

    // PREVIEW: return the computed allocation without posting any orders.
    if (preview) {
      return NextResponse.json({
        preview: true,
        walletAddress,
        contracts,
        minOrderSize,
        costPerUnit,
        totalCost: `$${totalCostDollars.toFixed(2)}`,
        totalCostCents,
        expectedPayout: `$${(contracts).toFixed(2)}`,
        profitIfWin: `$${((contracts * 100 - totalCostCents) / 100).toFixed(2)}`,
        dutchMargin,
        legs: legs.map((l: any) => ({
          label: l.label,
          buyPrice: `$${l.buyPriceDollars.toFixed(3)}`,
          contracts,
          cost: `$${((l.buyPriceCents * contracts) / 100).toFixed(2)}`,
        })),
      });
    }

    // Duplicate guard — only block an existing basket in the SAME mode. A demo
    // (paper) basket must not prevent placing a real live basket and vice versa.
    const existing = await prisma.polymarketBetOrder.findFirst({
      where: { userId, eventSlug, isPaper: paperMode, status: { in: ['filled', 'partial', 'pending'] } },
    });
    if (existing) {
      return NextResponse.json({
        error: `Already have an active ${paperMode ? 'demo' : 'live'} basket on ${matchTitle}`,
      }, { status: 400 });
    }

    // PRE-FLIGHT: the trading wallet must hold enough USDC AND have granted an
    // allowance to the Polymarket exchange. Without both, orders silently fail
    // to fill and nothing appears in the portfolio. Block here with a clear
    // message instead of posting phantom orders. (Skipped entirely in paper mode.)
    const funds = paperMode ? null : await fetchBalanceAllowanceDollars(signatureType, funderAddress);
    if (!paperMode && funds) {
      if (funds.balanceDollars < totalCostDollars) {
        return NextResponse.json({
          error: `Insufficient USDC in trading wallet ${walletAddress}. Needed $${totalCostDollars.toFixed(2)}, available $${funds.balanceDollars.toFixed(2)}. Fund this wallet with USDC on Polygon (or set the correct funder address/signature type in Settings if your funds are in a Polymarket proxy wallet).`,
        }, { status: 400 });
      }
      if (funds.maxAllowanceDollars < totalCostDollars) {
        return NextResponse.json({
          error: `Polymarket exchange allowance not set for wallet ${walletAddress} (allowance $${funds.maxAllowanceDollars.toFixed(2)}, need $${totalCostDollars.toFixed(2)}). Approve USDC spending for the exchange before placing bets — the easiest way is to make one manual trade / deposit on Polymarket with this wallet, which sets the allowance automatically.`,
        }, { status: 400 });
      }
    } else if (!paperMode) {
      console.log('[Polymarket] WARNING: could not verify balance/allowance before placing');
    }

    // Place each leg via CLOB, cheapest first.
    const ordered = [...legs].sort((a: any, b: any) => a.buyPriceCents - b.buyPriceCents);
    const placed: any[] = [];
    let realCostCents = 0;
    let realFeeCents = 0; // taker fees, included in realCostCents
    let allFilled = true;
    let anyFilled = false;
    const errors: string[] = [];
    let overallStatus = 'failed';

    if (paperMode) {
      // PAPER/DEMO: no real CLOB orders. Simulate a full fill of every leg at its
      // buy price so the basket is tracked and settled later like a real one.
      for (const leg of ordered) {
        placed.push({
          tokenId: leg.tokenId, label: leg.label, priceCents: leg.buyPriceCents,
          modelProb: leg.modelProb,
          contracts, orderId: `PAPER-${leg.tokenId}`, status: 'matched',
        });
        { const f = takerFeeCents(contracts, leg.buyPriceCents, leg.fee); realFeeCents += f; realCostCents += contracts * leg.buyPriceCents + f; }
      }
      overallStatus = 'filled';
    } else {
    for (const leg of ordered) {
      const result = await placeClobBuyOrder({
        tokenId: leg.tokenId,
        priceDollars: leg.buyPriceDollars,
        size: contracts,
        tickSize: leg.tickSize,
        negRisk: negRisk !== false,
        signatureType,
        funderAddress,
      });

      const filled = result.status === 'matched';
      const live = result.status === 'live';
      placed.push({
        tokenId: leg.tokenId,
        label: leg.label,
        priceCents: leg.buyPriceCents,
        modelProb: leg.modelProb,
        contracts,
        orderId: result.orderId,
        status: result.status,
        error: result.error,
      });

      if (result.status !== 'failed') { const f = takerFeeCents(contracts, leg.buyPriceCents, leg.fee); realFeeCents += f; realCostCents += contracts * leg.buyPriceCents + f; }
      if (!filled) allFilled = false;
      if (filled || live) anyFilled = true;
      if (result.error) errors.push(`${leg.label}: ${result.error}`);

      await new Promise(r => setTimeout(r, 300));
    }

    // Success is tied STRICTLY to real order IDs. A leg with no orderId did
    // not rest or fill, no matter what status string came back.
    const legsWithOrderId = placed.filter(o => !!o.orderId);
    if (legsWithOrderId.length === placed.length && allFilled) overallStatus = 'filled';
    else if (legsWithOrderId.length === placed.length) overallStatus = 'partial'; // all posted, some resting/unmatched
    else if (legsWithOrderId.length > 0) overallStatus = 'partial';
    // else: no leg produced an order id -> failed
    }

    const record = await prisma.polymarketBetOrder.create({
      data: {
        userId,
        league: league ?? 'Soccer',
        eventSlug,
        eventId: eventId ?? '',
        matchTitle: matchTitle ?? '',
        teamA: teamA ?? '',
        teamB: teamB ?? '',
        matchDate: matchDate ?? '',
        numPicks: legs.length,
        scorelines: JSON.stringify(placed),
        totalCost: realCostCents,
        feeCents: realFeeCents,
        combinedCost: combinedCost ?? costPerUnit,
        dutchMargin: dutchMargin ?? 0,
        contracts,
        totalStake: stakeArg,
        expectedPayout: contracts * 100,
        researchNote: researchNote ?? null,
        negRisk: negRisk !== false,
        isPaper: paperMode,
        status: overallStatus,
        errorMessage: errors.length > 0 ? errors.join('; ') : null,
        settledResult: 'pending',
      },
    });

    return NextResponse.json({
      success: overallStatus !== 'failed',
      paper: paperMode,
      order: {
        id: record.id,
        status: overallStatus,
        isPaper: paperMode,
        totalCost: `$${(realCostCents / 100).toFixed(2)}`,
        contracts,
        numPicks: legs.length,
        legs: placed,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (error: any) {
    console.error('[Polymarket] Place error:', error?.message);
    return NextResponse.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}

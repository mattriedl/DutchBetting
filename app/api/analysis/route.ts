export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { calculateDutchBet, findDutchPositions } from '@/lib/dutch-betting';
import { isMarketStillBettable, getMarketTimingReason } from '@/lib/market-timing';

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const totalStake = parseFloat(url?.searchParams?.get?.('stake') ?? '10') || 10;
    const marketType = url?.searchParams?.get?.('marketType') ?? 'all'; // 'high', 'low', or 'all'

    // Get all markets, optionally filtered by type
    const whereClause: any = {};
    if (marketType !== 'all') {
      whereClause.marketType = marketType;
    }

    const markets = await prisma.marketData.findMany({
      where: whereClause,
      orderBy: [{ city: 'asc' }, { tempRangeLow: 'asc' }],
    });

    // Get all NWS forecasts (now multi-day: today + tomorrow)
    const forecasts = await prisma.nwsForecast.findMany({
      orderBy: { forecastDate: 'asc' },
    });

    // Build forecast lookup: city -> dateStr (YYYY-MM-DD) -> forecast record
    const forecastsByDate: Record<string, Record<string, any>> = {};
    (forecasts ?? []).forEach((f: any) => {
      const city = f?.city ?? '';
      const dateStr = f?.forecastDate?.toISOString?.()?.slice?.(0, 10) ?? '';
      if (!city || !dateStr) return;
      if (!forecastsByDate[city]) forecastsByDate[city] = {};
      forecastsByDate[city][dateStr] = f;
    });

    // Helper: parse event date string (YYYY-MM-DD) from eventTicker
    function parseEventDateStr(eventTicker: string): string {
      const dm = eventTicker.match(/(\d{2})([A-Z]{3})(\d{2})$/);
      if (!dm) return '';
      const mm: Record<string,string> = {JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12'};
      return `20${dm[1]}-${mm[dm[2]] ?? '01'}-${dm[3]}`;
    }

    // Helper: detect B-contract (between/bin) vs T-contract (threshold/tail) from kalshiMarketId
    function isBetweenContract(kalshiMarketId: string): boolean {
      return /-B\d/.test(kalshiMarketId);
    }

    // Group markets by city + marketType + eventDate
    // Each event date gets its own analysis with its own matching forecast
    const marketsByGroup: Record<string, any[]> = {};
    (markets ?? []).forEach((m: any) => {
      const eventDateStr = parseEventDateStr(m?.eventTicker ?? '');
      if (!eventDateStr) return;
      const key = `${m?.city ?? 'Unknown'}__${m?.marketType ?? 'high'}__${eventDateStr}`;
      if (!marketsByGroup[key]) marketsByGroup[key] = [];
      marketsByGroup[key].push(m);
    });

    // Analyze each city/type combination
    const analyses: any[] = [];
    let skippedStale = 0;
    for (const [groupKey, cityMarkets] of Object.entries(marketsByGroup)) {
      const [city, mType, eventDateStr] = groupKey.split('__');

      // CRITICAL: Skip markets where the temperature extreme has already occurred
      // e.g., don't bet on today's LOW at 10 AM when the low hit at 4 AM
      if (!isMarketStillBettable(city, eventDateStr, mType)) {
        const reason = getMarketTimingReason(city, eventDateStr, mType);
        if (reason) console.log(`[Analysis] Skipping ${city} ${mType} ${eventDateStr}: ${reason}`);
        skippedStale++;
        continue;
      }

      // Match forecast to this specific event date
      const forecast = forecastsByDate[city]?.[eventDateStr];
      if (!forecast) continue; // No forecast for this date — skip (e.g., settled events)
      
      // Get the appropriate forecast temperature
      const forecastTemp = mType === 'low' ? forecast?.forecastLow : forecast?.forecastHigh;
      if (forecastTemp == null) continue; // 0°F is a valid forecast; only skip when missing

      // CRITICAL: Only use B-contracts (2° bins) for Dutch bet analysis
      // T-contracts are threshold/tail bets (≤X° or ≥Y°) that should NOT be in the Dutch bet
      const bContractMarkets = (cityMarkets ?? []).filter((m: any) => isBetweenContract(m?.kalshiMarketId ?? ''));
      
      const marketInputs = bContractMarkets.map((m: any) => ({
        ticker: m?.kalshiMarketId ?? '',
        tempLow: m?.tempRangeLow ?? 0,
        tempHigh: m?.tempRangeHigh ?? 0,
        yesPrice: m?.yesPrice ?? 0,
      }));

      const positions = findDutchPositions(forecastTemp, marketInputs);
      const analysis = calculateDutchBet(positions, totalStake, forecastTemp);

      // Extract the forecast target date from the event ticker (e.g. KXHIGHCHI-26JUN05 -> June 5, 2026)
      const sampleEventTicker = (cityMarkets?.[0] as any)?.eventTicker ?? '';
      let forecastTargetDate = '';
      const dateMatch = sampleEventTicker.match(/(\d{2})([A-Z]{3})(\d{2})$/);
      if (dateMatch) {
        const monthMap: Record<string, string> = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
        const yr = `20${dateMatch[1]}`;
        const mo = monthMap[dateMatch[2]] ?? '01';
        const dy = dateMatch[3].padStart(2, '0');
        forecastTargetDate = `${yr}-${mo}-${dy}`;
      }

      analyses.push({
        city,
        state: forecast?.state ?? (cityMarkets?.[0] as any)?.state ?? '',
        marketType: mType,
        nwsForecast: forecastTemp,
        forecastConfidence: forecast?.confidence ?? 'normal',
        forecastRetrievedAt: forecast?.retrievedAt?.toISOString?.() ?? '',
        forecastTargetDate,
        eventTicker: sampleEventTicker,
        expirationTime: (cityMarkets?.[0] as any)?.expirationTime?.toISOString?.() ?? '',
        allMarkets: (() => {
          // Sort by tempRangeLow to determine threshold directions
          const sorted = [...(cityMarkets ?? [])].sort((a: any, b: any) => (a?.tempRangeLow ?? 0) - (b?.tempRangeLow ?? 0));
          return sorted.map((m: any, idx: number) => {
            const isThreshold = !isBetweenContract(m?.kalshiMarketId ?? '');
            let strikeDirection: string | undefined;
            if (isThreshold) {
              // First threshold in sorted order = below tail, last = above tail
              strikeDirection = idx === 0 ? 'below' : 'above';
            }
            return {
              ticker: m?.kalshiMarketId ?? '',
              tempRangeLow: m?.tempRangeLow ?? 0,
              tempRangeHigh: m?.tempRangeHigh ?? 0,
              yesPrice: m?.yesPrice ?? 0,
              noPrice: m?.noPrice ?? 0,
              volume: m?.volume ?? 0,
              contractType: isThreshold ? 'threshold' : 'between',
              strikeDirection,
            };
          });
        })(),
        dutchBet: {
          ...analysis,
          positions: (analysis?.positions ?? []).map((p: any) => ({
            ...p,
            stake: p?.stake ?? 0,
            payout: p?.payout ?? 0,
          })),
          binCount: analysis?.binCount ?? 0,
          forecastOffset: analysis?.forecastOffset ?? 0,
          isEdgeCase: analysis?.isEdgeCase ?? false,
          edgeCaseReason: analysis?.edgeCaseReason ?? null,
        },
      });
    }

    // Sort: real viable opportunities first (by profit margin), then edge cases at the bottom
    analyses.sort((a: any, b: any) => {
      const aEdge = a?.dutchBet?.isEdgeCase ? 1 : 0;
      const bEdge = b?.dutchBet?.isEdgeCase ? 1 : 0;
      if (aEdge !== bEdge) return aEdge - bEdge; // non-edge first
      return (b?.dutchBet?.profitMargin ?? 0) - (a?.dutchBet?.profitMargin ?? 0);
    });

    const summary = {
      totalCities: analyses?.length ?? 0,
      viableOpportunities: (analyses ?? []).filter((a: any) => a?.dutchBet?.isViable && !a?.dutchBet?.isEdgeCase)?.length ?? 0,
      edgeCases: (analyses ?? []).filter((a: any) => a?.dutchBet?.isEdgeCase)?.length ?? 0,
      highTempMarkets: (analyses ?? []).filter((a: any) => a?.marketType === 'high')?.length ?? 0,
      lowTempMarkets: (analyses ?? []).filter((a: any) => a?.marketType === 'low')?.length ?? 0,
      bestProfitMargin: (analyses?.[0] as any)?.dutchBet?.profitMargin ?? 0,
      avgProfitMargin: analyses?.length > 0
        ? Math.round(((analyses ?? []).reduce((sum: number, a: any) => sum + (a?.dutchBet?.profitMargin ?? 0), 0) / analyses.length) * 100) / 100
        : 0,
    };

    return NextResponse.json({ analyses, summary, skippedStale });
  } catch (error: any) {
    console.error('Analysis GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

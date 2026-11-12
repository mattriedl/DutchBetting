export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { kalshiPublicFetch } from '@/lib/kalshi-api';
import { kalshiEffectiveCents } from '@/lib/kalshi-fees';

const SERIES_CITY_MAP: Record<string, string> = {
  KXHIGHNY: 'New York',
  KXHIGHCHI: 'Chicago',
  KXHIGHMIA: 'Miami',
  KXHIGHDEN: 'Denver',
  KXHIGHPHIL: 'Philadelphia',
};

const DELAY_MS = 250;
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Parse event ticker date: KXHIGHCHI-26JUN03 -> 2026-06-03 */
function parseEventDate(eventTicker: string): Date | null {
  const m = eventTicker.match(/(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const monthMap: Record<string,string> = {JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12'};
  return new Date(`20${m[1]}-${monthMap[m[2]] ?? '01'}-${m[3]}T12:00:00Z`);
}

// ============================================================================
// PHASE 1: COLLECT — Pull settled events from Kalshi
// ============================================================================
async function handleCollect(maxEvents: number) {
  const series = Object.keys(SERIES_CITY_MAP);
  let eventsCollected = 0;
  const errors: string[] = [];

  for (const seriesTicker of series) {
    const city = SERIES_CITY_MAP[seriesTicker];
    try {
      await sleep(DELAY_MS);
      const result = await kalshiPublicFetch(
        `/events?series_ticker=${seriesTicker}&status=settled&limit=${maxEvents}`,
        'production'
      );
      const events = result?.events ?? [];
      console.log(`Backtest collect: ${seriesTicker} has ${events.length} settled events`);

      for (const event of events) {
        const eventTicker = event?.event_ticker ?? '';
        const forecastDate = parseEventDate(eventTicker);
        if (!forecastDate || !eventTicker) continue;

        const existing = await prisma.backtestEvent.findUnique({ where: { eventTicker } });
        if (existing) { eventsCollected++; continue; }

        await sleep(DELAY_MS);
        try {
          const marketResult = await kalshiPublicFetch(
            `/markets?event_ticker=${eventTicker}&limit=50`,
            'production'
          );
          const markets = (marketResult?.markets ?? []).sort(
            (a: any, b: any) => (a?.floor_strike ?? 0) - (b?.floor_strike ?? 0)
          );
          if (markets.length === 0) continue;

          const winner = markets.find((m: any) => m?.result === 'yes');
          let winningBin: string | null = null;
          let winningBinFloor: number | null = null;
          let winningBinCap: number | null = null;

          if (winner) {
            if (winner.strike_type === 'between') {
              winningBin = `${winner.floor_strike}-${winner.cap_strike}`;
              winningBinFloor = winner.floor_strike;
              winningBinCap = winner.cap_strike;
            } else if (winner.strike_type === 'less') {
              winningBin = `≤${(winner.cap_strike ?? 0) - 1}`;
              winningBinCap = winner.cap_strike;
              winningBinFloor = (winner.cap_strike ?? 0) - 10;
            } else if (winner.strike_type === 'greater') {
              winningBin = `≥${(winner.floor_strike ?? 0) + 1}`;
              winningBinFloor = winner.floor_strike;
              winningBinCap = (winner.floor_strike ?? 0) + 10;
            }
          }

          const bins = markets.map((m: any) => ({
            ticker: m?.ticker ?? '',
            subtitle: m?.subtitle ?? '',
            floor: m?.floor_strike ?? null,
            cap: m?.cap_strike ?? null,
            type: m?.strike_type ?? '',
            result: m?.result ?? '',
            yesBid: parseFloat(m?.yes_bid_dollars ?? '0'),
            yesAsk: parseFloat(m?.yes_ask_dollars ?? '0'),
            lastPrice: parseFloat(m?.last_price_dollars ?? '0'),
            volume: m?.volume_fp ?? '0',
          }));

          await prisma.backtestEvent.create({
            data: {
              eventTicker, seriesTicker, city, forecastDate,
              winningBin, winningBinFloor, winningBinCap,
              totalBins: markets.length,
              binsJson: JSON.stringify(bins),
              enriched: false,
            },
          });
          eventsCollected++;
        } catch (marketErr: any) {
          if (marketErr?.message?.includes?.('429')) await sleep(3000);
          errors.push(`${eventTicker}: ${marketErr?.message}`);
        }
      }
    } catch (seriesErr: any) {
      errors.push(`${seriesTicker}: ${seriesErr?.message}`);
      if (seriesErr?.message?.includes?.('429')) await sleep(3000);
    }
  }

  const total = await prisma.backtestEvent.count();
  const unenriched = await prisma.backtestEvent.count({ where: { enriched: false } });
  return { eventsCollected, totalInDb: total, needsEnrichment: unenriched, errors: errors.slice(0, 5) };
}

// ============================================================================
// PHASE 2: ENRICH — Fetch real trade prices for settled bins
// ============================================================================
async function handleEnrich(batchSize: number = 8) {
  const unenrichedEvents = await prisma.backtestEvent.findMany({
    where: { enriched: false },
    take: batchSize,
    orderBy: { forecastDate: 'asc' },
  });

  const totalUnenriched = await prisma.backtestEvent.count({ where: { enriched: false } });
  const totalEvents = await prisma.backtestEvent.count();
  let binsProcessed = 0;
  let binsFailed = 0;

  for (const event of unenrichedEvents) {
    const bins: any[] = JSON.parse(event.binsJson);

    for (const bin of bins) {
      if (!bin.ticker || bin.realPrice !== undefined) continue;

      await sleep(DELAY_MS);
      try {
        const tradesResult = await kalshiPublicFetch(
          `/markets/trades?ticker=${encodeURIComponent(bin.ticker)}&limit=40`,
          'production'
        );
        const trades = tradesResult?.trades ?? [];

        // Filter out settlement prices (≥97¢ = winner settled, ≤2¢ = loser settled)
        let realTrades = trades.filter((t: any) => {
          const price = parseFloat(t.yes_price_dollars ?? '0');
          return price > 0.02 && price < 0.97;
        });

        // If all trades are at settlement prices, page back with cursor
        if (realTrades.length === 0 && trades.length > 0 && tradesResult?.cursor) {
          await sleep(DELAY_MS);
          try {
            const olderResult = await kalshiPublicFetch(
              `/markets/trades?ticker=${encodeURIComponent(bin.ticker)}&limit=60&cursor=${tradesResult.cursor}`,
              'production'
            );
            realTrades = (olderResult?.trades ?? []).filter((t: any) => {
              const price = parseFloat(t.yes_price_dollars ?? '0');
              return price > 0.02 && price < 0.97;
            });
          } catch (pageErr: any) {
            if (pageErr?.message?.includes?.('429')) await sleep(3000);
          }
        }

        if (realTrades.length > 0) {
          // Use median of real trade prices for stability
          const prices = realTrades.map((t: any) => parseFloat(t.yes_price_dollars));
          prices.sort((a: number, b: number) => a - b);
          bin.realPrice = prices[Math.floor(prices.length / 2)];
          bin.realTradeCount = realTrades.length;
          bin.priceSource = 'trades';
          binsProcessed++;
        } else {
          // No real trades found — use a fallback estimate
          applyFallbackPrice(bin);
          binsFailed++;
        }
      } catch (err: any) {
        if (err?.message?.includes?.('429')) await sleep(3000);
        applyFallbackPrice(bin);
        binsFailed++;
      }
    }

    await prisma.backtestEvent.update({
      where: { id: event.id },
      data: { binsJson: JSON.stringify(bins), enriched: true },
    });
  }

  const remaining = totalUnenriched - unenrichedEvents.length;
  return {
    processed: unenrichedEvents.length,
    remaining: Math.max(0, remaining),
    total: totalEvents,
    binsProcessed,
    binsFailed,
    done: remaining <= 0,
  };
}

function applyFallbackPrice(bin: any) {
  // Conservative fallback estimates based on market structure
  if (bin.result === 'yes') {
    bin.realPrice = 0.40; // Winner bins typically 30-60% pre-settlement
  } else if (bin.type === 'between') {
    bin.realPrice = 0.12; // Non-winning between bins ~8-20%
  } else {
    bin.realPrice = 0.04; // Tail bins ~2-6%
  }
  bin.priceSource = 'estimated';
  bin.realTradeCount = 0;
}

// ============================================================================
// PHASE 3: ANALYZE — Run backtest analysis using real prices
// ============================================================================
async function handleAnalyze() {
  const allEvents = await prisma.backtestEvent.findMany({
    where: { enriched: true },
    orderBy: { forecastDate: 'asc' },
  });

  if (allEvents.length === 0) {
    return { analyzed: 0, runId: '', message: 'No enriched events to analyze. Run enrich first.' };
  }

  const runId = `run_${Date.now()}`;
  let eventsAnalyzed = 0;
  const errors: string[] = [];

  // Delete results from previous runs to keep things clean
  await prisma.backtestResult.deleteMany({});

  for (const event of allEvents) {
    try {
      const bins: any[] = JSON.parse(event.binsJson);
      if (!event.winningBin || bins.length < 3) continue;

      // Sort all bins by position
      const allBinsSorted = [...bins].sort((a: any, b: any) => {
        const aKey = a.type === 'less' ? -1000 : a.type === 'greater' ? 1000 : (a.floor ?? 0);
        const bKey = b.type === 'less' ? -1000 : b.type === 'greater' ? 1000 : (b.floor ?? 0);
        return aKey - bKey;
      });

      const winnerIdx = allBinsSorted.findIndex((b: any) => b.result === 'yes');
      if (winnerIdx === -1) continue;

      // Simulate different NWS accuracy scenarios
      for (const offset of [0, 1, -1, 2, -2]) {
        const centerIdx = winnerIdx + offset;
        if (centerIdx < 0 || centerIdx >= allBinsSorted.length) continue;

        // Select center + adjacent bins (3-bin Dutch bet)
        const selectedIndices = [
          Math.max(0, centerIdx - 1),
          centerIdx,
          Math.min(allBinsSorted.length - 1, centerIdx + 1),
        ];
        const uniqueIndices = [...new Set(selectedIndices)];
        const selectedBins = uniqueIndices.map(i => allBinsSorted[i]);

        // Use REAL trade prices for cost calculation
        const costMid = selectedBins.reduce((s: number, b: any) => s + (b.realPrice ?? 0.10), 0);
        // Bid = 1¢ below market per bin (limit orders)
        const costAtBid = selectedBins.reduce((s: number, b: any) =>
          s + Math.max(0.01, (b.realPrice ?? 0.10) - 0.01), 0);
        // Ask = 1¢ above market per bin (market orders)
        const costAtAsk = selectedBins.reduce((s: number, b: any) =>
          s + ((b.realPrice ?? 0.10) + 0.01), 0);

        const winnerCovered = selectedBins.some((b: any) => b.result === 'yes');

        // Profit = $1 payout - cost (if winner covered), else -cost
        const profitMid = winnerCovered ? (1 - costMid) : -costMid;
        const profitAtBid = winnerCovered ? (1 - costAtBid) : -costAtBid;
        const profitAtAsk = winnerCovered ? (1 - costAtAsk) : -costAtAsk;

        const strategy = offset === 0 ? 'perfect' : `nws_off_${offset > 0 ? '+' : ''}${offset}`;

        // Count how many bins used estimated vs real prices
        const estimatedCount = selectedBins.filter((b: any) => b.priceSource === 'estimated').length;

        await prisma.backtestResult.create({
          data: {
            runId,
            city: event.city,
            forecastDate: event.forecastDate,
            eventTicker: event.eventTicker,
            strategy,
            nwsOffset: offset,
            binsSelected: JSON.stringify(selectedBins.map((b: any) => ({
              label: b.subtitle ?? b.ticker,
              realPrice: b.realPrice,
              source: b.priceSource ?? 'unknown',
            }))),
            costAtBid,
            costAtAsk,
            winnerCovered,
            profitAtBid,
            profitAtAsk,
          },
        });
        eventsAnalyzed++;
      }
    } catch (analysisErr: any) {
      errors.push(`${event.eventTicker}: ${analysisErr?.message}`);
    }
  }

  return { runId, analyzed: eventsAnalyzed, totalEvents: allEvents.length, errors: errors.slice(0, 5) };
}

// ============================================================================
// REALISTIC NWS SIMULATION — Analytical probability approach
// ============================================================================

/** Standard normal CDF (Abramowitz & Stegun approximation) */
function normalCDF(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + 0.3275911 * ax);
  const y = 1.0 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

/** P(NWS forecast lands in a given bin) given actual temp and NWS error σ */
function binProbability(bin: any, actualTemp: number, sigma: number): number {
  let low: number, high: number;
  if (bin.type === 'less') {
    low = -Infinity;
    high = (bin.cap ?? 0) - 0.5;
  } else if (bin.type === 'greater') {
    low = (bin.floor ?? 0) + 0.5;
    high = Infinity;
  } else {
    low = (bin.floor ?? 0) - 0.5;
    high = (bin.cap ?? 0) + 0.5;
  }
  const pHigh = high === Infinity ? 1.0 : normalCDF((high - actualTemp) / sigma);
  const pLow = low === -Infinity ? 0.0 : normalCDF((low - actualTemp) / sigma);
  return Math.max(0, pHigh - pLow);
}

function sortBins(bins: any[]) {
  return [...bins].sort((a: any, b: any) => {
    const aKey = a.type === 'less' ? -1000 : a.type === 'greater' ? 1000 : (a.floor ?? 0);
    const bKey = b.type === 'less' ? -1000 : b.type === 'greater' ? 1000 : (b.floor ?? 0);
    return aKey - bKey;
  });
}

/**
 * For each possible center bin c, compute:
 *   P(forecast in bin c) × [Win(c) × (1 - Cost(c)) - (1-Win(c)) × Cost(c)]
 * where Win(c) = 1 if winner is within ±1 of c
 */
async function computeRealisticSimulation(sigmaLevels: number[]) {
  const enrichedEvents = await prisma.backtestEvent.findMany({
    where: { enriched: true },
    orderBy: { forecastDate: 'asc' },
  });

  if (enrichedEvents.length === 0) return null;

  // Pre-fetch NWS CF6 for current month to get exact actual temps
  let cf6Temps: Record<string, Record<string, { maxTemp: number | null; minTemp: number | null }>> = {};
  try {
    const { fetchAllObservedTemps } = await import('@/lib/nws-climate');
    cf6Temps = await fetchAllObservedTemps();
  } catch (e: any) {
    console.error('CF6 fetch for backtest failed, using bin midpoints:', e?.message);
  }

  const results: Record<string, any> = {};

  for (const sigma of sigmaLevels) {
    let totalEvents = 0;
    let expectedWins = 0;
    let expectedPnlBid = 0;
    let expectedPnlAsk = 0;
    const cityAccum: Record<string, {
      events: number; expWins: number; pnlBid: number; pnlAsk: number; totalCost: number;
    }> = {};
    const pnlCurve: { date: string; pnlBid: number; pnlAsk: number; eventNum: number }[] = [];
    let cumBid = 0, cumAsk = 0;

    for (const event of enrichedEvents) {
      const bins: any[] = JSON.parse(event.binsJson);
      const sorted = sortBins(bins);
      const winnerIdx = sorted.findIndex((b: any) => b.result === 'yes');
      if (winnerIdx === -1 || sorted.length < 3) continue;

      const winner = sorted[winnerIdx];
      // Try NWS CF6 for exact actual temp, fall back to bin midpoint
      let actualTemp: number;
      const eventCity = event.city ?? '';
      const eventDateStr = event.forecastDate?.toISOString?.().slice(0, 10) ?? '';
      const isHigh = (event.seriesTicker ?? '').includes('HIGH');
      const cf6City = cf6Temps[eventCity];
      const cf6Day = cf6City?.[eventDateStr];
      const cf6Temp = cf6Day ? (isHigh ? cf6Day.maxTemp : cf6Day.minTemp) : null;
      if (cf6Temp != null) {
        actualTemp = cf6Temp;
      } else if (winner.type === 'between') {
        actualTemp = ((winner.floor ?? 0) + (winner.cap ?? 0)) / 2;
      } else if (winner.type === 'less') {
        actualTemp = (winner.cap ?? 0) - 1;
      } else {
        actualTemp = (winner.floor ?? 0) + 1;
      }

      // For each possible center bin, compute probability and outcome
      let eventPwin = 0;
      let eventExpProfitBid = 0;
      let eventExpProfitAsk = 0;
      let eventExpCost = 0;

      for (let c = 0; c < sorted.length; c++) {
        const pCenter = binProbability(sorted[c], actualTemp, sigma);
        if (pCenter < 0.0001) continue; // Skip negligible probability

        // Select 3 bins for Dutch bet centered at c
        const selIdx = [...new Set([
          Math.max(0, c - 1), c, Math.min(sorted.length - 1, c + 1)
        ])];
        const selBins = selIdx.map(i => sorted[i]);

        const costBid = selBins.reduce((s: number, b: any) =>
          s + Math.max(0.01, (b.realPrice ?? 0.10) - 0.01), 0);
        // Taking the ask pays Kalshi's taker fee; the resting-bid scenario pays none (climate
        // series have no maker fee in the 2026-07-07 schedule).
        const costAsk = selBins.reduce((s: number, b: any) =>
          s + kalshiEffectiveCents(Math.round(((b.realPrice ?? 0.10) + 0.01) * 100)) / 100, 0);

        const covers = selIdx.includes(winnerIdx);
        const profitBid = covers ? (1 - costBid) : -costBid;
        const profitAsk = covers ? (1 - costAsk) : -costAsk;

        if (covers) eventPwin += pCenter;
        eventExpProfitBid += pCenter * profitBid;
        eventExpProfitAsk += pCenter * profitAsk;
        eventExpCost += pCenter * costBid;
      }

      totalEvents++;
      expectedWins += eventPwin;
      expectedPnlBid += eventExpProfitBid * 10;
      expectedPnlAsk += eventExpProfitAsk * 10;

      cumBid += eventExpProfitBid * 10;
      cumAsk += eventExpProfitAsk * 10;
      pnlCurve.push({
        date: event.forecastDate.toISOString().split('T')[0],
        pnlBid: Math.round(cumBid * 100) / 100,
        pnlAsk: Math.round(cumAsk * 100) / 100,
        eventNum: totalEvents,
      });

      // Per-city
      if (!cityAccum[event.city]) {
        cityAccum[event.city] = { events: 0, expWins: 0, pnlBid: 0, pnlAsk: 0, totalCost: 0 };
      }
      const ca = cityAccum[event.city];
      ca.events++;
      ca.expWins += eventPwin;
      ca.pnlBid += eventExpProfitBid * 10;
      ca.pnlAsk += eventExpProfitAsk * 10;
      ca.totalCost += eventExpCost;
    }

    const cityResults = Object.entries(cityAccum).map(([city, d]) => ({
      city,
      events: d.events,
      expectedWins: Math.round(d.expWins * 10) / 10,
      expectedLosses: Math.round((d.events - d.expWins) * 10) / 10,
      winRate: Math.round((d.expWins / d.events) * 1000) / 10,
      pnlBid: Math.round(d.pnlBid * 100) / 100,
      pnlAsk: Math.round(d.pnlAsk * 100) / 100,
      avgCost: Math.round((d.totalCost / d.events) * 100) / 100,
      breakevenWinRate: Math.round((d.totalCost / d.events) * 1000) / 10,
    }));

    results[`sigma_${sigma}`] = {
      sigma,
      label: `NWS σ = ${sigma}°F`,
      totalEvents,
      expectedWins: Math.round(expectedWins * 10) / 10,
      expectedLosses: Math.round((totalEvents - expectedWins) * 10) / 10,
      winRate: Math.round((expectedWins / totalEvents) * 1000) / 10,
      expectedPnlBid: Math.round(expectedPnlBid * 100) / 100,
      expectedPnlAsk: Math.round(expectedPnlAsk * 100) / 100,
      pnlCurve,
      cityResults,
    };
  }

  return results;
}

// ============================================================================
// POST /api/backtest — Main entry point with action routing
// ============================================================================
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = body?.action ?? 'collect';

    switch (action) {
      case 'collect': {
        const maxEvents = Math.min(body?.maxEvents ?? 50, 100);
        const result = await handleCollect(maxEvents);
        return NextResponse.json({ action: 'collect', ...result });
      }
      case 'enrich': {
        const batchSize = Math.min(body?.batchSize ?? 8, 15);
        const result = await handleEnrich(batchSize);
        return NextResponse.json({ action: 'enrich', ...result });
      }
      case 'analyze': {
        const result = await handleAnalyze();
        return NextResponse.json({ action: 'analyze', ...result });
      }
      case 'reset': {
        // Reset enrichment status so we can re-fetch trades
        await prisma.backtestEvent.updateMany({ data: { enriched: false } });
        await prisma.backtestResult.deleteMany({});
        // Also clear realPrice from binsJson
        const all = await prisma.backtestEvent.findMany();
        for (const e of all) {
          const bins: any[] = JSON.parse(e.binsJson);
          for (const b of bins) {
            delete b.realPrice;
            delete b.realTradeCount;
            delete b.priceSource;
          }
          await prisma.backtestEvent.update({
            where: { id: e.id },
            data: { binsJson: JSON.stringify(bins), enriched: false },
          });
        }
        return NextResponse.json({ action: 'reset', success: true });
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error: any) {
    console.error('Backtest error:', error);
    return NextResponse.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}

// ============================================================================
// GET /api/backtest — Return results summary
// ============================================================================
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const runId = url.searchParams.get('runId');

    let targetRunId = runId;
    if (!targetRunId) {
      const latest = await prisma.backtestResult.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { runId: true },
      });
      targetRunId = latest?.runId ?? null;
    }

    // Get collection status
    const totalEvents = await prisma.backtestEvent.count();
    const enrichedEvents = await prisma.backtestEvent.count({ where: { enriched: true } });
    const unenrichedEvents = totalEvents - enrichedEvents;

    if (!targetRunId) {
      return NextResponse.json({
        results: null,
        collectionStatus: { totalEvents, enrichedEvents, unenrichedEvents },
        message: totalEvents === 0
          ? 'No data. Run backtest to collect events.'
          : unenrichedEvents > 0
          ? `${totalEvents} events collected, ${unenrichedEvents} still need price enrichment.`
          : 'Events enriched but no analysis run yet.',
      });
    }

    const results = await prisma.backtestResult.findMany({
      where: { runId: targetRunId },
      orderBy: { forecastDate: 'asc' },
    });

    // Aggregate by strategy
    const strategies = ['perfect', 'nws_off_+1', 'nws_off_-1', 'nws_off_+2', 'nws_off_-2'];
    const strategyStats: Record<string, any> = {};

    for (const strategy of strategies) {
      const filtered = results.filter(r => r.strategy === strategy);
      if (filtered.length === 0) continue;

      const wins = filtered.filter(r => r.winnerCovered).length;
      const totalEvts = filtered.length;
      const winRate = totalEvts > 0 ? (wins / totalEvts * 100) : 0;
      const avgCostBid = filtered.reduce((s, r) => s + r.costAtBid, 0) / totalEvts;
      const avgCostAsk = filtered.reduce((s, r) => s + r.costAtAsk, 0) / totalEvts;
      const avgProfitBid = filtered.reduce((s, r) => s + r.profitAtBid, 0) / totalEvts;
      const avgProfitAsk = filtered.reduce((s, r) => s + r.profitAtAsk, 0) / totalEvts;

      // ROI = avg profit / avg cost * 100
      const roiBid = avgCostBid > 0 ? (avgProfitBid / avgCostBid * 100) : 0;
      const roiAsk = avgCostAsk > 0 ? (avgProfitAsk / avgCostAsk * 100) : 0;

      // Cumulative P&L for $10 stake
      let cumPnlBid = 0;
      let cumPnlAsk = 0;
      const pnlCurve: { date: string; pnlBid: number; pnlAsk: number; eventNum: number }[] = [];
      for (let i = 0; i < filtered.length; i++) {
        const r = filtered[i];
        // Scale: $10 total stake means cost is costAtX * 10, payout is 1 * 10 per share
        // Actually for Dutch bet: you spend costAtX total for 3 shares, payout is $1 per winning share
        // With $10 stake: buy (10/costAtX) units, each unit costs costAtX and pays $1
        // Profit per unit = profitAtX, total profit = (10/costAtX) * profitAtX = 10 * profitAtX / costAtX
        // Simpler: just use profitAtX * 10 (assumes $10 notional)
        cumPnlBid += r.profitAtBid * 10;
        cumPnlAsk += r.profitAtAsk * 10;
        pnlCurve.push({
          date: r.forecastDate.toISOString().split('T')[0],
          pnlBid: Math.round(cumPnlBid * 100) / 100,
          pnlAsk: Math.round(cumPnlAsk * 100) / 100,
          eventNum: i + 1,
        });
      }

      strategyStats[strategy] = {
        totalEvents: totalEvts,
        wins, losses: totalEvts - wins,
        winRate: Math.round(winRate * 10) / 10,
        avgCostBid: Math.round(avgCostBid * 100) / 100,
        avgCostAsk: Math.round(avgCostAsk * 100) / 100,
        avgProfitBid: Math.round(avgProfitBid * 10000) / 10000,
        avgProfitAsk: Math.round(avgProfitAsk * 10000) / 10000,
        avgReturnPctBid: Math.round(roiBid * 100) / 100,
        avgReturnPctAsk: Math.round(roiAsk * 100) / 100,
        cumulativePnlBid: Math.round(cumPnlBid * 100) / 100,
        cumulativePnlAsk: Math.round(cumPnlAsk * 100) / 100,
        pnlCurve,
      };
    }

    // Per-city stats for perfect strategy
    const perfectResults = results.filter(r => r.strategy === 'perfect');
    const cities = [...new Set(perfectResults.map(r => r.city))];
    const cityStats = cities.map(city => {
      const cityResults = perfectResults.filter(r => r.city === city);
      const wins = cityResults.filter(r => r.winnerCovered).length;
      const avgCB = cityResults.reduce((s, r) => s + r.costAtBid, 0) / cityResults.length;
      const avgCA = cityResults.reduce((s, r) => s + r.costAtAsk, 0) / cityResults.length;
      const avgPB = cityResults.reduce((s, r) => s + r.profitAtBid, 0) / cityResults.length;
      const avgPA = cityResults.reduce((s, r) => s + r.profitAtAsk, 0) / cityResults.length;
      return {
        city,
        totalEvents: cityResults.length,
        wins,
        winRate: Math.round((wins / cityResults.length) * 1000) / 10,
        avgCostBid: Math.round(avgCB * 100) / 100,
        avgCostAsk: Math.round(avgCA * 100) / 100,
        avgProfitBid: Math.round(avgPB * 10000) / 10000,
        avgProfitAsk: Math.round(avgPA * 10000) / 10000,
        roiBid: avgCB > 0 ? Math.round((avgPB / avgCB) * 10000) / 100 : 0,
        roiAsk: avgCA > 0 ? Math.round((avgPA / avgCA) * 10000) / 100 : 0,
      };
    });

    // Get sample bin prices for transparency
    const sampleEvent = await prisma.backtestEvent.findFirst({
      where: { enriched: true },
      orderBy: { forecastDate: 'desc' },
    });
    let sampleBins: any[] = [];
    if (sampleEvent) {
      sampleBins = JSON.parse(sampleEvent.binsJson).map((b: any) => ({
        label: b.subtitle || `${b.floor}-${b.cap}`,
        type: b.type,
        result: b.result,
        realPrice: b.realPrice,
        source: b.priceSource,
        tradeCount: b.realTradeCount,
      }));
    }

    // Compute realistic NWS simulation
    const realisticSimulation = await computeRealisticSimulation([2.0, 2.5, 3.0, 3.5]);

    return NextResponse.json({
      runId: targetRunId,
      totalHistoricalEvents: totalEvents,
      enrichedEvents,
      collectionStatus: { totalEvents, enrichedEvents, unenrichedEvents },
      strategyStats,
      cityStats,
      realisticSimulation,
      sampleEvent: sampleEvent ? { ticker: sampleEvent.eventTicker, city: sampleEvent.city, bins: sampleBins } : null,
    });
  } catch (error: any) {
    console.error('Backtest GET error:', error);
    return NextResponse.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}

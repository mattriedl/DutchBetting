export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { recordRun } from '@/lib/autorun-status';
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { authorizeCaller } from '@/lib/automation-auth';
import { kalshiPublicFetch } from '@/lib/kalshi-api';
import { fetchCF6Data, CITY_STATION_MAP } from '@/lib/nws-climate';

const DELAY_MS = 300;
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/**
 * GET /api/tracker — Get all tracked Dutch bets with W/L status
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as any)?.id;

    const tracks = await prisma.dutchBetTrack.findMany({
      where: { userId },
      orderBy: { forecastDate: 'desc' },
    });

    // Aggregate stats
    const settled = tracks.filter(t => t.settled);
    const wins = settled.filter(t => t.won === true);
    const losses = settled.filter(t => t.won === false);
    const pending = tracks.filter(t => !t.settled);

    const totalPnlBid = settled.reduce((s, t) => s + (t.profitBid ?? 0), 0);
    const totalPnlAsk = settled.reduce((s, t) => s + (t.profitAsk ?? 0), 0);

    // Per-city stats
    const cities = [...new Set(settled.map(t => t.city))];
    const cityStats = cities.map(city => {
      const citySettled = settled.filter(t => t.city === city);
      const cityWins = citySettled.filter(t => t.won === true).length;
      return {
        city,
        total: citySettled.length,
        wins: cityWins,
        losses: citySettled.length - cityWins,
        winRate: citySettled.length > 0 ? Math.round((cityWins / citySettled.length) * 1000) / 10 : 0,
        pnlBid: Math.round(citySettled.reduce((s, t) => s + (t.profitBid ?? 0), 0) * 100) / 100,
      };
    });

    return NextResponse.json({
      summary: {
        total: tracks.length,
        settled: settled.length,
        pending: pending.length,
        wins: wins.length,
        losses: losses.length,
        winRate: settled.length > 0 ? Math.round((wins.length / settled.length) * 1000) / 10 : 0,
        totalPnlBid: Math.round(totalPnlBid * 100) / 100,
        totalPnlAsk: Math.round(totalPnlAsk * 100) / 100,
      },
      cityStats,
      tracks: tracks.map(t => ({
        id: t.id,
        city: t.city,
        marketType: t.marketType,
        eventTicker: t.eventTicker,
        forecastDate: t.forecastDate,
        nwsForecast: t.nwsForecast,
        centerBin: t.centerBin,
        selectedBins: JSON.parse(t.selectedBins),
        totalCostBid: t.totalCostBid,
        totalCostAsk: t.totalCostAsk,
        settled: t.settled,
        winningBin: t.winningBin,
        won: t.won,
        profitBid: t.profitBid,
        profitAsk: t.profitAsk,
        settledAt: t.settledAt,
        createdAt: t.createdAt,
      })),
    });
  } catch (error: any) {
    console.error('Tracker GET error:', error);
    return NextResponse.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/tracker — Check settlements for unsettled tracked bets
 */
export async function POST(req: Request) {
  try {
    // Browser session OR the scheduler's x-automation-secret.
    const caller = await authorizeCaller(req);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = caller.userId;

    const unsettled = await prisma.dutchBetTrack.findMany({
      where: { userId, settled: false },
    });

    let resolved = 0;
    let checked = 0;
    const errors: string[] = [];

    // Group by event ticker to minimize API calls
    const byEvent: Record<string, typeof unsettled> = {};
    for (const t of unsettled) {
      if (!byEvent[t.eventTicker]) byEvent[t.eventTicker] = [];
      byEvent[t.eventTicker].push(t);
    }

    // Pre-fetch NWS CF6 data for all cities with unsettled tracker entries
    const citiesNeeded = new Set(unsettled.map(t => t.city));
    const cf6Cache: Record<string, Record<string, { maxTemp: number | null; minTemp: number | null }>> = {};
    for (const city of citiesNeeded) {
      if (!CITY_STATION_MAP[city]) continue;
      try {
        const temps = await fetchCF6Data(city);
        if (temps.length > 0) {
          cf6Cache[city] = {};
          for (const t of temps) {
            cf6Cache[city][t.date] = { maxTemp: t.maxTemp, minTemp: t.minTemp };
          }
        }
        await sleep(200);
      } catch (e: any) {
        console.error(`CF6 fetch failed for ${city}:`, e?.message);
      }
    }

    for (const [eventTicker, tracks] of Object.entries(byEvent)) {
      checked++;
      await sleep(DELAY_MS);

      try {
        // Use production API for tracker settlement (paper tracking uses real market data)
        const result = await kalshiPublicFetch(
          `/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=50`,
          'production'
        );
        const markets = result?.markets ?? [];

        // Check if the event has settled
        const allSettled = markets.length > 0 && markets.every((m: any) => m?.result === 'yes' || m?.result === 'no');
        if (!allSettled) continue;

        // Find the winning bin
        const winner = markets.find((m: any) => m?.result === 'yes');
        if (!winner) continue;

        let winningBinLabel = '';
        let kalshiFallbackTemp: number | null = null;
        if (winner.strike_type === 'between') {
          winningBinLabel = `${winner.floor_strike}-${winner.cap_strike}`;
          kalshiFallbackTemp = ((winner.floor_strike ?? 0) + (winner.cap_strike ?? 0)) / 2;
        } else if (winner.strike_type === 'less') {
          winningBinLabel = `≤${(winner.cap_strike ?? 0) - 1}`;
          kalshiFallbackTemp = (winner.cap_strike ?? 0) - 1;
        } else if (winner.strike_type === 'greater') {
          winningBinLabel = `≥${(winner.floor_strike ?? 0) + 1}`;
          kalshiFallbackTemp = (winner.floor_strike ?? 0) + 1;
        }

        // For each tracked bet for this event, check if winner is in selected bins
        for (const track of tracks) {
          // Get actual temp from NWS CF6 first, fall back to Kalshi bin midpoint
          let actualTempNum: number | null = null;
          let tempSource = 'Kalshi-estimate';
          const dateStr = track.forecastDate.toISOString().slice(0, 10);
          const cityObs = cf6Cache[track.city];
          if (cityObs && cityObs[dateStr]) {
            const mType = track.marketType?.toUpperCase() === 'LOW' ? 'minTemp' : 'maxTemp';
            actualTempNum = cityObs[dateStr][mType];
            if (actualTempNum != null) tempSource = 'NWS-CF6';
          }
          if (actualTempNum == null) actualTempNum = kalshiFallbackTemp;

          const actualTempStr = actualTempNum != null ? `${actualTempNum}°F` : winningBinLabel;

          const selectedBins = JSON.parse(track.selectedBins);

          // Check if any selected bin's range covers the winner
          let won = false;
          for (const bin of selectedBins) {
            const binTicker = bin.ticker ?? '';
            if (binTicker && binTicker === winner.ticker) {
              won = true;
              break;
            }
            // Also check by range match
            const range = bin.range ?? '';
            if (range === winningBinLabel) {
              won = true;
              break;
            }
            // Check floor/cap match for between bins
            if (winner.strike_type === 'between') {
              const rangeMatch = range.match(/(\d+).*?(\d+)/);
              if (rangeMatch) {
                const rLow = parseInt(rangeMatch[1]);
                const rHigh = parseInt(rangeMatch[2]);
                if (rLow === winner.floor_strike && rHigh === winner.cap_strike) {
                  won = true;
                  break;
                }
              }
            }
          }

          const costBid = track.totalCostBid ?? 0;
          const costAsk = track.totalCostAsk ?? 0;
          // Dutch bet P&L for $10 paper stake:
          // If won: payout = stake / sumImpliedProb, profit = payout - stake
          // If lost: profit = -stake (all contracts expire worthless)
          const PAPER_STAKE = 10;
          const profitBid = costBid > 0
            ? (won ? Math.round((PAPER_STAKE / costBid - PAPER_STAKE) * 100) / 100 : -PAPER_STAKE)
            : 0;
          const profitAsk = costAsk > 0
            ? (won ? Math.round((PAPER_STAKE / costAsk - PAPER_STAKE) * 100) / 100 : -PAPER_STAKE)
            : 0;

          await prisma.dutchBetTrack.update({
            where: { id: track.id },
            data: {
              settled: true,
              winningBin: winningBinLabel,
              actualTemp: actualTempStr,
              won,
              profitBid,
              profitAsk,
              settledAt: new Date(),
            },
          });
          resolved++;
        }
      } catch (err: any) {
        if (err?.message?.includes?.('429')) await sleep(3000);
        errors.push(`${eventTicker}: ${err?.message}`);
      }
    }

    recordRun('dashboard-settle', caller.automated, `checked ${checked}, settled ${resolved}, ${unsettled.length - resolved} still open`);
    return NextResponse.json({
      success: true,
      checked,
      resolved,
      remainingUnsettled: unsettled.length - resolved,
      errors: errors.slice(0, 5),
    });
  } catch (error: any) {
    console.error('Tracker POST error:', error);
    return NextResponse.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}

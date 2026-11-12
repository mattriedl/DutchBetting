export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow up to 60s for sequential Kalshi API calls

import { recordRun } from '@/lib/autorun-status';
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';
import { authorizeCaller } from '@/lib/automation-auth';
import { kalshiTakerFeeCents, kalshiEffectiveCents } from '@/lib/kalshi-fees';
import { fetchClimateMarkets, parseTemperatureMarket } from '@/lib/kalshi-api';
import { fetchNwsForecast, CITY_COORDINATES } from '@/lib/nws-api';
import { findDutchPositions, calculateDutchBet, calculateUniformContracts } from '@/lib/dutch-betting';
import { isMarketStillBettable } from '@/lib/market-timing';

export async function POST(req: Request) {
  try {
    // Browser session OR the scheduler's x-automation-secret (acts as AUTOMATION_USER_EMAIL).
    const caller = await authorizeCaller(req);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = caller.userId;
    const credential = await prisma.apiCredential.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    const environment = credential?.environment ?? 'production';
    const results = {
      marketsFound: 0,
      marketsSaved: 0,
      highMarkets: 0,
      lowMarkets: 0,
      forecastsFetched: 0,
      historySaved: 0,
      errors: [] as string[],
      cities: [] as string[],
    };

    // Step 1: Fetch climate markets from Kalshi (public endpoint)
    console.log('Fetching climate markets from Kalshi...');
    let rawMarkets: any[] = [];
    try {
      rawMarkets = await fetchClimateMarkets(environment);
      results.marketsFound = rawMarkets.length;
      console.log(`Found ${rawMarkets.length} raw markets from Kalshi`);
      // Log first market's fields for debugging (price + strike fields)
      if (rawMarkets.length > 0) {
        const sample = rawMarkets[0];
        console.log('Sample market fields:', JSON.stringify({
          ticker: sample?.ticker,
          title: sample?.title,
          subtitle: sample?.subtitle,
          yes_bid: sample?.yes_bid,
          yes_bid_dollars: sample?.yes_bid_dollars,
          yes_ask_dollars: sample?.yes_ask_dollars,
          last_price: sample?.last_price,
          last_price_dollars: sample?.last_price_dollars,
          no_bid_dollars: sample?.no_bid_dollars,
          volume: sample?.volume,
          volume_fp: sample?.volume_fp,
          open_interest: sample?.open_interest,
          open_interest_fp: sample?.open_interest_fp,
          floor_strike: sample?.floor_strike,
          cap_strike: sample?.cap_strike,
          strike_type: sample?.strike_type,
        }));
        // Also log a T-contract if available for debugging threshold parsing
        const tContract = rawMarkets.find((m: any) => /T\d/.test(m?.ticker ?? ''));
        if (tContract) {
          console.log('Sample T-contract:', JSON.stringify({
            ticker: tContract?.ticker,
            title: tContract?.title,
            subtitle: tContract?.subtitle,
            floor_strike: tContract?.floor_strike,
            cap_strike: tContract?.cap_strike,
            strike_type: tContract?.strike_type,
          }));
        }
      }
    } catch (error: any) {
      console.error('Error fetching Kalshi markets:', error?.message);
      results.errors.push(`Kalshi market fetch: ${error?.message}`);
    }

    // Step 2: Parse and save markets to database
    // Parse all markets first, THEN do atomic delete+insert in a transaction
    // This prevents a window where the DB has no market data during refresh
    const citiesFound = new Set<string>();

    if (rawMarkets.length > 0) {
      const parsedRecords: any[] = [];
      for (const rawMarket of rawMarkets) {
        const parsed = parseTemperatureMarket(rawMarket);
        if (!parsed) continue;
        citiesFound.add(parsed.city);
        if (parsed.marketType === 'high') results.highMarkets++;
        else results.lowMarkets++;
        parsedRecords.push({
          kalshiMarketId: parsed.ticker,
          eventTicker: rawMarket?._eventTicker ?? '',
          city: parsed.city,
          state: parsed.state ?? '',
          marketType: parsed.marketType,
          tempRangeLow: parsed.tempLow,
          tempRangeHigh: parsed.tempHigh,
          yesPrice: parsed.yesPrice,
          yesBid: parsed.yesBid,
          yesAsk: parsed.yesAsk,
          lastPrice: parsed.lastPrice,
          noPrice: parsed.noPrice,
          volume: parsed.volume,
          openInterest: parsed.openInterest,
          expirationTime: parsed.expirationTime ? new Date(parsed.expirationTime) : new Date(),
          lastUpdated: new Date(),
        });
      }

      // Atomic swap: delete old + insert new in one transaction
      // If anything fails, the old data remains intact
      try {
        await prisma.$transaction(async (tx) => {
          await tx.marketData.deleteMany({});
          await tx.marketData.createMany({ data: parsedRecords });
        }, { timeout: 30000 });
        results.marketsSaved = parsedRecords.length;
      } catch (txErr: any) {
        console.error('Market data transaction error:', txErr?.message);
        results.errors.push(`Market save transaction: ${txErr?.message}`);
      }
    }

    results.cities = Array.from(citiesFound);

    // Step 3: Fetch NWS forecasts (multi-day: today + tomorrow + day after)
    console.log('Fetching NWS forecasts...');
    // forecastsByCity keyed by city, then by YYYY-MM-DD date string
    const forecastsByCity: Record<string, Record<string, { high: number | null; low: number | null }>> = {};

    for (const [cityKey, coords] of Object.entries(CITY_COORDINATES)) {
      try {
        const forecastDays = await fetchNwsForecast(cityKey);
        // Delete all old forecasts for this city
        await prisma.nwsForecast.deleteMany({
          where: { city: coords.city },
        });

        for (const forecast of forecastDays) {
          if (forecast?.forecastHigh !== null || forecast?.forecastLow !== null) {
            const forecastDateObj = new Date(forecast.forecastDate);
            const dateKey = forecastDateObj.toISOString().slice(0, 10); // YYYY-MM-DD

            await prisma.nwsForecast.create({
              data: {
                city: forecast.city,
                state: forecast.state,
                latitude: coords.lat,
                longitude: coords.lon,
                forecastHigh: forecast.forecastHigh,
                forecastLow: forecast.forecastLow,
                forecastDate: forecastDateObj,
                retrievedAt: new Date(),
                confidence: forecast.confidence,
                source: 'NWS',
              },
            });

            if (!forecastsByCity[forecast.city]) forecastsByCity[forecast.city] = {};
            forecastsByCity[forecast.city][dateKey] = {
              high: forecast.forecastHigh,
              low: forecast.forecastLow,
            };
            results.forecastsFetched++;
          } else if (forecast?.error) {
            results.errors.push(`NWS ${coords.city}: ${forecast.error}`);
          }
        }
      } catch (nwsError: any) {
        console.error(`NWS error for ${cityKey}:`, nwsError?.message);
        results.errors.push(`NWS ${coords.city}: ${nwsError?.message}`);
      }
    }

    // Helper: parse event date string (YYYY-MM-DD) from eventTicker
    function parseEventDateStr(et: string): string {
      const dm = et.match(/(\d{2})([A-Z]{3})(\d{2})$/);
      if (!dm) return '';
      const mm: Record<string,string> = {JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12'};
      return `20${dm[1]}-${mm[dm[2]] ?? '01'}-${dm[3]}`;
    }
    // Helper: detect B-contract from ticker
    function isBContract(ticker: string): boolean {
      return /-B\d/.test(ticker);
    }

    const allMarkets = await prisma.marketData.findMany({
      orderBy: [{ city: 'asc' }, { tempRangeLow: 'asc' }],
    });

    // Group markets by city + marketType + eventDate — so each event day is analyzed separately
    const groupedByDate: Record<string, any[]> = {};
    for (const m of allMarkets) {
      const eventDateStr = parseEventDateStr(m.eventTicker);
      if (!eventDateStr) continue;
      const key = `${m.city}__${m.marketType}__${eventDateStr}`;
      if (!groupedByDate[key]) groupedByDate[key] = [];
      groupedByDate[key].push(m);
    }

    // Fetch auto-bet config early so Steps 4/5/7 can all use the user's stake setting
    const autoBetConfig = await prisma.autoBetConfig.findUnique({ where: { userId } });

    // Step 4: Save prediction history entries for tracking accuracy
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const [groupKey, cityMarkets] of Object.entries(groupedByDate)) {
      const [city, marketType, eventDateStr] = groupKey.split('__');

      // Skip stale markets — no point recording predictions for events where
      // the temperature extreme has already occurred (inflates pending count)
      if (!isMarketStillBettable(city, eventDateStr, marketType)) continue;

      // Look up the NWS forecast for this specific event date
      const cityForecasts = forecastsByCity[city];
      if (!cityForecasts) continue;
      const dayForecast = cityForecasts[eventDateStr];
      if (!dayForecast) continue;

      const forecastTemp = marketType === 'high' ? dayForecast.high : dayForecast.low;
      if (forecastTemp == null) continue;

      const eventDate = new Date(`${eventDateStr}T00:00:00Z`);
      const eventDateEnd = new Date(eventDate.getTime() + 86400000);

      // Check if we already have a history entry for this city/type/date
      const existingHistory = await prisma.predictionHistory.findFirst({
        where: {
          city,
          marketType,
          forecastDate: { gte: eventDate, lt: eventDateEnd },
        },
      });

      if (!existingHistory) {
        const bContracts = cityMarkets.filter((m: any) => isBContract(m.kalshiMarketId));
        const marketInputs = bContracts.map((m: any) => ({
          ticker: m.kalshiMarketId,
          tempLow: m.tempRangeLow,
          tempHigh: m.tempRangeHigh,
          yesPrice: m.yesPrice,
        }));

        const positions = findDutchPositions(forecastTemp, marketInputs);
        const userStake = autoBetConfig?.maxStakePerBet ?? 10;
        const analysis = calculateDutchBet(positions, userStake, forecastTemp);
        const centerPosition = analysis.positions.length > 1 ? analysis.positions[1] : analysis.positions[0];

        // Skip edge cases — incomplete bin coverage or far-off-forecast longshots
        if (analysis.isEdgeCase) {
          console.log(`[Refresh] Skipping prediction for ${city} ${marketType}: ${analysis.edgeCaseReason}`);
          continue;
        }

        try {
          await prisma.predictionHistory.create({
            data: {
              city,
              state: cityMarkets[0]?.state ?? cityMarkets[0]?.city ?? '',
              marketType,
              forecastDate: eventDate,
              nwsForecast: forecastTemp,
              centerRange: centerPosition?.range ?? '',
              dutchBetBins: JSON.stringify(analysis.positions.map((p: any) => ({ range: p.range, ticker: p.ticker }))),
              centerOdds: centerPosition?.odds ?? 0,
              profitMargin: analysis.profitMargin,
              dutchBetResult: 'pending',
            },
          });
          results.historySaved++;
        } catch (histErr: any) {
          console.error('History save error:', histErr?.message);
        }
      }
    }

    // Step 5: Auto-record Dutch bet picks for forward-tracking (HIGH + LOW)
    let tracksRecorded = 0;
    for (const [groupKey, cityMarkets] of Object.entries(groupedByDate)) {
      const [city, marketType, eventDateStr] = groupKey.split('__');

      // Look up NWS forecast for this event date
      const cityForecasts = forecastsByCity[city];
      if (!cityForecasts) continue;
      const dayForecast = cityForecasts[eventDateStr];
      if (!dayForecast) continue;

      const forecastTemp = marketType === 'high' ? dayForecast.high : dayForecast.low;
      if (forecastTemp == null) continue;

      const eventTicker = cityMarkets[0]?.eventTicker ?? '';
      if (!eventTicker) continue;

      const seriesTicker = eventTicker.replace(/-\d{2}[A-Z]{3}\d{2}$/, '');
      const forecastDate = new Date(`${eventDateStr}T12:00:00Z`);

      // Check if already tracked
      const existingTrack = await prisma.dutchBetTrack.findUnique({
        where: { eventTicker_city_userId: { eventTicker, city, userId } },
      });
      if (existingTrack) continue;

      // Build Dutch bet selection — only B-contracts (2° bins)
      const bContractsTracker = cityMarkets.filter((m: any) => isBContract(m.kalshiMarketId));
      const marketInputs = bContractsTracker.map((m: any) => ({
        ticker: m.kalshiMarketId,
        tempLow: m.tempRangeLow,
        tempHigh: m.tempRangeHigh,
        yesPrice: m.yesPrice,
      }));
      const positions = findDutchPositions(forecastTemp, marketInputs);
      const trackerStake = autoBetConfig?.maxStakePerBet ?? 10;
      const analysis = calculateDutchBet(positions, trackerStake, forecastTemp);

      // Skip edge cases for tracker too — don't paper-track longshots
      if (analysis.isEdgeCase) {
        console.log(`[Tracker] Skipping ${city} ${marketType}: ${analysis.edgeCaseReason}`);
        continue;
      }

      const selectedBins = analysis.positions.map((p: any) => ({
        range: p.range,
        ticker: p.ticker,
        yesPrice: p.odds, // price in cents (e.g., 29 = 29¢)
      }));

      // totalCostBid/Ask = sum of implied probabilities (sum of price_cents/100)
      // Bid = 1¢ less per contract (what you could sell at), Ask = actual cost to buy
      const totalCostBid = selectedBins.reduce((s: number, b: any) => s + (Math.max(0, (b.yesPrice ?? 0) - 1) / 100), 0);
      // Ask = take liquidity, so include Kalshi's taker fee; Bid = resting limit, no fee on climate series.
      const totalCostAsk = selectedBins.reduce((s: number, b: any) => s + kalshiEffectiveCents((b.yesPrice ?? 0) + 1) / 100, 0);

      const centerPosition = analysis.positions.length > 1 ? analysis.positions[1] : analysis.positions[0];

      try {
        await prisma.dutchBetTrack.create({
          data: {
            userId,
            city,
            marketType: marketType === 'high' ? 'HIGH' : 'LOW',
            seriesTicker,
            eventTicker,
            forecastDate,
            nwsForecast: forecastTemp,
            centerBin: centerPosition?.range ?? '',
            selectedBins: JSON.stringify(selectedBins),
            totalCostBid: Math.round(totalCostBid * 100) / 100,
            totalCostAsk: Math.round(totalCostAsk * 100) / 100,
          },
        });
        tracksRecorded++;
      } catch (trackErr: any) {
        console.error('Track record error:', trackErr?.message);
      }
    }

    // Step 6: Auto-resolve pending predictions using settled Kalshi data
    const { resolvePendingPredictions } = await import('@/lib/resolve-predictions');
    const resolvedCount = await resolvePendingPredictions();

    // Step 7: Full-auto betting — if enabled, place bets on qualifying opportunities
    let autoBetsPlaced = 0;
    try {
      // Real-money full-auto only runs from an unattended scheduler when explicitly allowed.
      const automatedLiveOk = !caller.automated || process.env.ALLOW_SCHEDULED_LIVE_BETS === 'true';
      if (automatedLiveOk && autoBetConfig?.enabled && autoBetConfig?.mode === 'full-auto') {
        const RATING_ORDER: Record<string, number> = { excellent: 0, good: 1, marginal: 2, none: 3 };
        const minMargin = autoBetConfig.minProfitMargin ?? 5;
        const minRating = autoBetConfig.minRating ?? 'good';
        const maxStake = autoBetConfig.maxStakePerBet ?? 10;
        const maxDaily = autoBetConfig.maxDailySpend ?? 100;
        const slippage = autoBetConfig.slippageCents ?? 2;
        const env = autoBetConfig.environment ?? 'demo';

        // Get today's spend
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const dailyOrders = await prisma.autoBetOrder.findMany({
          where: { userId, createdAt: { gte: todayStart }, status: { in: ['filled', 'partial', 'pending'] } },
          select: { totalCost: true },
        });
        let dailySpentCents = dailyOrders.reduce((s, o) => s + (o.totalCost ?? 0), 0);

        // Run analysis on all current markets
        const allMarkets = await prisma.marketData.findMany();
        const allForecasts = await prisma.nwsForecast.findMany();

        // Parse eventDate from eventTicker (e.g., KXHIGHNY-26JUN11 -> 2026-06-11)
        function parseEventDateFromTicker(et: string): string {
          const match = et.match(/(\d{2})([A-Z]{3})(\d{2})/);
          if (!match) return '';
          const months: Record<string, string> = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
          return `20${match[1]}-${months[match[2]] ?? '01'}-${match[3]}`;
        }

        // Group markets by city+marketType+eventDate
        const grouped: Record<string, typeof allMarkets> = {};
        for (const m of allMarkets) {
          const evDate = parseEventDateFromTicker(m.eventTicker);
          const key = `${m.city}__${m.marketType}__${evDate}`;
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(m);
        }

        // Build forecast lookup
        const fcLookup: Record<string, any> = {};
        for (const f of allForecasts) {
          const dateStr = f.forecastDate ? new Date(f.forecastDate).toISOString().slice(0, 10) : '';
          fcLookup[`${f.city}__${dateStr}`] = f;
        }

        const creds = await prisma.apiCredential.findFirst({ where: { userId }, orderBy: { updatedAt: 'desc' } });
        if (creds?.keyId && creds?.privateKey) {
          for (const [key, markets] of Object.entries(grouped)) {
            const [city, marketType, eventDate] = key.split('__');

            // CRITICAL: Skip markets where the temp extreme has already occurred
            if (!isMarketStillBettable(city, eventDate, marketType)) {
              continue;
            }

            const fc = fcLookup[`${city}__${eventDate}`];
            if (!fc) continue;

            const forecastTemp = marketType === 'high' ? fc.forecastHigh : fc.forecastLow;
            if (forecastTemp == null) continue; // no NWS figure for this day (0°F is a real forecast)

            // Filter to B-contracts only (between contracts for Dutch betting)
            const marketInputs = markets.filter(m => /-B\d/.test(m.kalshiMarketId) || (m.tempRangeHigh - m.tempRangeLow) <= 3).map(m => ({
              ticker: m.kalshiMarketId, tempLow: m.tempRangeLow, tempHigh: m.tempRangeHigh, yesPrice: m.yesPrice,
            }));
            const positions = findDutchPositions(forecastTemp, marketInputs);
            const analysis = calculateDutchBet(positions, maxStake, forecastTemp);

            // CRITICAL: Never auto-bet on edge cases (incomplete bins or off-forecast)
            if (analysis.isEdgeCase) {
              console.log(`[AutoBet] Skipping ${city} ${marketType}: ${analysis.edgeCaseReason}`);
              continue;
            }
            if (!analysis.isViable || analysis.profitMargin < minMargin) continue;
            if ((RATING_ORDER[analysis.rating] ?? 3) > (RATING_ORDER[minRating] ?? 1)) continue;

            // Check daily limit
            if ((dailySpentCents / 100) + maxStake > maxDaily) {
              console.log(`Auto-bet: daily limit reached ($${(dailySpentCents / 100).toFixed(2)} / $${maxDaily})`);
              break;
            }

            // Check for duplicate
            const eventTicker = markets[0]?.eventTicker ?? '';
            const existing = await prisma.autoBetOrder.findFirst({
              where: { userId, eventTicker, city, status: { in: ['filled', 'partial', 'pending'] } },
            });
            if (existing) continue;

            // Place orders
            const { kalshiFetch } = await import('@/lib/kalshi-api');
            const binOrders: any[] = [];
            let totalCostCents = 0;
            let feeCentsTotal = 0; // Kalshi taker fees, included in totalCostCents
            let anyFilled = false;
            let allFilled = true;

            // Sort positions cheapest first — cheapest bins have most liquidity
            const sortedPositions = [...analysis.positions].sort((a, b) => a.odds - b.odds);
            // UNIFORM CONTRACT ALLOCATION — same count in every bin so all payouts match
            // and the winning bin always covers the combined cost (guaranteed profit).
            const sortedBidPrices = sortedPositions.map((p) => Math.min(Math.round(p.odds) + slippage, 99));
            const uniformCount = calculateUniformContracts(sortedBidPrices, Math.round(maxStake * 100));
            for (const pos of sortedPositions) {
              const basePrice = Math.round(pos.odds);
              const bidPrice = Math.min(basePrice + slippage, 99);
              if (basePrice <= 0 || basePrice >= 100) { allFilled = false; continue; }
              const count = uniformCount;
              try {
                const priceDollars = (bidPrice / 100).toFixed(2);
                const countStr = count.toFixed(2);
                const orderResult = await kalshiFetch('/portfolio/events/orders', creds.keyId, creds.privateKey, env, {
                  method: 'POST',
                  body: JSON.stringify({ ticker: pos.ticker, side: 'bid', count: countStr, price: priceDollars, time_in_force: 'good_till_canceled', self_trade_prevention_type: 'taker_at_cross' }),
                });
                const order = orderResult?.order ?? orderResult;
                const fillCount = parseInt(order?.fill_count ?? '0', 10);
                const remainingCount = parseInt(order?.remaining_count ?? String(count), 10);
                const fStatus = remainingCount === 0 ? 'filled' : fillCount > 0 ? 'partial' : 'resting';
                binOrders.push({ ticker: pos.ticker, range: pos.range, price: bidPrice, count, stake: pos.stake, orderId: order?.order_id ?? '', fillStatus: fStatus });
                const legFee = kalshiTakerFeeCents(count, bidPrice);
                feeCentsTotal += legFee;
                totalCostCents += count * bidPrice + legFee;
                if (fStatus !== 'filled') allFilled = false; else anyFilled = true;
                await new Promise(r => setTimeout(r, 200));
              } catch (err: any) {
                binOrders.push({ ticker: pos.ticker, range: pos.range, price: bidPrice, count, stake: pos.stake, fillStatus: 'failed', errorMessage: err?.message });
                allFilled = false;
              }
            }

            // Resting GTC orders are live on the book and can still fill: record them as 'pending'
            // (not 'failed') so the duplicate check and the daily cap see them on the next refresh.
            const anyResting = binOrders.some((b: any) => b.fillStatus === 'resting' && b.orderId);
            const status = allFilled && binOrders.every((b: any) => b.orderId) ? 'filled' : anyFilled ? 'partial' : anyResting ? 'pending' : 'failed';
            await prisma.autoBetOrder.create({
              data: {
                userId, city, state: markets[0]?.state ?? '', marketType, eventTicker,
                forecastDate: eventDate, nwsForecast: forecastTemp, profitMargin: analysis.profitMargin,
                rating: analysis.rating, totalStake: maxStake, totalCost: totalCostCents, feeCents: feeCentsTotal,
                expectedPayout: maxStake + analysis.guaranteedReturn, environment: env,
                status, bins: JSON.stringify(binOrders), settledResult: 'pending',
              },
            });
            dailySpentCents += totalCostCents;
            autoBetsPlaced++;
          }
        }
      }
    } catch (autoBetErr: any) {
      console.error('Auto-bet error during refresh:', autoBetErr?.message);
    }

    // Step 8: Auto-settle — check if any placed auto-bets have settled on Kalshi
    // Uses NWS CF6 for official actual temps; falls back to Kalshi bin midpoint
    let autoBetsSettled = 0;
    try {
      const unsettledOrders = await prisma.autoBetOrder.findMany({
        where: {
          userId,
          status: { in: ['filled', 'partial', 'pending'] },
          OR: [{ settledResult: null }, { settledResult: 'pending' }],
        },
      });
      if (unsettledOrders.length > 0) {
        const { kalshiPublicFetch: pubFetch } = await import('@/lib/kalshi-api');
        const { fetchCF6Data, CITY_STATION_MAP } = await import('@/lib/nws-climate');

        // Pre-fetch CF6 data for all cities with unsettled orders
        const citiesNeeded = new Set(unsettledOrders.map(o => o.city));
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
            await new Promise(r => setTimeout(r, 200));
          } catch (e: any) {
            console.error(`CF6 fetch failed for ${city}:`, e?.message);
          }
        }

        const byEvent: Record<string, typeof unsettledOrders> = {};
        for (const o of unsettledOrders) {
          const key = `${o.eventTicker}__${o.environment ?? 'production'}`;
          if (!byEvent[key]) byEvent[key] = [];
          byEvent[key].push(o);
        }
        for (const [eventKey, orders] of Object.entries(byEvent)) {
          const [eventTicker, orderEnv] = eventKey.split('__');
          await new Promise(r => setTimeout(r, 300));
          try {
            const res = await pubFetch(`/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=50`, orderEnv ?? 'production');
            const mkts = res?.markets ?? [];
            const allSettled = mkts.length > 0 && mkts.every((m: any) => m?.result === 'yes' || m?.result === 'no');
            if (!allSettled) continue;
            const winner = mkts.find((m: any) => m?.result === 'yes');
            if (!winner) continue;
            let winLabel = '';
            let kalshiFallback: number | null = null;
            if (winner.strike_type === 'between') {
              winLabel = `${winner.floor_strike}-${winner.cap_strike}`;
              kalshiFallback = ((winner.floor_strike ?? 0) + (winner.cap_strike ?? 0)) / 2;
            } else if (winner.strike_type === 'less') {
              winLabel = `≤${(winner.cap_strike ?? 0) - 1}`;
              kalshiFallback = (winner.cap_strike ?? 0) - 1;
            } else if (winner.strike_type === 'greater') {
              winLabel = `≥${(winner.floor_strike ?? 0) + 1}`;
              kalshiFallback = (winner.floor_strike ?? 0) + 1;
            }
            for (const order of orders) {
              // Try NWS CF6 for actual temp first
              let actTemp: number | null = null;
              let tempSource = 'Kalshi-estimate';
              const cityObs = cf6Cache[order.city];
              const dateStr = order.forecastDate;
              if (cityObs && dateStr && cityObs[dateStr]) {
                actTemp = order.marketType === 'high' ? cityObs[dateStr].maxTemp : cityObs[dateStr].minTemp;
                if (actTemp != null) tempSource = 'NWS-CF6';
              }
              if (actTemp == null) actTemp = kalshiFallback;

              let bins: any[] = [];
              try { bins = JSON.parse(order.bins); } catch {}
              let won = false;
              let winBin: any = null;
              for (const bin of bins) {
                if ((bin.ticker && bin.ticker === winner.ticker) ||
                    (bin.range && bin.range === winLabel)) {
                  won = true; winBin = bin; break;
                }
                if (winner.strike_type === 'between' && bin.range) {
                  const m = bin.range.match(/(\d+).*?(\d+)/);
                  if (m && parseInt(m[1]) === winner.floor_strike && parseInt(m[2]) === winner.cap_strike) {
                    won = true; winBin = bin; break;
                  }
                }
              }
              const payoutCents = won && winBin ? (winBin.count ?? 0) * 100 : 0;
              const netProfitCents = payoutCents - (order.totalCost ?? 0);
              await prisma.autoBetOrder.update({
                where: { id: order.id },
                data: {
                  settledResult: won ? 'won' : 'lost',
                  settledPayout: payoutCents,
                  actualTemp: actTemp,
                  tempSource,
                  winningBin: winLabel,
                  netProfit: netProfitCents,
                },
              });
              autoBetsSettled++;
            }
          } catch (err: any) {
            if (err?.message?.includes?.('429')) await new Promise(r => setTimeout(r, 3000));
          }
        }
      }
    } catch (settleErr: any) {
      console.error('Auto-bet settle error during refresh:', settleErr?.message);
    }

    recordRun('dashboard-refresh', caller.automated, `${results.marketsSaved} markets, ${results.forecastsFetched} forecasts, ${tracksRecorded} new demo picks, ${resolvedCount} forecasts graded`);
    return NextResponse.json({
      success: true,
      message: `Refreshed ${results.marketsSaved} markets (${results.highMarkets} high, ${results.lowMarkets} low) across ${results.cities.length} cities with ${results.forecastsFetched} NWS forecasts`,
      ...results,
      tracksRecorded,
      resolvedCount,
      autoBetsPlaced,
      autoBetsSettled,
    });
  } catch (error: any) {
    console.error('Refresh error:', error);
    return NextResponse.json({ error: error?.message ?? 'Internal server error' }, { status: 500 });
  }
}

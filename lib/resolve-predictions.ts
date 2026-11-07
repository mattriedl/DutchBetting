import { prisma } from '@/lib/db';
import { kalshiPublicFetch, parseTemperatureMarket } from '@/lib/kalshi-api';
import { fetchAllObservedTemps, CITY_STATION_MAP } from '@/lib/nws-climate';

// Reverse map: city name + marketType → series ticker prefix
const CITY_TO_SERIES: Record<string, { high: string; low: string }> = {
  'New York': { high: 'KXHIGHNY', low: 'KXLOWTNYC' },
  'Chicago': { high: 'KXHIGHCHI', low: 'KXLOWTCHI' },
  'Miami': { high: 'KXHIGHMIA', low: 'KXLOWTMIA' },
  'Denver': { high: 'KXHIGHDEN', low: 'KXLOWTDEN' },
  'Philadelphia': { high: 'KXHIGHPHIL', low: 'KXLOWTPHIL' },
  'Washington': { high: 'KXHIGHTDC', low: 'KXLOWTDC' },
  'Boston': { high: 'KXHIGHTBOS', low: 'KXLOWTBOS' },
  'Houston': { high: 'KXHIGHTHOU', low: 'KXLOWTHOU' },
  'Phoenix': { high: 'KXHIGHTPHX', low: 'KXLOWTPHX' },
  'Seattle': { high: 'KXHIGHTSEA', low: 'KXLOWTSEA' },
  'Las Vegas': { high: 'KXHIGHTLV', low: 'KXLOWTLV' },
  'San Francisco': { high: 'KXHIGHTSFO', low: 'KXLOWTSFO' },
  'Dallas': { high: 'KXHIGHTDAL', low: 'KXLOWTDAL' },
  'Atlanta': { high: 'KXHIGHTATL', low: 'KXLOWTATL' },
  'Oklahoma City': { high: 'KXHIGHTOKC', low: 'KXLOWTOKC' },
  'Minneapolis': { high: 'KXHIGHTMIN', low: 'KXLOWTMIN' },
  'New Orleans': { high: 'KXHIGHTNOLA', low: 'KXLOWTNOLA' },
  'San Antonio': { high: 'KXHIGHTSATX', low: 'KXLOWTSATX' },
  'Austin': { high: 'KXHIGHAUS', low: 'KXLOWTAUS' },
  'Los Angeles': { high: 'KXHIGHLAX', low: 'KXLOWTLAX' },
};

// Format date as Kalshi event ticker date component: 26JUN05 for 2026-06-05
function toKalshiDatePart(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const monthIdx = parseInt(m, 10) - 1;
  return `${y.slice(2)}${months[monthIdx]}${d}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Auto-resolve pending predictions using official NWS Climatological Report (CF6) data.
 * 
 * Kalshi settles temperature markets using the NWS CLI/CF6 reports.
 * PRIMARY source: NWS CF6 (Preliminary Local Climatological Data) — has full month of daily max/min temps
 * FALLBACK: Kalshi market settlement (winning bin midpoint) — only if CF6 data unavailable
 * 
 * Returns the count of resolved predictions.
 */
export async function resolvePendingPredictions(): Promise<number> {
  let resolvedCount = 0;

  try {
    const pendingPredictions = await prisma.predictionHistory.findMany({
      where: { dutchBetResult: 'pending' },
    });

    if (pendingPredictions.length === 0) return 0;

    console.log(`Resolving ${pendingPredictions.length} pending predictions...`);

    // Step 1: Fetch official observed temps from NWS CF6 for all cities
    console.log('Fetching official NWS CF6 climatological data for all cities...');
    let observedTemps: Record<string, Record<string, { maxTemp: number | null; minTemp: number | null }>> = {};
    try {
      observedTemps = await fetchAllObservedTemps();
      const citiesWithData = Object.keys(observedTemps).length;
      const totalDays = Object.values(observedTemps).reduce((s, d) => s + Object.keys(d).length, 0);
      console.log(`Got CF6 data: ${citiesWithData} cities, ${totalDays} total day-records`);
    } catch (cf6Err: any) {
      console.error('CF6 fetch failed, will fall back to Kalshi settlements:', cf6Err?.message);
    }

    // Group predictions by unique event (city + marketType + date)
    const eventGroups: Record<string, typeof pendingPredictions> = {};
    for (const pred of pendingPredictions) {
      const dateStr = pred.forecastDate.toISOString().slice(0, 10);
      const key = `${pred.city}__${pred.marketType}__${dateStr}`;
      if (!eventGroups[key]) eventGroups[key] = [];
      eventGroups[key].push(pred);
    }

    console.log(`Grouped into ${Object.keys(eventGroups).length} unique events`);

    // Step 2: Try to resolve each group using CF6 data first
    const unresolvedGroups: string[] = [];

    for (const [key, preds] of Object.entries(eventGroups)) {
      const [city, marketType, dateStr] = key.split('__');
      
      // Try CF6 data first (official NWS source)
      const cityObs = observedTemps[city];
      const dayObs = cityObs?.[dateStr];
      
      let actualTemp: number | null = null;
      let source = 'unknown';
      
      if (dayObs) {
        // Use official NWS CF6 observed temperature
        actualTemp = marketType === 'high' ? dayObs.maxTemp : dayObs.minTemp;
        source = 'NWS-CF6';
      }
      
      if (actualTemp == null) {
        // CF6 doesn't have data for this date yet — queue for Kalshi fallback
        unresolvedGroups.push(key);
        continue;
      }
      
      console.log(`${city} ${marketType} ${dateStr}: actual=${actualTemp}°F (source: ${source})`);
      
      // Resolve predictions with the official temp
      for (const pred of preds) {
        resolvedCount += await resolvePrediction(pred, actualTemp, source);
      }
    }

    // Step 3: For groups without CF6 data, fall back to Kalshi settlement
    if (unresolvedGroups.length > 0) {
      console.log(`${unresolvedGroups.length} groups not resolved via CF6, trying Kalshi fallback...`);
      let queryCount = 0;
      
      for (const key of unresolvedGroups) {
        const [city, marketType, dateStr] = key.split('__');
        const preds = eventGroups[key];
        const cityMapping = CITY_TO_SERIES[city];
        if (!cityMapping) continue;
        
        const seriesTicker = marketType === 'high' ? cityMapping.high : cityMapping.low;
        const datePart = toKalshiDatePart(dateStr);
        const eventTicker = `${seriesTicker}-${datePart}`;
        
        if (queryCount > 0) await sleep(350);
        queryCount++;
        
        try {
          const result = await kalshiPublicFetch(
            `/markets?event_ticker=${eventTicker}&limit=50`,
            'production'
          );
          const markets = result?.markets ?? [];
          if (markets.length === 0) continue;
          
          const settledMarkets = markets.filter((m: any) => m?.result && m.result !== '');
          if (settledMarkets.length === 0) continue;
          
          const winner = settledMarkets.find((m: any) => m.result === 'yes');
          if (!winner) continue;
          
          // Estimate actual temp from winning bin (less precise than CF6)
          let actualTemp: number | null = null;
          const ticker = winner.ticker ?? '';
          const isBContract = /-B\d/.test(ticker);
          const floorStrike = Number(winner.floor_strike);
          const capStrike = Number(winner.cap_strike);
          
          if (isBContract && !isNaN(floorStrike) && !isNaN(capStrike)) {
            actualTemp = (floorStrike + capStrike) / 2;
          } else if (winner.strike_type === 'less' && !isNaN(capStrike)) {
            actualTemp = capStrike - 1;
          } else if (winner.strike_type === 'greater' && !isNaN(floorStrike)) {
            actualTemp = floorStrike + 1;
          }
          
          if (actualTemp == null) continue;
          
          console.log(`${eventTicker}: Kalshi fallback, actual temp ≈ ${actualTemp}°F (winner: ${ticker})`);
          
          for (const pred of preds) {
            resolvedCount += await resolvePrediction(pred, actualTemp, 'Kalshi-estimate');
          }
        } catch (fetchErr: any) {
          console.error(`Kalshi fallback failed for ${eventTicker}:`, fetchErr?.message);
          if (fetchErr?.message?.includes?.('429')) await sleep(3000);
        }
      }
    }
  } catch (err: any) {
    console.error('Auto-resolve error:', err?.message);
  }

  console.log(`Resolved ${resolvedCount} predictions`);
  return resolvedCount;
}

/**
 * Resolve a single prediction with a known actual temperature.
 * Returns 1 if resolved, 0 if error.
 */
async function resolvePrediction(pred: any, actualTemp: number, tempSource: string = 'unknown'): Promise<number> {
  const forecastError = actualTemp - (pred.nwsForecast ?? 0);
  const absError = Math.abs(forecastError);

  // Check if actual temp falls within ANY of the 3 Dutch bet bins
  let wouldHaveWon = false;
  
  // First try: use stored dutchBetBins JSON (new predictions have this)
  if (pred.dutchBetBins) {
    try {
      const bins = JSON.parse(pred.dutchBetBins as string) as { range: string; ticker: string }[];
      for (const bin of bins) {
        const rangeMatch = bin.range.match(/(\d+)[°]?.*?-.*?(\d+)/);
        if (rangeMatch) {
          const low = parseInt(rangeMatch[1], 10);
          const high = parseInt(rangeMatch[2], 10);
          if (actualTemp >= low && actualTemp <= high) {
            wouldHaveWon = true;
            break;
          }
        }
      }
    } catch { /* ignore parse errors */ }
  }
  
  // Fallback for old predictions without dutchBetBins
  if (!pred.dutchBetBins && pred.centerRange) {
    const rangeMatch = (pred.centerRange ?? '').match(/(\d+)[°]?.*?-.*?(\d+)/);
    if (rangeMatch) {
      const centerLow = parseInt(rangeMatch[1], 10);
      const centerHigh = parseInt(rangeMatch[2], 10);
      const rangeWidth = centerHigh - centerLow;
      if (rangeWidth <= 2) {
        wouldHaveWon = actualTemp >= (centerLow - 2) && actualTemp <= (centerHigh + 2);
      } else {
        wouldHaveWon = actualTemp >= centerLow && actualTemp <= centerHigh;
      }
    }
  }

  try {
    await prisma.predictionHistory.update({
      where: { id: pred.id },
      data: {
        actualTemp,
        tempSource,
        forecastError,
        absError,
        wouldHaveWon,
        dutchBetResult: wouldHaveWon ? 'won' : 'lost',
        resolvedAt: new Date(),
      },
    });
    return 1;
  } catch (updateErr: any) {
    console.error(`Failed to update prediction ${pred.id}:`, updateErr?.message);
    return 0;
  }
}
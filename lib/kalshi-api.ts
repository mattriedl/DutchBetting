import crypto from 'crypto';

/**
 * Convert Kalshi dollar-string (e.g. "0.56") to cents (56).
 * Returns null if the value is null/undefined/unparseable.
 */
function parseDollarsToCents(val: any): number | null {
  if (val == null) return null;
  const str = String(val).trim();
  if (!str || str === '0' || str === '0.00') return 0;
  const parsed = parseFloat(str);
  if (isNaN(parsed)) return null;
  return Math.round(parsed * 100);
}

/**
 * Parse Kalshi fixed-point string values (e.g. volume_fp, open_interest_fp).
 * Returns null if not parseable.
 */
function parseFixedPoint(val: any): number | null {
  if (val == null) return null;
  const parsed = parseInt(String(val), 10);
  return isNaN(parsed) ? null : parsed;
}

// Kalshi API base URLs
const KALSHI_PROD_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_DEMO_URL = 'https://demo-api.kalshi.co/trade-api/v2';

export function getKalshiBaseUrl(environment: string): string {
  return environment === 'production' ? KALSHI_PROD_URL : KALSHI_DEMO_URL;
}

/**
 * Sign a request using RSA-PSS with SHA256 as required by Kalshi API.
 * Message = timestamp_ms + method + path (without query params)
 */
function signRequest(
  privateKeyPem: string,
  timestampMs: number,
  method: string,
  path: string
): string {
  // Strip query parameters from path
  const pathWithoutQuery = path.split('?')[0] ?? path;
  const message = `${timestampMs}${method.toUpperCase()}${pathWithoutQuery}`;

  const signature = crypto.sign('sha256', Buffer.from(message, 'utf-8'), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return signature.toString('base64');
}

/**
 * Make an authenticated request to the Kalshi API.
 * Uses RSA-PSS signing with Key ID and Private Key.
 */
export async function kalshiFetch(
  path: string,
  keyId: string,
  privateKeyPem: string,
  environment: string = 'demo',
  options: RequestInit = {}
): Promise<any> {
  const baseUrl = getKalshiBaseUrl(environment);
  const fullPath = `/trade-api/v2${path}`;
  const url = `${baseUrl}${path}`;
  const method = (options?.method ?? 'GET').toUpperCase();
  const timestampMs = Date.now();

  let headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Only sign if we have credentials (some endpoints are public)
  if (keyId && privateKeyPem) {
    try {
      const signature = signRequest(privateKeyPem, timestampMs, method, fullPath);
      headers['KALSHI-ACCESS-KEY'] = keyId;
      headers['KALSHI-ACCESS-TIMESTAMP'] = String(timestampMs);
      headers['KALSHI-ACCESS-SIGNATURE'] = signature;
    } catch (signError: any) {
      console.error('RSA signing error:', signError?.message);
      throw new Error(`Failed to sign request: ${signError?.message}. Make sure the private key is in valid PEM format.`);
    }
  }

  try {
    const response = await fetch(url, {
      ...options,
      method,
      headers: {
        ...headers,
        ...(options?.headers as Record<string, string> ?? {}),
      },
    });

    if (!response?.ok) {
      const errorText = await response?.text?.() ?? 'Unknown error';
      throw new Error(`Kalshi API error ${response?.status}: ${errorText}`);
    }

    return await response?.json?.();
  } catch (error: any) {
    console.error('Kalshi API fetch error:', error?.message);
    throw error;
  }
}

/**
 * Make an unauthenticated request to the Kalshi API (for public endpoints like markets).
 */
export async function kalshiPublicFetch(
  path: string,
  environment: string = 'demo'
): Promise<any> {
  const baseUrl = getKalshiBaseUrl(environment);
  const url = `${baseUrl}${path}`;

  try {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response?.ok) {
      const errorText = await response?.text?.() ?? 'Unknown error';
      throw new Error(`Kalshi API error ${response?.status}: ${errorText}`);
    }

    return await response?.json?.();
  } catch (error: any) {
    console.error('Kalshi public API fetch error:', error?.message);
    throw error;
  }
}

/**
 * Test Kalshi connection using the exchange status endpoint.
 */
export async function testKalshiConnection(
  keyId: string,
  privateKeyPem: string,
  environment: string = 'demo'
): Promise<{ success: boolean; message: string }> {
  try {
    // First try the exchange status (public endpoint)
    const statusResult = await kalshiPublicFetch('/exchange/status', environment);
    
    // Then test authenticated access if credentials provided
    if (keyId && privateKeyPem) {
      const balanceResult = await kalshiFetch('/portfolio/balance', keyId, privateKeyPem, environment);
      return {
        success: true,
        message: `Connected to Kalshi ${environment}. Exchange: ${statusResult?.exchange_active ? 'Active' : 'Inactive'}. Balance: $${((balanceResult?.balance ?? 0) / 100).toFixed(2)}`,
      };
    }

    return {
      success: true,
      message: `Connected to Kalshi ${environment}. Exchange: ${statusResult?.exchange_active ? 'Active' : 'Inactive'}. (No credentials to test authenticated access)`,
    };
  } catch (error: any) {
    return { success: false, message: `Connection failed: ${error?.message ?? 'Unknown error'}` };
  }
}

// Known Kalshi climate/daily-temperature series tickers
// Kalshi uses two naming conventions: KXHIGH* (legacy) and KXHIGHT* (newer)
// For LOW temps, the active format is KXLOWT* (not KXLOW*)
export const CLIMATE_HIGH_TICKERS = [
  'KXHIGHNY',    // New York (legacy format, still active)
  'KXHIGHCHI',   // Chicago (legacy format, still active)
  'KXHIGHMIA',   // Miami (legacy format, still active)
  'KXHIGHDEN',   // Denver (legacy format, still active)
  'KXHIGHPHIL',  // Philadelphia (legacy format, still active)
  'KXHIGHTDC',   // Washington DC
  'KXHIGHTBOS',  // Boston
  'KXHIGHTHOU',  // Houston
  'KXHIGHTPHX',  // Phoenix
  'KXHIGHTSEA',  // Seattle
  'KXHIGHTLV',   // Las Vegas
  'KXHIGHTSFO',  // San Francisco
  'KXHIGHTDAL',  // Dallas
  'KXHIGHTATL',  // Atlanta
  'KXHIGHTOKC',  // Oklahoma City
  'KXHIGHTMIN',  // Minneapolis
  'KXHIGHTNOLA', // New Orleans
  'KXHIGHTSATX', // San Antonio
  'KXHIGHAUS',   // Austin
  'KXHIGHLAX',   // Los Angeles
];

export const CLIMATE_LOW_TICKERS = [
  'KXLOWTNYC',   // New York
  'KXLOWTCHI',   // Chicago
  'KXLOWTMIA',   // Miami
  'KXLOWTDEN',   // Denver
  'KXLOWTPHIL',  // Philadelphia
  'KXLOWTDC',    // Washington DC
  'KXLOWTBOS',   // Boston
  'KXLOWTHOU',   // Houston
  'KXLOWTPHX',   // Phoenix
  'KXLOWTSEA',   // Seattle
  'KXLOWTLV',    // Las Vegas
  'KXLOWTSFO',   // San Francisco
  'KXLOWTDAL',   // Dallas
  'KXLOWTATL',   // Atlanta
  'KXLOWTOKC',   // Oklahoma City
  'KXLOWTMIN',   // Minneapolis
  'KXLOWTNOLA',  // New Orleans
  'KXLOWTSATX',  // San Antonio
  'KXLOWTAUS',   // Austin
  'KXLOWTLAX',   // Los Angeles
];

export const CLIMATE_SERIES_TICKERS = [...CLIMATE_HIGH_TICKERS, ...CLIMATE_LOW_TICKERS];

/** Rate-limit helper: wait ms between API calls to avoid Kalshi 429s */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch all climate/daily-temperature markets from Kalshi.
 * Uses the public markets endpoint — no authentication needed for market data.
 * Processes series tickers sequentially with delays to respect rate limits.
 */
export async function fetchClimateMarkets(
  environment: string = 'production',
  options?: { status?: string; seriesTickers?: string[] }
): Promise<any[]> {
  const allMarkets: any[] = [];
  const DELAY_MS = 350; // ~3 requests/sec to stay well under 20/sec limit
  const statusFilter = options?.status ?? 'open';
  const tickers = options?.seriesTickers ?? CLIMATE_SERIES_TICKERS;
  
  try {
    for (let i = 0; i < tickers.length; i++) {
      const seriesTicker = tickers[i];
      
      // Add delay between series to avoid rate limiting
      if (i > 0) {
        await sleep(DELAY_MS);
      }
      
      try {
        // Fetch markets directly by series_ticker (more efficient than events→markets)
        let cursor: string | null = null;
        let hasMore = true;
        
        while (hasMore) {
          const cursorParam = cursor ? `&cursor=${cursor}` : '';
          const result = await kalshiPublicFetch(
            `/markets?series_ticker=${seriesTicker}&status=${statusFilter}&limit=200${cursorParam}`,
            environment
          );
          
          const markets = result?.markets ?? [];
          if (markets.length > 0) {
            // Get the event_ticker from the first market for metadata
            const eventTicker = markets[0]?.event_ticker ?? '';
            allMarkets.push(...markets.map((m: any) => ({
              ...m,
              _seriesTicker: seriesTicker,
              _eventTicker: m?.event_ticker ?? eventTicker,
              _eventTitle: m?.title ?? m?.subtitle ?? '',
            })));
            console.log(`${seriesTicker}: found ${markets.length} markets`);
          } else {
            console.log(`${seriesTicker}: no open markets`);
          }
          
          cursor = result?.cursor ?? null;
          hasMore = !!cursor && markets.length > 0;
          if (hasMore) await sleep(DELAY_MS);
        }
      } catch (seriesError: any) {
        // Some series tickers may not have active markets, that's ok
        console.log(`Series ${seriesTicker} not found or error:`, seriesError?.message);
        // If we hit a 429, wait longer before continuing
        if (seriesError?.message?.includes?.('429')) {
          console.log('Rate limited, waiting 3 seconds...');
          await sleep(3000);
        }
      }
    }
  } catch (error: any) {
    console.error('Failed to fetch climate markets:', error?.message);
  }

  return allMarkets;
}

/**
 * Parse a Kalshi market ticker to extract temperature range info.
 * Kalshi tickers for temperature are like: KXHIGHNY-25JUN04-T62 (above/below 62)
 * or structured in YES/NO contracts for specific ranges.
 */
export function parseTemperatureMarket(market: any): {
  city: string;
  state: string;
  seriesTicker: string;
  marketType: 'high' | 'low';
  tempLow: number;
  tempHigh: number;
  yesPrice: number;
  yesBid: number;
  yesAsk: number;
  lastPrice: number;
  noPrice: number;
  volume: number;
  openInterest: number;
  ticker: string;
  expirationTime: string;
} | null {
  try {
    const ticker = market?.ticker ?? '';
    const title = market?.title ?? market?.subtitle ?? '';
    
    // Kalshi v2 API price fields (dollar strings like "0.56" = 56 cents)
    // yes_bid_dollars = best bid (what buyers will pay for YES)
    // yes_ask_dollars = best ask (cost to BUY a YES contract) — THIS IS WHAT WE PAY
    // last_price_dollars = last traded price (can be stale)
    const yesBid = parseDollarsToCents(market?.yes_bid_dollars) ?? 0;
    const yesAsk = parseDollarsToCents(market?.yes_ask_dollars) ?? 0;
    const lastPrice = parseDollarsToCents(market?.last_price_dollars) ?? 0;
    
    // yesPrice = the best available price for display & Dutch bet analysis
    // Priority: ask (actual cost to buy) > bid > last traded price
    const yesPrice = yesAsk > 0 ? yesAsk
      : yesBid > 0 ? yesBid
      : lastPrice > 0 ? lastPrice
      : 0;
    
    const noPrice = parseDollarsToCents(market?.no_bid_dollars) ?? (yesPrice > 0 ? (100 - yesPrice) : 0);
    const volume = parseFixedPoint(market?.volume_fp)
      ?? (typeof market?.volume === 'number' ? market.volume : null)
      ?? 0;
    const openInterest = parseFixedPoint(market?.open_interest_fp)
      ?? (typeof market?.open_interest === 'number' ? market.open_interest : null)
      ?? 0;
    const expirationTime = market?.expiration_time ?? market?.close_time ?? '';
    const seriesTicker = market?._seriesTicker ?? '';

    // Determine market type from series ticker
    const marketType: 'high' | 'low' = seriesTicker.includes('KXLOW') ? 'low' : 'high';

    // Map series ticker to city name (both HIGH and LOW variants, legacy + new naming)
    const cityMap: Record<string, { city: string; state: string }> = {
      // HIGH — legacy format (KXHIGH*)
      'KXHIGHNY': { city: 'New York', state: 'NY' },
      'KXHIGHCHI': { city: 'Chicago', state: 'IL' },
      'KXHIGHMIA': { city: 'Miami', state: 'FL' },
      'KXHIGHDEN': { city: 'Denver', state: 'CO' },
      'KXHIGHPHIL': { city: 'Philadelphia', state: 'PA' },
      'KXHIGHLAX': { city: 'Los Angeles', state: 'CA' },
      'KXHIGHAUS': { city: 'Austin', state: 'TX' },
      // HIGH — new format (KXHIGHT*)
      'KXHIGHTDC': { city: 'Washington', state: 'DC' },
      'KXHIGHTBOS': { city: 'Boston', state: 'MA' },
      'KXHIGHTHOU': { city: 'Houston', state: 'TX' },
      'KXHIGHTPHX': { city: 'Phoenix', state: 'AZ' },
      'KXHIGHTSEA': { city: 'Seattle', state: 'WA' },
      'KXHIGHTLV': { city: 'Las Vegas', state: 'NV' },
      'KXHIGHTSFO': { city: 'San Francisco', state: 'CA' },
      'KXHIGHTDAL': { city: 'Dallas', state: 'TX' },
      'KXHIGHTATL': { city: 'Atlanta', state: 'GA' },
      'KXHIGHTOKC': { city: 'Oklahoma City', state: 'OK' },
      'KXHIGHTMIN': { city: 'Minneapolis', state: 'MN' },
      'KXHIGHTNOLA': { city: 'New Orleans', state: 'LA' },
      'KXHIGHTSATX': { city: 'San Antonio', state: 'TX' },
      // LOW — active format (KXLOWT*)
      'KXLOWTNYC': { city: 'New York', state: 'NY' },
      'KXLOWTCHI': { city: 'Chicago', state: 'IL' },
      'KXLOWTMIA': { city: 'Miami', state: 'FL' },
      'KXLOWTDEN': { city: 'Denver', state: 'CO' },
      'KXLOWTPHIL': { city: 'Philadelphia', state: 'PA' },
      'KXLOWTDC': { city: 'Washington', state: 'DC' },
      'KXLOWTBOS': { city: 'Boston', state: 'MA' },
      'KXLOWTHOU': { city: 'Houston', state: 'TX' },
      'KXLOWTPHX': { city: 'Phoenix', state: 'AZ' },
      'KXLOWTSEA': { city: 'Seattle', state: 'WA' },
      'KXLOWTLV': { city: 'Las Vegas', state: 'NV' },
      'KXLOWTSFO': { city: 'San Francisco', state: 'CA' },
      'KXLOWTDAL': { city: 'Dallas', state: 'TX' },
      'KXLOWTATL': { city: 'Atlanta', state: 'GA' },
      'KXLOWTOKC': { city: 'Oklahoma City', state: 'OK' },
      'KXLOWTMIN': { city: 'Minneapolis', state: 'MN' },
      'KXLOWTNOLA': { city: 'New Orleans', state: 'LA' },
      'KXLOWTSATX': { city: 'San Antonio', state: 'TX' },
      'KXLOWTAUS': { city: 'Austin', state: 'TX' },
      'KXLOWTLAX': { city: 'Los Angeles', state: 'CA' },
    };

    const cityInfo = cityMap[seriesTicker] ?? { city: 'Unknown', state: '' };

    // Extract temperature from the ticker, strike fields, or title
    let tempLow = 0;
    let tempHigh = 0;

    // Detect contract type from ticker: B = between range, T = threshold (above/below)
    const isBetweenContract = /B\d/.test(ticker);
    const isThresholdContract = /T\d/.test(ticker);

    // Try floor_strike / cap_strike first (may be number or string)
    const floorStrike = market?.floor_strike != null ? Number(market.floor_strike) : NaN;
    const capStrike = market?.cap_strike != null ? Number(market.cap_strike) : NaN;
    
    if (!isNaN(floorStrike) && !isNaN(capStrike) && floorStrike !== capStrike) {
      tempLow = Math.round(floorStrike);
      tempHigh = Math.round(capStrike);
    } else if (!isNaN(capStrike) && isNaN(floorStrike) && isThresholdContract) {
      // Threshold contract with only cap_strike: e.g. cap_strike=54 means "Below 54°F" = ≤53°F
      // Don't create fake 5° range — use cap_strike-1 as the boundary
      tempHigh = Math.round(capStrike) - 1;
      tempLow = tempHigh; // single boundary point for display ("≤53°F")
    } else if (!isNaN(floorStrike) && isNaN(capStrike) && isThresholdContract) {
      // Threshold contract with only floor_strike: e.g. floor_strike=61 means "Above 61°F" = ≥62°F
      tempLow = Math.round(floorStrike) + 1;
      tempHigh = tempLow; // single boundary point for display ("≥62°F")
    } else {
      // Fall back to ticker parsing
      const betweenMatch = ticker.match(/B(\d+\.?\d*)/);
      const thresholdMatch = ticker.match(/T(\d+)/);
      
      if (betweenMatch) {
        // B82.5 = "Between 82°F and 83°F" — midpoint of a 1° range
        const temp = parseFloat(betweenMatch[1]);
        tempLow = Math.floor(temp);
        tempHigh = tempLow + 1;
      } else if (thresholdMatch) {
        const temp = parseInt(thresholdMatch[1], 10);
        // Try to determine direction from title
        const isBelow = /below|under|or less|≤/i.test(title);
        const isAbove = /above|over|or more|≥/i.test(title);
        if (isBelow) {
          tempHigh = temp - 1;
          tempLow = tempHigh; // single boundary point
        } else if (isAbove) {
          tempLow = temp + 1;
          tempHigh = tempLow; // single boundary point
        } else {
          // Unknown direction — single boundary point
          tempLow = temp;
          tempHigh = temp;
        }
      } else {
        // Try parsing from title
        const rangeMatch = title.match(/(\d+)[°]?\s*[-–to]+\s*(\d+)/);
        if (rangeMatch) {
          tempLow = parseInt(rangeMatch[1], 10);
          tempHigh = parseInt(rangeMatch[2], 10);
        }
      }
    }

    if (tempLow === 0 && tempHigh === 0) return null;

    return {
      city: cityInfo.city,
      state: cityInfo.state,
      seriesTicker,
      marketType,
      tempLow,
      tempHigh,
      yesPrice,
      yesBid,
      yesAsk,
      lastPrice,
      noPrice,
      volume,
      openInterest,
      ticker,
      expirationTime,
    };
  } catch (error: any) {
    console.error('Error parsing temperature market:', error?.message);
    return null;
  }
}

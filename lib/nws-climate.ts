/**
 * NWS Climatological Data Fetcher
 * 
 * Fetches official observed temperatures from NWS Daily Climate Reports.
 * Kalshi settles temperature markets using the NWS Climatological Report (CLI/CF6).
 * 
 * Two data sources:
 * 1. CF6 (Preliminary Local Climatological Data) — full month table, best for multi-day lookback
 * 2. CLI (Daily Climate Report) — yesterday's data with exact observed max/min
 * 
 * CF6 URL: https://forecast.weather.gov/product.php?site=NWS&product=CF6&issuedby={STATION}
 * CLI URL: https://forecast.weather.gov/product.php?site=NWS&product=CLI&issuedby={STATION}
 */

export interface ObservedTemp {
  date: string; // YYYY-MM-DD
  maxTemp: number | null;
  minTemp: number | null;
  station: string;
  city: string;
}

/**
 * Mapping of Kalshi city names to NWS CLI/CF6 station codes.
 * These are the official stations Kalshi uses for market settlement.
 */
export const CITY_STATION_MAP: Record<string, { code: string; station: string; wfo: string }> = {
  'New York':       { code: 'NYC', station: 'CENTRAL PARK',           wfo: 'okx' },
  'Chicago':        { code: 'MDW', station: 'CHICAGO-MIDWAY',         wfo: 'lot' },
  'Miami':          { code: 'MIA', station: 'MIAMI',                  wfo: 'mfl' },
  'Denver':         { code: 'DEN', station: 'DENVER',                 wfo: 'bou' },
  'Philadelphia':   { code: 'PHL', station: 'PHILADELPHIA',           wfo: 'phi' },
  'Boston':         { code: 'BOS', station: 'BOSTON',                  wfo: 'box' },
  'Houston':        { code: 'HOU', station: 'HOUSTON/HOBBY',          wfo: 'hgx' },
  'Phoenix':        { code: 'PHX', station: 'PHOENIX',                wfo: 'psr' },
  'Seattle':        { code: 'SEA', station: 'SEATTLE-TACOMA',         wfo: 'sew' },
  'Las Vegas':      { code: 'LAS', station: 'LAS VEGAS',              wfo: 'vef' },
  'San Francisco':  { code: 'SFO', station: 'SAN FRANCISCO',          wfo: 'mtr' },
  'Dallas':         { code: 'DFW', station: 'DALLAS/FORT WORTH',      wfo: 'fwd' },
  'Atlanta':        { code: 'ATL', station: 'ATLANTA',                wfo: 'ffc' },
  'Oklahoma City':  { code: 'OKC', station: 'OKLAHOMA CITY',          wfo: 'oun' },
  'Minneapolis':    { code: 'MSP', station: 'TWIN CITIES',            wfo: 'mpx' },
  'New Orleans':    { code: 'MSY', station: 'NEW ORLEANS',            wfo: 'lix' },
  'San Antonio':    { code: 'SAT', station: 'SAN ANTONIO',            wfo: 'ewx' },
  'Austin':         { code: 'AUS', station: 'AUSTIN BERGSTROM',       wfo: 'ewx' },
  'Los Angeles':    { code: 'LAX', station: 'LOS ANGELES',            wfo: 'lox' },
  'Washington':     { code: 'DCA', station: 'WASHINGTON NATIONAL',    wfo: 'lwx' },
};

/**
 * Parse CF6 (Preliminary Local Climatological Data) text to extract daily max/min temps.
 * CF6 is a fixed-width table:
 *   Column positions: DY(1-2) MAX(4-6) MIN(8-10) AVG(12-14) ...
 * Lines look like:
 *   " 1  92  76  84   3   0  19 0.00  ..."
 */
function parseCF6(text: string, year: number, month: number): ObservedTemp[] {
  const results: ObservedTemp[] = [];
  const lines = text.split('\n');
  
  // Find the data section between the two === dividers after the header
  let inData = false;
  let dividerCount = 0;
  
  for (const line of lines) {
    if (line.includes('================')) {
      dividerCount++;
      if (dividerCount === 2) {
        inData = true;
        continue;
      }
      if (dividerCount === 3) {
        break; // End of data section
      }
    }
    
    if (!inData) continue;
    
    // Parse daily data line: " 1  92  76  84   3   0  19 ..."
    // Day is at positions 0-2, Max at 3-6, Min at 7-10
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('SM') || trimmed.startsWith('AV')) continue;
    
    // Use regex to parse: day(1-2 digits) then max(up to 3 digits or M) then min
    const match = trimmed.match(/^\s*(\d{1,2})\s+(-?\d+|M)\s+(-?\d+|M)/);
    if (!match) continue;
    
    const day = parseInt(match[1], 10);
    const maxStr = match[2];
    const minStr = match[3];
    
    if (day < 1 || day > 31) continue;
    
    const maxTemp = maxStr === 'M' ? null : parseInt(maxStr, 10);
    const minTemp = minStr === 'M' ? null : parseInt(minStr, 10);
    
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    
    results.push({
      date: dateStr,
      maxTemp,
      minTemp,
      station: '',
      city: '',
    });
  }
  
  return results;
}

/**
 * Parse CLI (Daily Climate Report) text to extract yesterday's max/min temps.
 * Looks for lines like:
 *   "  MAXIMUM         90   3:31 PM ..."
 *   "  MINIMUM         79   8:44 AM ..."
 */
function parseCLI(text: string): { maxTemp: number | null; minTemp: number | null; dateStr: string } {
  let maxTemp: number | null = null;
  let minTemp: number | null = null;
  let dateStr = '';
  
  // Extract the date from "CLIMATE SUMMARY FOR JUNE 14 2026"
  const dateMatch = text.match(/CLIMATE SUMMARY FOR\s+(\w+)\s+(\d+)\s+(\d{4})/);
  if (dateMatch) {
    const monthNames: Record<string, string> = {
      JANUARY: '01', FEBRUARY: '02', MARCH: '03', APRIL: '04',
      MAY: '05', JUNE: '06', JULY: '07', AUGUST: '08',
      SEPTEMBER: '09', OCTOBER: '10', NOVEMBER: '11', DECEMBER: '12',
    };
    const mo = monthNames[dateMatch[1].toUpperCase()] ?? '01';
    const dy = dateMatch[2].padStart(2, '0');
    dateStr = `${dateMatch[3]}-${mo}-${dy}`;
  }
  
  // Extract MAXIMUM and MINIMUM from the YESTERDAY section
  // Format: "  MAXIMUM         90   3:31 PM ..."
  const maxMatch = text.match(/MAXIMUM\s+(-?\d+|M)/);
  if (maxMatch && maxMatch[1] !== 'M') {
    maxTemp = parseInt(maxMatch[1], 10);
  }
  
  const minMatch = text.match(/MINIMUM\s+(-?\d+|M)/);
  if (minMatch && minMatch[1] !== 'M') {
    minTemp = parseInt(minMatch[1], 10);
  }
  
  return { maxTemp, minTemp, dateStr };
}

/**
 * Fetch observed temperatures from the NWS CF6 product for a city.
 * Returns all available daily temps for the current month.
 */
export async function fetchCF6Data(city: string): Promise<ObservedTemp[]> {
  const stationInfo = CITY_STATION_MAP[city];
  if (!stationInfo) {
    console.log(`No station mapping for city: ${city}`);
    return [];
  }
  
  try {
    const url = `https://forecast.weather.gov/product.php?site=NWS&product=CF6&issuedby=${stationInfo.code}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'KalshiDutchBetDashboard/1.0 (climate-research)' },
      signal: AbortSignal.timeout(15000),
    });
    
    if (!response.ok) {
      console.error(`CF6 fetch failed for ${city} (${stationInfo.code}): ${response.status}`);
      return [];
    }
    
    const html = await response.text();
    
    // Extract the pre-formatted text content
    // The CF6 data is in a <pre> tag or in the page body
    const preMatch = html.match(/<pre[^>]*>(.*?)<\/pre>/s) ?? html.match(/PRELIMINARY LOCAL CLIMATOLOGICAL DATA[\s\S]*?={16,}[\s\S]*?={16,}[\s\S]*?={16,}/);
    const textContent = preMatch ? (preMatch[1] ?? preMatch[0]) : html;
    
    // Extract year and month from the CF6 header
    const monthMatch = textContent.match(/MONTH:\s+(\w+)/);
    const yearMatch = textContent.match(/YEAR:\s+(\d{4})/);
    
    if (!monthMatch || !yearMatch) {
      console.error(`Could not parse CF6 header for ${city}`);
      return [];
    }
    
    const monthNames: Record<string, number> = {
      JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4,
      MAY: 5, JUNE: 6, JULY: 7, AUGUST: 8,
      SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
    };
    
    const month = monthNames[monthMatch[1].toUpperCase()] ?? 1;
    const year = parseInt(yearMatch[1], 10);
    
    const temps = parseCF6(textContent, year, month);
    
    // Tag with city and station info
    return temps.map(t => ({
      ...t,
      station: stationInfo.station,
      city,
    }));
  } catch (err: any) {
    console.error(`CF6 fetch error for ${city}:`, err?.message);
    return [];
  }
}

/**
 * Fetch yesterday's observed temps from the NWS CLI (Daily Climate Report) for a city.
 * CLI is more authoritative than CF6 for yesterday's data.
 */
export async function fetchCLIData(city: string): Promise<ObservedTemp | null> {
  const stationInfo = CITY_STATION_MAP[city];
  if (!stationInfo) return null;
  
  try {
    const url = `https://forecast.weather.gov/product.php?site=NWS&product=CLI&issuedby=${stationInfo.code}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'KalshiDutchBetDashboard/1.0 (climate-research)' },
      signal: AbortSignal.timeout(15000),
    });
    
    if (!response.ok) return null;
    
    const html = await response.text();
    const { maxTemp, minTemp, dateStr } = parseCLI(html);
    
    if (!dateStr) return null;
    
    return {
      date: dateStr,
      maxTemp,
      minTemp,
      station: stationInfo.station,
      city,
    };
  } catch (err: any) {
    console.error(`CLI fetch error for ${city}:`, err?.message);
    return null;
  }
}

/**
 * Fetch observed temperatures for ALL cities using CF6.
 * Returns a map: city -> date -> { maxTemp, minTemp }
 */
export async function fetchAllObservedTemps(): Promise<Record<string, Record<string, { maxTemp: number | null; minTemp: number | null }>>> {
  const allTemps: Record<string, Record<string, { maxTemp: number | null; minTemp: number | null }>> = {};
  
  const cities = Object.keys(CITY_STATION_MAP);
  
  for (const city of cities) {
    try {
      const temps = await fetchCF6Data(city);
      if (temps.length > 0) {
        allTemps[city] = {};
        for (const t of temps) {
          allTemps[city][t.date] = {
            maxTemp: t.maxTemp,
            minTemp: t.minTemp,
          };
        }
      }
      // Rate limit: NWS requests
      await new Promise(r => setTimeout(r, 200));
    } catch (err: any) {
      console.error(`Error fetching observed temps for ${city}:`, err?.message);
    }
  }
  
  return allTemps;
}

/**
 * Get the NWS Climate page URL for a city (for linking in the UI).
 */
export function getClimatePageUrl(city: string): string {
  const stationInfo = CITY_STATION_MAP[city];
  if (!stationInfo) return 'https://www.weather.gov/wrh/climate';
  return `https://www.weather.gov/wrh/Climate?wfo=${stationInfo.wfo}&tab=observed`;
}

/**
 * Get the CF6 product URL for a city.
 */
export function getCF6Url(city: string): string {
  const stationInfo = CITY_STATION_MAP[city];
  if (!stationInfo) return '';
  return `https://forecast.weather.gov/product.php?site=NWS&product=CF6&issuedby=${stationInfo.code}`;
}

/**
 * Get the CLI product URL for a city.
 */
export function getCLIUrl(city: string): string {
  const stationInfo = CITY_STATION_MAP[city];
  if (!stationInfo) return '';
  return `https://forecast.weather.gov/product.php?site=NWS&product=CLI&issuedby=${stationInfo.code}`;
}

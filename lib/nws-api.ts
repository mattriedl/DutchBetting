export interface NwsForecastResult {
  city: string;
  state: string;
  forecastHigh: number | null;
  forecastLow: number | null;
  forecastDate: string;
  retrievedAt: string;
  confidence: string;
  error: string | null;
}

// City coordinates for NWS API lookups - aligned with Kalshi KXHIGH series
export const CITY_COORDINATES: Record<string, { lat: number; lon: number; city: string; state: string }> = {
  'new-york': { lat: 40.7789, lon: -73.9692, city: 'New York', state: 'NY' },       // Central Park
  'chicago': { lat: 41.9742, lon: -87.9073, city: 'Chicago', state: 'IL' },          // O'Hare
  'los-angeles': { lat: 33.9425, lon: -118.4081, city: 'Los Angeles', state: 'CA' }, // LAX
  'miami': { lat: 25.7959, lon: -80.2870, city: 'Miami', state: 'FL' },              // MIA airport
  'denver': { lat: 39.8561, lon: -104.6737, city: 'Denver', state: 'CO' },           // DIA
  'san-francisco': { lat: 37.6213, lon: -122.3790, city: 'San Francisco', state: 'CA' }, // SFO
  'dallas': { lat: 32.8998, lon: -97.0403, city: 'Dallas', state: 'TX' },            // DFW
  'washington-dc': { lat: 38.8512, lon: -77.0402, city: 'Washington', state: 'DC' }, // DCA
  'atlanta': { lat: 33.6407, lon: -84.4277, city: 'Atlanta', state: 'GA' },          // ATL
  'boston': { lat: 42.3656, lon: -71.0096, city: 'Boston', state: 'MA' },             // Logan
  'houston': { lat: 29.9844, lon: -95.3414, city: 'Houston', state: 'TX' },          // IAH
  'phoenix': { lat: 33.4373, lon: -112.0078, city: 'Phoenix', state: 'AZ' },         // Sky Harbor
  'seattle': { lat: 47.4502, lon: -122.3088, city: 'Seattle', state: 'WA' },         // Sea-Tac
  'las-vegas': { lat: 36.0840, lon: -115.1537, city: 'Las Vegas', state: 'NV' },     // Harry Reid
  'philadelphia': { lat: 39.8744, lon: -75.2424, city: 'Philadelphia', state: 'PA' }, // PHL
  'oklahoma-city': { lat: 35.3931, lon: -97.6006, city: 'Oklahoma City', state: 'OK' }, // Will Rogers
  'minneapolis': { lat: 44.8848, lon: -93.2223, city: 'Minneapolis', state: 'MN' }, // MSP
  'new-orleans': { lat: 29.9934, lon: -90.2580, city: 'New Orleans', state: 'LA' }, // MSY
  'san-antonio': { lat: 29.5337, lon: -98.4690, city: 'San Antonio', state: 'TX' }, // SAT
  'austin': { lat: 30.1975, lon: -97.6664, city: 'Austin', state: 'TX' }, // AUS
};

/**
 * Fetch multi-day NWS forecasts for a city.
 * Returns an array of forecasts — typically today and tomorrow (and more if available).
 * Each entry has its own forecastDate, forecastHigh, and forecastLow.
 */
export async function fetchNwsForecast(cityKey: string): Promise<NwsForecastResult[]> {
  const coords = CITY_COORDINATES?.[cityKey];
  if (!coords) {
    return [{
      city: cityKey,
      state: '',
      forecastHigh: null,
      forecastLow: null,
      forecastDate: new Date().toISOString(),
      retrievedAt: new Date().toISOString(),
      confidence: 'none',
      error: `Unknown city: ${cityKey}`,
    }];
  }

  try {
    // Step 1: Get grid point
    const pointRes = await fetch(
      `https://api.weather.gov/points/${coords.lat},${coords.lon}`,
      { headers: { 'User-Agent': 'KalshiDutchBetting/1.0 (contact@example.com)' } }
    );
    if (!pointRes?.ok) throw new Error(`NWS points API returned ${pointRes?.status}`);
    const pointData = await pointRes?.json?.();

    const forecastUrl = pointData?.properties?.forecast;
    if (!forecastUrl) throw new Error('No forecast URL in NWS response');

    // Step 2: Get forecast
    const forecastRes = await fetch(forecastUrl, {
      headers: { 'User-Agent': 'KalshiDutchBetting/1.0 (contact@example.com)' },
    });
    if (!forecastRes?.ok) throw new Error(`NWS forecast API returned ${forecastRes?.status}`);
    const forecastData = await forecastRes?.json?.();

    const periods = forecastData?.properties?.periods ?? [];
    if (periods.length === 0) {
      return [{
        city: coords.city,
        state: coords.state,
        forecastHigh: null,
        forecastLow: null,
        forecastDate: new Date().toISOString(),
        retrievedAt: new Date().toISOString(),
        confidence: 'none',
        error: 'No forecast period found',
      }];
    }

    // Group periods by date to extract highs and lows for each day
    // NWS returns alternating daytime/nighttime periods
    const dayMap: Record<string, { high: number | null; low: number | null; startTime: string }> = {};
    for (const period of periods) {
      const startTime = period?.startTime ?? '';
      // Extract date (YYYY-MM-DD) from ISO string
      const dateStr = startTime.slice(0, 10);
      if (!dateStr) continue;

      if (!dayMap[dateStr]) {
        dayMap[dateStr] = { high: null, low: null, startTime };
      }

      if (period?.isDaytime === true) {
        dayMap[dateStr].high = period?.temperature ?? null;
      } else {
        dayMap[dateStr].low = period?.temperature ?? null;
      }
    }

    // Convert to array, sorted by date, limit to first 3 days
    const results: NwsForecastResult[] = Object.entries(dayMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 3)
      .filter(([, v]) => v.high !== null || v.low !== null)
      .map(([dateStr, v]) => ({
        city: coords.city,
        state: coords.state,
        forecastHigh: v.high,
        forecastLow: v.low,
        forecastDate: v.startTime,
        retrievedAt: new Date().toISOString(),
        confidence: 'normal',
        error: null,
      }));

    return results.length > 0 ? results : [{
      city: coords.city,
      state: coords.state,
      forecastHigh: null,
      forecastLow: null,
      forecastDate: new Date().toISOString(),
      retrievedAt: new Date().toISOString(),
      confidence: 'none',
      error: 'No valid forecast periods found',
    }];
  } catch (error: any) {
    console.error(`NWS forecast error for ${cityKey}:`, error?.message);
    return [{
      city: coords?.city ?? cityKey,
      state: coords?.state ?? '',
      forecastHigh: null,
      forecastLow: null,
      forecastDate: new Date().toISOString(),
      retrievedAt: new Date().toISOString(),
      confidence: 'none',
      error: error?.message ?? 'Unknown error',
    }];
  }
}

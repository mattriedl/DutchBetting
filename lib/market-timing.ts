/**
 * Market timing utilities — prevent betting on markets where the
 * temperature extreme has likely already occurred.
 *
 * Daily LOW: typically occurs between 3-7 AM local time.
 *   → If it's past 8 AM local, today's low is already locked in.
 * Daily HIGH: typically occurs between 1-5 PM local time.
 *   → If it's past 5 PM local, today's high is already locked in.
 *
 * For future dates, markets are always considered bettable.
 */

// IANA timezone for each city (used for accurate local-time checks)
export const CITY_TIMEZONES: Record<string, string> = {
  'New York': 'America/New_York',
  'Chicago': 'America/Chicago',
  'Los Angeles': 'America/Los_Angeles',
  'Miami': 'America/New_York',
  'Denver': 'America/Denver',
  'San Francisco': 'America/Los_Angeles',
  'Dallas': 'America/Chicago',
  'Washington': 'America/New_York',
  'Atlanta': 'America/New_York',
  'Boston': 'America/New_York',
  'Houston': 'America/Chicago',
  'Phoenix': 'America/Phoenix',
  'Seattle': 'America/Los_Angeles',
  'Las Vegas': 'America/Los_Angeles',
  'Philadelphia': 'America/New_York',
  'Oklahoma City': 'America/Chicago',
  'Minneapolis': 'America/Chicago',
  'New Orleans': 'America/Chicago',
  'San Antonio': 'America/Chicago',
  'Austin': 'America/Chicago',
};

// Cutoff hours (local time, 24h) after which today's extreme is considered "locked"
const LOW_CUTOFF_HOUR = 8;   // 8 AM — daily low has occurred by now
const HIGH_CUTOFF_HOUR = 17; // 5 PM — daily high has occurred by now

/**
 * Check if a market for a given city/date/type is still "bettable".
 *
 * Returns false (= skip this market) if:
 *   - The city has no known timezone (fail closed)
 *   - The event date is TODAY in the city's local timezone, AND
 *   - The current local time has passed the cutoff for that market type
 *
 * Returns true (= market is fine to bet on) if:
 *   - The event date is in the future
 *   - The event date is today but the cutoff hasn't been reached yet
 */
export function isMarketStillBettable(
  city: string,
  eventDateStr: string, // YYYY-MM-DD
  marketType: string,   // 'high' or 'low'
): boolean {
  const tz = CITY_TIMEZONES[city];
  // Unknown city → NOT bettable. This guards real-money auto-bets, so fail closed: a new Kalshi
  // city must be added to CITY_TIMEZONES before it can be auto-bet.
  if (!tz) return false;

  // Get current date/time in the city's local timezone
  const now = new Date();
  const localDateStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD format
  const localHour = parseInt(
    now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }),
    10
  );

  // If event date is NOT today, it's always bettable
  if (eventDateStr !== localDateStr) {
    // But also check if the event date is in the PAST
    if (eventDateStr < localDateStr) return false; // Past dates are never bettable
    return true;
  }

  // Event is TODAY — check if the relevant extreme has already occurred
  const type = marketType?.toLowerCase?.();
  if (type === 'low') {
    return localHour < LOW_CUTOFF_HOUR;
  }
  if (type === 'high') {
    return localHour < HIGH_CUTOFF_HOUR;
  }

  return true; // Unknown market type → don't filter
}

/**
 * Returns a human-readable reason why a market was filtered out.
 * Useful for logging/debugging.
 */
export function getMarketTimingReason(
  city: string,
  eventDateStr: string,
  marketType: string,
): string | null {
  const tz = CITY_TIMEZONES[city];
  if (!tz) return null;

  const now = new Date();
  const localDateStr = now.toLocaleDateString('en-CA', { timeZone: tz });
  const localHour = parseInt(
    now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }),
    10
  );

  if (eventDateStr < localDateStr) {
    return `Event date ${eventDateStr} is in the past`;
  }

  if (eventDateStr !== localDateStr) return null;

  const type = marketType?.toLowerCase?.();
  if (type === 'low' && localHour >= LOW_CUTOFF_HOUR) {
    return `Daily low in ${city} has likely already occurred (local time: ${localHour}:00, cutoff: ${LOW_CUTOFF_HOUR}:00)`;
  }
  if (type === 'high' && localHour >= HIGH_CUTOFF_HOUR) {
    return `Daily high in ${city} has likely already occurred (local time: ${localHour}:00, cutoff: ${HIGH_CUTOFF_HOUR}:00)`;
  }

  return null;
}

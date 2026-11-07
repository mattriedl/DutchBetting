/**
 * Odds formatting utilities matching Kalshi's display options:
 * 1. "shares" = Shares & Prices (default) — shows Yes/No prices in cents (e.g., 45¢ Yes / 55¢ No)
 * 2. "payout" = Payout & Odds — shows implied probability and payout multiplier (e.g., 2.22x payout, 45% implied)
 * 3. "american" = American Odds — shows moneyline format (e.g., +122 or -180)
 */

export type OddsFormat = 'shares' | 'payout' | 'american';

export const ODDS_FORMAT_LABELS: Record<OddsFormat, string> = {
  shares: 'Shares & Prices',
  payout: 'Payout & Odds',
  american: 'American Odds',
};

export const ODDS_FORMAT_DESCRIPTIONS: Record<OddsFormat, string> = {
  shares: 'Shows prices in cents (e.g., 45¢ Yes / 55¢ No)',
  payout: 'Shows payout multiplier and implied probability',
  american: 'Shows moneyline odds (e.g., +122 or -180)',
};

/**
 * Convert Kalshi cents price (0-99) to different odds formats.
 * @param centsPrice - The YES price in cents (e.g., 45 means 45¢)
 * @param format - The desired output format
 */
export function formatOdds(centsPrice: number, format: OddsFormat): string {
  if (centsPrice <= 0 || centsPrice >= 100) return '—';

  switch (format) {
    case 'shares':
      return `${centsPrice}¢`;

    case 'payout': {
      const multiplier = 100 / centsPrice;
      return `${multiplier.toFixed(2)}x`;
    }

    case 'american': {
      const impliedProb = centsPrice / 100;
      if (impliedProb >= 0.5) {
        // Favorite: negative American odds
        const americanOdds = Math.round(-(impliedProb / (1 - impliedProb)) * 100);
        return `${americanOdds}`;
      } else {
        // Underdog: positive American odds
        const americanOdds = Math.round(((1 - impliedProb) / impliedProb) * 100);
        return `+${americanOdds}`;
      }
    }

    default:
      return `${centsPrice}¢`;
  }
}

/**
 * Format implied probability from cents price.
 */
export function formatImpliedProbability(centsPrice: number): string {
  if (centsPrice <= 0 || centsPrice >= 100) return '—';
  return `${centsPrice}%`;
}

/**
 * Get the column header label for the current odds format.
 */
export function getOddsColumnLabel(format: OddsFormat): string {
  switch (format) {
    case 'shares': return 'Price';
    case 'payout': return 'Payout';
    case 'american': return 'Odds';
    default: return 'Price';
  }
}

/**
 * Format a full position display line with odds.
 */
export function formatPositionOdds(
  centsPrice: number,
  format: OddsFormat
): { primary: string; secondary: string } {
  switch (format) {
    case 'shares':
      return {
        primary: `${centsPrice}¢`,
        secondary: `${centsPrice}% implied`,
      };
    case 'payout': {
      const multiplier = 100 / centsPrice;
      return {
        primary: `${multiplier.toFixed(2)}x`,
        secondary: `${centsPrice}% probability`,
      };
    }
    case 'american': {
      const impliedProb = centsPrice / 100;
      let americanStr: string;
      if (impliedProb >= 0.5) {
        americanStr = `${Math.round(-(impliedProb / (1 - impliedProb)) * 100)}`;
      } else {
        americanStr = `+${Math.round(((1 - impliedProb) / impliedProb) * 100)}`;
      }
      return {
        primary: americanStr,
        secondary: `${centsPrice}% implied`,
      };
    }
    default:
      return { primary: `${centsPrice}¢`, secondary: '' };
  }
}

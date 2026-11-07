/**
 * The Odds API – sharp-market grounding signal.
 *
 * Fetches consensus Over/Under (totals) and optionally BTTS odds from major
 * bookmakers via the-odds-api.com (v4). The de-vigged consensus probabilities
 * act as a market-grounding signal for the goals-research pipeline:
 *
 *   - Low-scoring consensus gets an additional "sharp books" weighted signal.
 *   - The LLM xG prompt receives the sharp consensus line/probability.
 *   - The Poisson model blend uses the sharp mid as one of the blended anchors.
 *
 * Caching: responses are cached for 30 minutes (totals move slowly for soccer).
 * BTTS requires a per-event fetch so it is best-effort and only attempted
 * for leagues where bookmakers commonly offer it.
 */

const API_BASE = 'https://api.the-odds-api.com/v4';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

// ────────────────────────── types ──────────────────────────

export interface SharpTotals {
  line: number;          // e.g. 2.5, 3.0, 3.25
  overProb: number;      // de-vigged consensus P(over)
  underProb: number;     // 1 - overProb
  booksUsed: number;     // how many bookmakers contributed
}

export interface SharpBtts {
  yesProb: number;       // de-vigged consensus P(btts yes)
  noProb: number;        // 1 - yesProb
  booksUsed: number;
}

export interface SharpSignal {
  totals: SharpTotals[]; // one entry per distinct line offered (sorted by line)
  btts?: SharpBtts;      // null when not available for this league/event
  sport: string;         // the-odds-api sport_key
}

// ────────────────────────── league → sport_key mapping ──────────────────────────

/** Map our internal league codes to the-odds-api sport keys. */
const LEAGUE_TO_SPORT: Record<string, string> = {
  MLS:            'soccer_usa_mls',
  'English Premier League': 'soccer_epl',
  EPL:            'soccer_epl',
  'La Liga':      'soccer_spain_la_liga',
  LALIGA:         'soccer_spain_la_liga',
  'Serie A':      'soccer_italy_serie_a',
  SERIEA:         'soccer_italy_serie_a',
  Bundesliga:     'soccer_germany_bundesliga',
  BUNDESLIGA:     'soccer_germany_bundesliga',
  'Ligue 1':      'soccer_france_ligue_one',
  LIGUE1:         'soccer_france_ligue_one',
  Eredivisie:     'soccer_netherlands_eredivisie',
  EREDIVISIE:     'soccer_netherlands_eredivisie',
  'Primeira Liga':'soccer_portugal_primeira_liga',
  PRIMEIRA:       'soccer_portugal_primeira_liga',
  'EFL Championship': 'soccer_efl_champ',
  CHAMPIONSHIP:   'soccer_efl_champ',
  'Liga MX':      'soccer_mexico_ligamx',
  LIGAMX:         'soccer_mexico_ligamx',
  'Brasileirão':  'soccer_brazil_campeonato',
  BRASILEIRAO:    'soccer_brazil_campeonato',
  'Copa Libertadores': 'soccer_conmebol_copa_libertadores',
  LIBERTADORES:   'soccer_conmebol_copa_libertadores',
  'UEFA Nations League': 'soccer_uefa_nations_league',
  NATIONS:        'soccer_uefa_nations_league',
  // Leagues Cup / NWSL / WC / EURO / Copa América / UCL / UEL / UECL
  // are not always listed; will fall back gracefully.
};

export function sportKeyForLeague(leagueOrCode: string): string | null {
  return LEAGUE_TO_SPORT[leagueOrCode] ?? null;
}

// ────────────────────────── caching ──────────────────────────

interface CacheEntry<T> { data: T; ts: number; }
const totalsCache = new Map<string, CacheEntry<Map<string, SharpTotals[]>>>();
const bttsCache = new Map<string, CacheEntry<SharpBtts | null>>();

// ────────────────────────── de-vig helpers ──────────────────────────

/** Convert decimal odds → implied probability, then remove the overround (vig)
 *  using the additive method: pFair_i = p_i / sum(p_i).  */
function devig(outcomes: { name: string; price: number }[]): Record<string, number> {
  if (!outcomes.length) return {};
  const implied: Record<string, number> = {};
  let total = 0;
  for (const o of outcomes) {
    const p = 1 / (o.price || 1);
    implied[o.name] = p;
    total += p;
  }
  for (const k of Object.keys(implied)) implied[k] = implied[k] / (total || 1);
  return implied;
}

// ────────────────────────── fetch totals ──────────────────────────

/**
 * Fetch sharp-market totals for every upcoming event in a league.
 * Returns a Map keyed by a normalised "HomeTeam vs AwayTeam" string.
 */
export async function fetchLeagueTotals(
  leagueOrCode: string
): Promise<Map<string, SharpTotals[]>> {
  const sport = sportKeyForLeague(leagueOrCode);
  if (!sport) return new Map();
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) return new Map();

  // Check cache
  const cacheKey = `totals:${sport}`;
  const cached = totalsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = `${API_BASE}/sports/${sport}/odds/?apiKey=${apiKey}&markets=totals&oddsFormat=decimal&regions=us,eu`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      console.warn(`[odds-api] ${sport} totals ${res.status}`);
      return new Map();
    }
    const data: any[] = await res.json();
    type TotalWithKey = SharpTotals & { matchKey: string };
    const allTotals: TotalWithKey[] = [];

    for (const ev of data) {
      const mk = matchKey(ev.home_team, ev.away_team);
      // Collect all outcomes per line across bookmakers
      const byLine = new Map<number, { overs: number[]; unders: number[] }>();
      for (const bk of ev.bookmakers ?? []) {
        for (const mkt of bk.markets ?? []) {
          if (mkt.key !== 'totals') continue;
          const over = mkt.outcomes.find((o: any) => o.name === 'Over');
          const under = mkt.outcomes.find((o: any) => o.name === 'Under');
          if (!over || !under) continue;
          const line = over.point ?? under.point;
          if (typeof line !== 'number') continue;
          const entry = byLine.get(line) ?? { overs: [], unders: [] };
          entry.overs.push(over.price);
          entry.unders.push(under.price);
          byLine.set(line, entry);
        }
      }
      for (const [line, { overs, unders }] of byLine) {
        if (!overs.length) continue;
        // Average across bookmakers, then de-vig
        const avgOver = overs.reduce((a, b) => a + b, 0) / overs.length;
        const avgUnder = unders.reduce((a, b) => a + b, 0) / unders.length;
        const fair = devig([
          { name: 'Over', price: avgOver },
          { name: 'Under', price: avgUnder },
        ]);
        allTotals.push({
          matchKey: mk,
          line,
          overProb: fair['Over'] ?? 0.5,
          underProb: fair['Under'] ?? 0.5,
          booksUsed: overs.length,
        });
      }
    }
    // Cache the grouped map directly.
    const grouped = groupByMatch<TotalWithKey>(allTotals, sport);
    totalsCache.set(cacheKey, { data: grouped as Map<string, SharpTotals[]>, ts: Date.now() });
    return grouped as Map<string, SharpTotals[]>;
  } catch (err: any) {
    console.warn(`[odds-api] totals fetch error for ${sport}:`, err?.message);
    return new Map();
  }
}

function groupByMatch<T extends { matchKey: string }>(arr: T[], _sport: string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of arr) {
    const list = m.get(x.matchKey) ?? [];
    list.push(x);
    m.set(x.matchKey, list);
  }
  // Sort each list by line
  for (const [, v] of m) v.sort((a: any, b: any) => (a.line ?? 0) - (b.line ?? 0));
  return m;
}

// ────────────────────────── fetch BTTS (per event) ──────────────────────────

/** Fetch BTTS for a single event. Requires the event ID from the-odds-api.
 *  We first look up the event list (cached with totals) to find the ID,
 *  then hit the per-event endpoint. Returns null if unavailable. */
export async function fetchEventBtts(
  leagueOrCode: string,
  homeTeam: string,
  awayTeam: string
): Promise<SharpBtts | null> {
  const sport = sportKeyForLeague(leagueOrCode);
  if (!sport) return null;
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) return null;

  const mk = matchKey(homeTeam, awayTeam);
  const bk = `btts:${sport}:${mk}`;
  const cached = bttsCache.get(bk);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  try {
    // Get event list for the sport
    const eventsRes = await fetch(
      `${API_BASE}/sports/${sport}/events/?apiKey=${apiKey}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!eventsRes.ok) return null;
    const events: any[] = await eventsRes.json();
    const target = events.find(
      (e) => matchKey(e.home_team, e.away_team) === mk
    );
    if (!target) { bttsCache.set(bk, { data: null, ts: Date.now() }); return null; }

    // Fetch BTTS for this event
    const bttsRes = await fetch(
      `${API_BASE}/sports/${sport}/events/${target.id}/odds/?apiKey=${apiKey}&markets=btts&oddsFormat=decimal&regions=us,uk,eu,au`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!bttsRes.ok) { bttsCache.set(bk, { data: null, ts: Date.now() }); return null; }
    const bttsData = await bttsRes.json();
    const yeses: number[] = [];
    const nos: number[] = [];
    for (const b of bttsData.bookmakers ?? []) {
      for (const m of b.markets ?? []) {
        if (m.key !== 'btts') continue;
        const yes = m.outcomes.find((o: any) => o.name === 'Yes');
        const no = m.outcomes.find((o: any) => o.name === 'No');
        if (yes) yeses.push(yes.price);
        if (no) nos.push(no.price);
      }
    }
    if (!yeses.length || !nos.length) {
      bttsCache.set(bk, { data: null, ts: Date.now() });
      return null;
    }
    const avgYes = yeses.reduce((a, b) => a + b, 0) / yeses.length;
    const avgNo = nos.reduce((a, b) => a + b, 0) / nos.length;
    const fair = devig([{ name: 'Yes', price: avgYes }, { name: 'No', price: avgNo }]);
    const result: SharpBtts = {
      yesProb: fair['Yes'] ?? 0.5,
      noProb: fair['No'] ?? 0.5,
      booksUsed: yeses.length,
    };
    bttsCache.set(bk, { data: result, ts: Date.now() });
    return result;
  } catch (err: any) {
    console.warn(`[odds-api] BTTS fetch error for ${sport}/${mk}:`, err?.message);
    bttsCache.set(bk, { data: null, ts: Date.now() });
    return null;
  }
}

// ────────────────────────── combined fetch ──────────────────────────

/**
 * One-call convenience: fetches totals for the league (batch, cheap) and
 * optionally BTTS for the specific match (per-event, 2 API calls).
 * Returns the SharpSignal for a single match, or null if the league is
 * unmapped or the key is missing.
 */
export async function fetchSharpSignal(
  leagueOrCode: string,
  teamA: string,
  teamB: string,
  opts?: { skipBtts?: boolean }
): Promise<SharpSignal | null> {
  const sport = sportKeyForLeague(leagueOrCode);
  if (!sport) return null;

  const mk = matchKey(teamA, teamB);
  const [totalsMap, btts] = await Promise.all([
    fetchLeagueTotals(leagueOrCode),
    opts?.skipBtts ? Promise.resolve(null) : fetchEventBtts(leagueOrCode, teamA, teamB),
  ]);

  // Try both orderings for the match key
  const totals = totalsMap.get(mk) ?? totalsMap.get(matchKey(teamB, teamA)) ?? [];

  if (!totals.length && !btts) return null;

  return {
    totals: totals.map(({ line, overProb, underProb, booksUsed }) => ({
      line, overProb, underProb, booksUsed,
    })),
    btts: btts ?? undefined,
    sport,
  };
}

// ────────────────────────── helpers ──────────────────────────

/** Normalise a match key so "Team A vs Team B" ≈ comparable across name variants. */
function matchKey(home: string, away: string): string {
  return `${norm(home)} vs ${norm(away)}`;
}
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.'']/g, '')
    .replace(/\b(FC|SC|CF|AC|AS|SS|US|CD|SK|FK|NK|SV)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

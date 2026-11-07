/**
 * API-Football client — shared by both Kalshi & Polymarket research libs.
 *
 * Provides:
 *  - Team-name → API-Football team-ID resolution (fuzzy match)
 *  - Last N fixtures per team (form, goals for/against)
 *  - Head-to-head history between two teams
 *  - Current injuries / suspensions per team
 *
 * All results are cached in-memory (process lifetime) to minimise API calls.
 * Team-ID lookups are cached permanently; fixture/H2H/injury data is cached
 * for CACHE_TTL_MS (default 4 hours).
 *
 * API docs: https://www.api-football.com/documentation-v3
 * Auth: x-apisports-key header.
 */

const BASE = 'https://v3.football.api-sports.io';
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ────────────────────────── types ──────────────────────────

export interface TeamFixture {
  date: string;            // ISO date
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  league: string;
  result: 'W' | 'D' | 'L'; // from the perspective of the queried team
}

export interface H2HRecord {
  date: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
}

export interface TeamInjury {
  player: string;
  type: string;     // e.g. "Knee Injury", "Suspended"
  reason: string;
}

export interface TeamResearchData {
  teamId: number;
  fixtures: TeamFixture[];  // most-recent first
  formString: string;       // e.g. "W-W-D-L-W"
  goalsScored: number;      // sum over last N
  goalsConceded: number;
  injuries: TeamInjury[];
}

export interface MatchResearchData {
  teamA: TeamResearchData | null;
  teamB: TeamResearchData | null;
  h2h: H2HRecord[];
}

/**
 * API-Football's own algorithmic forecast for an upcoming fixture
 * (the /predictions endpoint). All numeric probabilities are 0..1.
 * Fields are best-effort — the provider frequently leaves `underOver`
 * and the winner comment null, so every consumer must null-check.
 */
export interface MatchPrediction {
  fixtureId: number;
  homeTeam: string;          // as the fixture is listed by API-Football
  awayTeam: string;
  // whether the queried teamA maps to the fixture's home side (for orientation)
  teamAIsHome: boolean;
  winnerName: string | null; // predicted winner team name (null = no clear pick)
  winnerComment: string | null;
  winOrDraw: boolean;
  advice: string;
  underOver: string | null;  // total-goals prediction token e.g. "-2.5" (under) / "+2.5" (over)
  totalGoalsLine: number | null;  // parsed magnitude of underOver, e.g. 2.5
  totalGoalsDirection: 'under' | 'over' | null;
  percentHome: number | null;  // implied P(home win)
  percentDraw: number | null;
  percentAway: number | null;
  // oriented to the caller's teamA / teamB
  percentTeamA: number | null;
  percentTeamB: number | null;
}

// ────────────────────────── cache ──────────────────────────

interface CacheEntry<T> {
  data: T;
  ts: number;
}

const teamIdCache = new Map<string, number>();           // permanent
const dataCache = new Map<string, CacheEntry<any>>();    // TTL-based

function getCached<T>(key: string): T | null {
  const e = dataCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { dataCache.delete(key); return null; }
  return e.data as T;
}
function setCache<T>(key: string, data: T) {
  dataCache.set(key, { data, ts: Date.now() });
}

// ────────────────────────── helpers ──────────────────────────

function getKey(): string | null {
  return process.env.API_FOOTBALL_KEY || null;
}

// In-flight de-duplication: concurrent identical requests (e.g. the research lib
// and the low-scoring-consensus lib both resolving the same team at once) share a
// single network call instead of firing duplicates against the daily quota.
const inflight = new Map<string, Promise<any>>();

// ─── request throttle ───
// API-Football rate-limits by requests/minute; bursting (e.g. a bulk settle that
// makes several /teams?search= calls per row) trips it and the API returns
// "account suspended" for the rest of the run, so every lookup silently fails.
// Serialise outgoing calls with a minimum spacing to stay under the limit.
const MIN_REQUEST_GAP_MS = 350; // ~3 req/s, safely under the Pro per-minute cap
let throttleChain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Await this to reserve the next throttled request slot. */
function acquireSlot(): Promise<void> {
  const prev = throttleChain;
  throttleChain = (async () => {
    await prev;
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  })();
  return throttleChain;
}

function isRateLimited(status: number, errors: any): boolean {
  if (status === 429) return true;
  const blob = JSON.stringify(errors ?? '').toLowerCase();
  return blob.includes('suspend') || blob.includes('rate') || blob.includes('too many');
}

async function apiFetch(path: string): Promise<any> {
  const key = getKey();
  if (!key) return null;

  const existing = inflight.get(path);
  if (existing) return existing;

  const p = (async () => {
    try {
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await acquireSlot();
        let res: Response;
        try {
          res = await fetch(`${BASE}${path}`, {
            headers: { 'x-apisports-key': key },
          });
        } catch (err: any) {
          console.warn(`[api-football] fetch error for ${path}:`, err?.message);
          return null;
        }
        let json: any = null;
        if (res.ok) {
          json = await res.json().catch(() => null);
        }
        const errors = json?.errors;
        const hasErrors = errors && Object.keys(errors).length > 0;
        // Retry rate-limit / suspension responses with exponential backoff
        // instead of giving up (which would leave finished games unsettled).
        if (!res.ok || hasErrors) {
          if (isRateLimited(res.status, errors) && attempt < MAX_ATTEMPTS) {
            const backoff = 2000 * Math.pow(2, attempt - 1); // 2s, 4s
            console.warn(`[api-football] rate-limited on ${path}, retry ${attempt} in ${backoff}ms`);
            await sleep(backoff);
            continue;
          }
          if (!res.ok) console.warn(`[api-football] ${res.status} for ${path}`);
          else console.warn(`[api-football] API error for ${path}:`, errors);
          return null;
        }
        return json;
      }
      return null;
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, p);
  return p;
}

// ────────────────────────── team resolution ──────────────────────────

/**
 * Expand common North-American club abbreviations so that names coming from
 * Kalshi/Polymarket (e.g. "St. Louis City SC", "LA Galaxy") match the way
 * API-Football lists them ("Saint Louis", "Los Angeles Galaxy"). This is the
 * main reason MLS teams previously failed to resolve.
 */
function expandAbbrevs(name: string): string {
  return name
    .replace(/\bSt\.?\b/gi, 'Saint')
    .replace(/\bLA\b/g, 'Los Angeles')
    .replace(/\bNYC\b/g, 'New York City')
    .replace(/\bNY\b/g, 'New York')
    .replace(/\bKC\b/g, 'Kansas City')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalise a team name for fuzzy comparison.
 * Expands abbreviations, strips accents/punctuation, common suffixes (FC, SC, CF,
 * etc.), and extra whitespace.
 */
function normaliseName(name: string): string {
  return expandAbbrevs(name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))  // strip accents + expand
    .replace(/[.'’]/g, '')
    .replace(/\b(FC|SC|CF|AC|AS|SS|US|CD|SK|FK|NK|SV|TSV|BSC|VfB|VfL)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Build an ordered, de-duplicated list of search terms to try against the
 * /teams endpoint, from most to least specific. Bounded to 4 attempts so an
 * unresolvable club can't burn the daily quota (and the result is negative-cached).
 */
function buildSearchCandidates(teamName: string): string[] {
  const stripSuffix = (s: string) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')      // drop accents (Balompié -> Balompie)
      .replace(/[^a-zA-Z0-9\s]/g, ' ')                       // API allows only alphanumerics + spaces (kills - . ')
      .replace(/\b(FC|SC|CF|AC|AS|SS|US|CD|SK|FK|NK|SV)\b/gi, '').replace(/\s+/g, ' ').trim();
  const expanded = stripSuffix(expandAbbrevs(teamName));
  const words = expanded.split(/\s+/).filter(Boolean);
  const cands: string[] = [];
  const push = (c?: string) => {
    const t = (c || '').trim();
    if (t.length >= 3 && !cands.includes(t)) cands.push(t); // API requires >=3 chars
  };
  push(words.slice(0, 3).join(' '));                        // first 3 words
  push(words.slice(0, 2).join(' '));                        // first 2 words
  const noGeneric = words.filter(w => !/^(city|united|club)$/i.test(w));
  push(noGeneric.slice(0, 2).join(' '));                    // drop generic tail (Saint Louis City -> Saint Louis)
  const last = words[words.length - 1];
  if (last && last.length >= 5) push(last);                 // distinctive last word (Galaxy, Whitecaps)
  push(words[0]);                                           // first word (last resort)
  return cands.slice(0, 4);
}

function nameScore(query: string, candidate: string): number {
  const q = normaliseName(query);
  const c = normaliseName(candidate);
  if (q === c) return 100;
  if (c.includes(q) || q.includes(c)) return 80;
  // word-overlap score
  const qw = new Set(q.split(' '));
  const cw = new Set(c.split(' '));
  let overlap = 0;
  for (const w of qw) if (cw.has(w)) overlap++;
  return (overlap / Math.max(qw.size, cw.size)) * 60;
}

/**
 * Resolve a human team name (from Kalshi/Polymarket) to an API-Football team ID.
 * Uses the /teams endpoint with a search query, then picks the best fuzzy match.
 */
// Negative cache for team names that could not be resolved. Without this, an
// unresolvable club (common for MLS sides like "St. Louis City SC") would re-run
// the 1-2 /teams search calls on EVERY research click, draining the daily quota
// for zero benefit. Cached for NEG_TTL_MS, then retried in case the API adds it.
const NEG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const teamIdNegativeCache = new Map<string, number>(); // key -> timestamp

export async function resolveTeamId(teamName: string): Promise<number | null> {
  const nkey = normaliseName(teamName);
  const cached = teamIdCache.get(nkey);
  if (cached) return cached;

  const neg = teamIdNegativeCache.get(nkey);
  if (neg && Date.now() - neg < NEG_TTL_MS) return null;

  // Try an ordered set of progressively broader search terms (deduped, max 4).
  // As soon as one term returns a confident fuzzy match we return it; each term
  // is only queried until a hit, minimising /teams calls per resolution.
  for (const term of buildSearchCandidates(teamName)) {
    const data = await apiFetch(`/teams?search=${encodeURIComponent(term)}`);
    if (data?.response?.length) {
      const r = pickBestTeam(teamName, data.response);
      if (r != null) return r; // pickBestTeam populates teamIdCache on success
    }
  }

  // Nothing matched across all candidate terms - negative-cache to avoid re-querying.
  teamIdNegativeCache.set(nkey, Date.now());
  return null;
}

function pickBestTeam(query: string, results: any[]): number | null {
  let best: { id: number; score: number } = { id: 0, score: 0 };
  for (const r of results) {
    const team = r?.team;
    if (!team?.id) continue;
    const s = Math.max(nameScore(query, team.name ?? ''), nameScore(query, team.code ?? ''));
    if (s > best.score) best = { id: team.id, score: s };
  }
  if (best.score < 30) return null; // too low confidence
  teamIdCache.set(normaliseName(query), best.id);
  return best.id;
}

// ────────────────────────── fixtures (form) ──────────────────────────

async function fetchLastFixtures(teamId: number, count: number = 6): Promise<TeamFixture[]> {
  const ck = `fix_${teamId}_${count}`;
  const cached = getCached<TeamFixture[]>(ck);
  if (cached) return cached;

  const data = await apiFetch(`/fixtures?team=${teamId}&last=${count}`);
  if (!data?.response?.length) return [];

  const fixtures: TeamFixture[] = data.response.map((f: any) => {
    const home = f?.teams?.home;
    const away = f?.teams?.away;
    const hg = f?.goals?.home ?? 0;
    const ag = f?.goals?.away ?? 0;
    const isHome = home?.id === teamId;
    let result: 'W' | 'D' | 'L' = 'D';
    if (hg !== ag) {
      result = (isHome ? hg > ag : ag > hg) ? 'W' : 'L';
    }
    return {
      date: f?.fixture?.date?.slice(0, 10) ?? '',
      homeTeam: home?.name ?? '',
      awayTeam: away?.name ?? '',
      homeGoals: hg,
      awayGoals: ag,
      league: f?.league?.name ?? '',
      result,
    };
  });

  setCache(ck, fixtures);
  return fixtures;
}

// ────────────────────────── H2H ──────────────────────────

async function fetchH2H(teamAId: number, teamBId: number, count: number = 5): Promise<H2HRecord[]> {
  const ck = `h2h_${teamAId}_${teamBId}`;
  const cached = getCached<H2HRecord[]>(ck);
  if (cached) return cached;

  const data = await apiFetch(`/fixtures/headtohead?h2h=${teamAId}-${teamBId}&last=${count}`);
  if (!data?.response?.length) return [];

  const records: H2HRecord[] = data.response.map((f: any) => ({
    date: f?.fixture?.date?.slice(0, 10) ?? '',
    homeTeam: f?.teams?.home?.name ?? '',
    awayTeam: f?.teams?.away?.name ?? '',
    homeGoals: f?.goals?.home ?? 0,
    awayGoals: f?.goals?.away ?? 0,
  }));

  setCache(ck, records);
  return records;
}

// ────────────────────────── injuries ──────────────────────────

async function fetchInjuries(teamId: number): Promise<TeamInjury[]> {
  const ck = `inj_${teamId}`;
  const cached = getCached<TeamInjury[]>(ck);
  if (cached) return cached;

  // Need to find the next fixture to get injuries for that fixture
  const nextData = await apiFetch(`/fixtures?team=${teamId}&next=1`);
  const fixtureId = nextData?.response?.[0]?.fixture?.id;
  if (!fixtureId) {
    setCache(ck, []);
    return [];
  }

  const data = await apiFetch(`/injuries?fixture=${fixtureId}`);
  if (!data?.response?.length) {
    setCache(ck, []);
    return [];
  }

  const injuries: TeamInjury[] = data.response
    .filter((i: any) => i?.team?.id === teamId)
    .map((i: any) => ({
      player: i?.player?.name ?? 'Unknown',
      type: i?.player?.type ?? 'Injury',
      reason: i?.player?.reason ?? '',
    }));

  setCache(ck, injuries);
  return injuries;
}

// ────────────────────────── main entry point ──────────────────────────

/**
 * Fetch all research data for a match from API-Football.
 * Returns null if API key is missing or both teams fail to resolve.
 * Gracefully returns partial data if only one team resolves.
 */
export async function fetchMatchResearch(
  teamAName: string,
  teamBName: string,
  opts?: { includeInjuries?: boolean }
): Promise<MatchResearchData | null> {
  if (!getKey()) return null;

  // Injuries cost 2 extra API calls per team (next-fixture lookup + injuries) and
  // add little to goals/totals pricing, so callers that don't need them (e.g. the
  // goals markets research) can skip them to conserve the daily quota.
  const includeInjuries = opts?.includeInjuries !== false;

  // Resolve both teams in parallel
  const [idA, idB] = await Promise.all([
    resolveTeamId(teamAName),
    resolveTeamId(teamBName),
  ]);

  if (!idA && !idB) return null;  // can't resolve either team

  // Fetch all data in parallel
  const [fixA, fixB, injA, injB, h2h] = await Promise.all([
    idA ? fetchLastFixtures(idA, 6) : Promise.resolve([]),
    idB ? fetchLastFixtures(idB, 6) : Promise.resolve([]),
    idA && includeInjuries ? fetchInjuries(idA) : Promise.resolve([]),
    idB && includeInjuries ? fetchInjuries(idB) : Promise.resolve([]),
    idA && idB ? fetchH2H(idA, idB, 5) : Promise.resolve([]),
  ]);

  function buildTeamData(id: number | null, fixtures: TeamFixture[], injuries: TeamInjury[]): TeamResearchData | null {
    if (!id || fixtures.length === 0) return null;
    const formString = fixtures.map(f => f.result).join('-');
    const goalsScored = fixtures.reduce((s, f) => {
      const isHome = f.homeTeam === fixtures[0]?.homeTeam;
      // determine if queried team was home or away in each fixture
      return s + (f.result !== undefined ? (isHome ? f.homeGoals : f.awayGoals) : 0);
    }, 0);
    const goalsConceded = fixtures.reduce((s, f) => {
      const isHome = f.homeTeam === fixtures[0]?.homeTeam;
      return s + (isHome ? f.awayGoals : f.homeGoals);
    }, 0);
    return { teamId: id, fixtures, formString, goalsScored, goalsConceded, injuries };
  }

  // For goals calculation we need to know which team is which in each fixture
  // The fixtures already have a `result` from the team's perspective, so let's
  // compute goals more carefully:
  function computeTeamData(id: number, fixtures: TeamFixture[], injuries: TeamInjury[]): TeamResearchData {
    let gs = 0, gc = 0;
    for (const f of fixtures) {
      // We need to figure out if the team was home or away.
      // We don't have team IDs in the fixture result, but we know the result
      // is from the queried team's perspective. Use that.
      // Actually, let's check the fixture endpoint — it gives team IDs.
      // For now, use a heuristic: the API returns fixtures for team X,
      // so we know X was one of the two sides. Since we don't have the
      // team names map, let's just use total goals approach:
      // If result = W and homeGoals > awayGoals → team was home
      // If result = W and awayGoals > homeGoals → team was away
      // If result = D → both sides equal
      if (f.result === 'D') {
        gs += f.homeGoals; // same either way
        gc += f.awayGoals;
      } else if (f.result === 'W') {
        if (f.homeGoals > f.awayGoals) { gs += f.homeGoals; gc += f.awayGoals; }
        else { gs += f.awayGoals; gc += f.homeGoals; }
      } else {
        if (f.homeGoals > f.awayGoals) { gs += f.awayGoals; gc += f.homeGoals; }
        else { gs += f.homeGoals; gc += f.awayGoals; }
      }
    }
    return {
      teamId: id,
      fixtures,
      formString: fixtures.map(f => f.result).join('-'),
      goalsScored: gs,
      goalsConceded: gc,
      injuries,
    };
  }

  return {
    teamA: idA ? computeTeamData(idA, fixA, injA) : null,
    teamB: idB ? computeTeamData(idB, fixB, injB) : null,
    h2h,
  };
}

/**
 * Format the API-Football research data into a text block that can be
 * injected into the LLM analyst prompt. Returns empty string if no data.
 */
export function formatResearchForPrompt(
  data: MatchResearchData,
  teamAName: string,
  teamBName: string
): string {
  const parts: string[] = [];

  if (data.teamA) {
    const t = data.teamA;
    parts.push(`=== ${teamAName} (LIVE DATA from API-Football) ===`);
    parts.push(`Recent form (last ${t.fixtures.length}): ${t.formString}`);
    parts.push(`Goals scored: ${t.goalsScored}, Goals conceded: ${t.goalsConceded} (avg ${(t.goalsScored / t.fixtures.length).toFixed(2)} GF, ${(t.goalsConceded / t.fixtures.length).toFixed(2)} GA per match)`);
    parts.push('Recent results:');
    for (const f of t.fixtures.slice(0, 6)) {
      parts.push(`  ${f.date}: ${f.homeTeam} ${f.homeGoals}-${f.awayGoals} ${f.awayTeam} (${f.league}) [${f.result}]`);
    }
    if (t.injuries.length > 0) {
      parts.push(`Injuries/suspensions (${t.injuries.length}):`);
      for (const inj of t.injuries.slice(0, 8)) {
        parts.push(`  - ${inj.player}: ${inj.type}${inj.reason ? ` (${inj.reason})` : ''}`);
      }
    } else {
      parts.push('No known injuries/suspensions.');
    }
  }

  if (data.teamB) {
    const t = data.teamB;
    parts.push(`\n=== ${teamBName} (LIVE DATA from API-Football) ===`);
    parts.push(`Recent form (last ${t.fixtures.length}): ${t.formString}`);
    parts.push(`Goals scored: ${t.goalsScored}, Goals conceded: ${t.goalsConceded} (avg ${(t.goalsScored / t.fixtures.length).toFixed(2)} GF, ${(t.goalsConceded / t.fixtures.length).toFixed(2)} GA per match)`);
    parts.push('Recent results:');
    for (const f of t.fixtures.slice(0, 6)) {
      parts.push(`  ${f.date}: ${f.homeTeam} ${f.homeGoals}-${f.awayGoals} ${f.awayTeam} (${f.league}) [${f.result}]`);
    }
    if (t.injuries.length > 0) {
      parts.push(`Injuries/suspensions (${t.injuries.length}):`);
      for (const inj of t.injuries.slice(0, 8)) {
        parts.push(`  - ${inj.player}: ${inj.type}${inj.reason ? ` (${inj.reason})` : ''}`);
      }
    } else {
      parts.push('No known injuries/suspensions.');
    }
  }

  if (data.h2h.length > 0) {
    parts.push(`\n=== HEAD-TO-HEAD (last ${data.h2h.length} meetings) ===`);
    for (const h of data.h2h) {
      parts.push(`  ${h.date}: ${h.homeTeam} ${h.homeGoals}-${h.awayGoals} ${h.awayTeam}`);
    }
  }

  return parts.join('\n');
}

// ────────────────────────── predictions (algorithmic forecast) ──────────────────────────

/**
 * Find the upcoming fixture id between two teams by scanning teamA's next
 * fixtures for an opponent matching teamB. Returns null if no upcoming
 * meeting is found within the lookahead window.
 */
async function findUpcomingFixtureId(idA: number, idB: number): Promise<{ fixtureId: number; homeId: number; homeName: string; awayName: string } | null> {
  const ck = `nextfix_${idA}_${idB}`;
  const cached = getCached<{ fixtureId: number; homeId: number; homeName: string; awayName: string } | null>(ck);
  if (cached !== null) return cached;

  const data = await apiFetch(`/fixtures?team=${idA}&next=10`);
  const list = data?.response ?? [];
  for (const f of list) {
    const homeId = f?.teams?.home?.id;
    const awayId = f?.teams?.away?.id;
    if (homeId === idB || awayId === idB) {
      const hit = {
        fixtureId: f?.fixture?.id as number,
        homeId,
        homeName: f?.teams?.home?.name ?? '',
        awayName: f?.teams?.away?.name ?? '',
      };
      setCache(ck, hit);
      return hit;
    }
  }
  setCache(ck, null as any);
  return null;
}

function parseUnderOver(token: string | null): { line: number | null; direction: 'under' | 'over' | null } {
  if (!token) return { line: null, direction: null };
  const m = token.trim().match(/^([+-])?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return { line: null, direction: null };
  const sign = m[1] === '+' ? 'over' : m[1] === '-' ? 'under' : null;
  return { line: parseFloat(m[2]), direction: sign };
}

function parsePercent(p: string | null | undefined): number | null {
  if (!p) return null;
  const n = parseFloat(String(p).replace('%', '').trim());
  return Number.isFinite(n) ? n / 100 : null;
}

/**
 * Fetch API-Football's algorithmic forecast (the /predictions endpoint) for the
 * upcoming meeting between two teams. Costs at most two live calls (next-fixture
 * lookup + prediction), both cached for CACHE_TTL_MS. Returns null when the key
 * is missing, either team fails to resolve, or no upcoming fixture is found.
 */
export async function fetchPredictions(
  teamAName: string,
  teamBName: string
): Promise<MatchPrediction | null> {
  if (!getKey()) return null;

  const [idA, idB] = await Promise.all([
    resolveTeamId(teamAName),
    resolveTeamId(teamBName),
  ]);
  if (!idA || !idB) return null;

  const fix = await findUpcomingFixtureId(idA, idB);
  if (!fix) return null;

  const ck = `pred_${fix.fixtureId}`;
  const cached = getCached<MatchPrediction>(ck);
  if (cached) return cached;

  const data = await apiFetch(`/predictions?fixture=${fix.fixtureId}`);
  const r = data?.response?.[0];
  if (!r?.predictions) return null;

  const p = r.predictions;
  const uo = parseUnderOver(p.under_over ?? null);
  const teamAIsHome = fix.homeId === idA;
  const percentHome = parsePercent(p?.percent?.home);
  const percentAway = parsePercent(p?.percent?.away);

  const result: MatchPrediction = {
    fixtureId: fix.fixtureId,
    homeTeam: fix.homeName,
    awayTeam: fix.awayName,
    teamAIsHome,
    winnerName: p?.winner?.name ?? null,
    winnerComment: p?.winner?.comment ?? null,
    winOrDraw: !!p?.win_or_draw,
    advice: p?.advice ?? '',
    underOver: p?.under_over ?? null,
    totalGoalsLine: uo.line,
    totalGoalsDirection: uo.direction,
    percentHome,
    percentDraw: parsePercent(p?.percent?.draw),
    percentAway,
    percentTeamA: teamAIsHome ? percentHome : percentAway,
    percentTeamB: teamAIsHome ? percentAway : percentHome,
  };

  setCache(ck, result);
  return result;
}

/**
 * Format the algorithmic prediction into a compact text block for the LLM
 * analyst prompt. Returns empty string when there is nothing useful.
 */
export function formatPredictionForPrompt(
  pred: MatchPrediction | null,
  teamAName: string,
  teamBName: string
): string {
  if (!pred) return '';
  const parts: string[] = ['=== API-FOOTBALL ALGORITHMIC PREDICTION ==='];
  if (pred.percentHome != null || pred.percentAway != null) {
    parts.push(
      `Match-result model: ${pred.homeTeam} ${pred.percentHome != null ? (pred.percentHome * 100).toFixed(0) + '%' : '?'} | ` +
      `Draw ${pred.percentDraw != null ? (pred.percentDraw * 100).toFixed(0) + '%' : '?'} | ` +
      `${pred.awayTeam} ${pred.percentAway != null ? (pred.percentAway * 100).toFixed(0) + '%' : '?'}`
    );
  }
  if (pred.winnerName) {
    parts.push(`Predicted edge: ${pred.winnerName}${pred.winnerComment ? ` (${pred.winnerComment})` : ''}`);
  }
  if (pred.totalGoalsLine != null && pred.totalGoalsDirection) {
    parts.push(`Total-goals lean: ${pred.totalGoalsDirection.toUpperCase()} ${pred.totalGoalsLine}`);
  }
  if (pred.advice) parts.push(`Model advice: ${pred.advice}`);
  parts.push('(Treat as one weak-to-moderate input; blend with sharp books and market prices, do not overweight.)');
  return parts.join('\n');
}
// ────────────────────── final-score lookup (settlement) ──────────────────────

export interface FinalScore {
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  date: string;      // ISO date of the fixture
  queriedAIsHome: boolean; // true when the FIRST team argument was the home side
}

/**
 * Look up the FINISHED result of a specific meeting between two teams, used to
 * grade shadow picks and third-party predictions. Matches on the head-to-head
 * feed within a +/- 2 day window of the expected kickoff so a timezone shift or
 * a postponed-by-a-day fixture still resolves.
 *
 * Returns null when the key is missing, a team cannot be resolved, or no
 * completed fixture is found in the window (caller must leave the row open).
 */
const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];

/**
 * Convert a raw API-Football fixture object into a FinalScore, or null when the
 * fixture is not a completed game with a numeric scoreline. `teamAName` (when
 * provided) is used only to decide `queriedAIsHome` via fuzzy name matching so
 * that match_result grading maps the right side; goals-based markets do not
 * depend on it.
 */
function fixtureToFinalScore(f: any, teamAName?: string): FinalScore | null {
  const short = String(f?.fixture?.status?.short ?? '');
  if (!FINISHED_STATUSES.includes(short)) return null;
  const hg = f?.goals?.home;
  const ag = f?.goals?.away;
  if (typeof hg !== 'number' || typeof ag !== 'number') return null;
  const homeName = f?.teams?.home?.name ?? '';
  const awayName = f?.teams?.away?.name ?? '';
  let queriedAIsHome = true;
  if (teamAName) {
    queriedAIsHome = nameScore(teamAName, homeName) >= nameScore(teamAName, awayName);
  }
  return {
    homeTeam: homeName,
    awayTeam: awayName,
    homeGoals: hg,
    awayGoals: ag,
    date: f?.fixture?.date ?? '',
    queriedAIsHome,
  };
}

/**
 * Authoritative settlement lookup: fetch a fixture directly by its
 * API-Football fixture ID (stored in each prediction's rawPayload). This
 * bypasses team-ID resolution and the unreliable head-to-head feed entirely.
 *
 * Returns null when the fixture is missing, not yet completed (NS/PST/…), or
 * has no numeric score — the caller must then leave the row open. Completed
 * fixtures are cached; non-completed ones are NOT cached so a later run picks
 * up the result once the game finishes.
 */
export async function fetchFinalScoreByFixtureId(
  fixtureId: number,
  teamAName?: string,
): Promise<FinalScore | null> {
  if (!getKey() || !fixtureId) return null;

  const ck = `fixres_${fixtureId}`;
  let f = getCached<any>(ck);
  if (!f) {
    const data = await apiFetch(`/fixtures?id=${fixtureId}`);
    f = Array.isArray(data?.response) ? data.response[0] : null;
    if (!f) return null;
    // Only cache completed fixtures; a not-yet-played game must be re-fetched.
    if (FINISHED_STATUSES.includes(String(f?.fixture?.status?.short ?? ''))) {
      setCache(ck, f);
    }
  }
  return fixtureToFinalScore(f, teamAName);
}

/**
 * Fallback settlement lookup for rows that lack a stored fixture ID. Resolves
 * both team IDs, then pulls team A's fixtures around the expected kickoff via
 * the reliable /fixtures endpoint (the head-to-head feed is unreliable and
 * frequently returns nothing for games that clearly happened). Among completed
 * fixtures it picks the one whose opponent matches team B — by ID or fuzzy
 * name — closest to the expected date.
 *
 * Returns null when a team cannot be resolved or no completed matching fixture
 * is found in the window (caller must leave the row open).
 */
export async function fetchFinalScoreByTeams(
  teamAName: string,
  teamBName: string,
  expectedDateISO: string,
): Promise<FinalScore | null> {
  if (!getKey()) return null;
  const [idA, idB] = await Promise.all([resolveTeamId(teamAName), resolveTeamId(teamBName)]);
  if (!idA) return null;

  const target = new Date(expectedDateISO).getTime();
  if (!isFinite(target)) return null;
  const WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
  const from = new Date(target - WINDOW_MS).toISOString().slice(0, 10);
  const to = new Date(target + WINDOW_MS).toISOString().slice(0, 10);

  // Season: calendar year of the match. Split-year European leagues store a
  // Jan–Jul match under the previous year, so try both.
  const year = new Date(target).getUTCFullYear();
  const month = new Date(target).getUTCMonth(); // 0-based
  const seasons = month <= 6 ? [year, year - 1] : [year, year - 1];

  const ck = `teamfix_${idA}_${from}_${to}`;
  let fixtures = getCached<any[]>(ck);
  if (!fixtures) {
    const collected: any[] = [];
    for (const season of seasons) {
      const data = await apiFetch(
        `/fixtures?team=${idA}&season=${season}&from=${from}&to=${to}`,
      );
      const rows = Array.isArray(data?.response) ? (data.response as any[]) : [];
      collected.push(...rows);
      if (rows.length > 0) break; // one season usually holds the window
    }
    fixtures = collected;
    setCache(ck, fixtures);
  }

  let bestRow: any = null;
  let bestDelta = Infinity;
  for (const f of fixtures ?? []) {
    if (!FINISHED_STATUSES.includes(String(f?.fixture?.status?.short ?? ''))) continue;
    // Confirm the opponent is team B (by id when resolvable, else fuzzy name).
    const home = f?.teams?.home;
    const away = f?.teams?.away;
    const oppId = home?.id === idA ? away?.id : home?.id;
    const oppName = home?.id === idA ? (away?.name ?? '') : (home?.name ?? '');
    const opponentMatches = (idB && oppId === idB) || nameScore(teamBName, oppName) >= 50;
    if (!opponentMatches) continue;
    const t = new Date(f?.fixture?.date ?? 0).getTime();
    if (!isFinite(t)) continue;
    const delta = Math.abs(t - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestRow = f;
    }
  }
  if (!bestRow) return null;

  const hg = bestRow?.goals?.home;
  const ag = bestRow?.goals?.away;
  if (typeof hg !== 'number' || typeof ag !== 'number') return null;

  return {
    homeTeam: bestRow?.teams?.home?.name ?? '',
    awayTeam: bestRow?.teams?.away?.name ?? '',
    homeGoals: hg,
    awayGoals: ag,
    date: bestRow?.fixture?.date ?? '',
    queriedAIsHome: bestRow?.teams?.home?.id === idA,
  };
}

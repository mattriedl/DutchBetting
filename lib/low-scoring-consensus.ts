/**
 * Low-Scoring Consensus Module
 *
 * Computes a data-driven "low-scoring likelihood" score for soccer matches.
 * Uses multiple statistical signals from API-Football:
 *
 *  1. Team goals averages (home for/against, away for/against)
 *  2. Recent fixture under-2.5 rates per team (last 10 games)
 *  3. Head-to-head under-2.5 rate
 *  4. API-Football predictions endpoint (model goals + under/over)
 *  5. Poisson-derived under-2.5 probability (when xG is available)
 *
 * These replace scraping Cloudflare-protected prediction sites (footystats,
 * predictz, windrawwin, forebet, thestatbible) which cannot be accessed
 * server-side. The statistical foundation is the same data those sites use.
 *
 * The output is a composite score (0–100) where higher = more likely
 * under 2.5 goals, plus individual indicators for transparency.
 */

const BASE = 'https://v3.football.api-sports.io';

// ────────────────────────── types ──────────────────────────

export interface LowScoringSignal {
  source: string;       // e.g. "team_avg", "recent_form", "h2h", "predictions"
  label: string;        // human-readable
  value: number;        // raw value (under 2.5 probability 0-1 or similar)
  weight: number;       // weight in composite
}

export interface LowScoringConsensus {
  score: number;                // 0-100, higher = more likely low-scoring
  rating: 'strong' | 'moderate' | 'weak' | 'unlikely'; // qualitative
  expectedTotalGoals: number;   // estimated total goals for the match
  under25Probability: number;   // 0-1
  signals: LowScoringSignal[];  // individual data points
  summary: string;              // narrative explanation
  dataAvailable: boolean;       // false if no API-Football data could be fetched
}

// ────────────────────────── helpers ──────────────────────────

function getKey(): string | null {
  return process.env.API_FOOTBALL_KEY || null;
}

// In-memory response cache (process lifetime). API-Football form/prediction data
// changes at most once per day, so a multi-hour TTL massively cuts request volume
// when the same fixtures are researched repeatedly. Previously this module made an
// uncached request on every call, which (combined with the double consensus run)
// was a major driver of daily-quota exhaustion.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const responseCache = new Map<string, { data: any; ts: number }>();
// In-flight de-duplication so concurrent identical requests share one network call.
const inflight = new Map<string, Promise<any>>();

async function apiFetch(path: string): Promise<any> {
  const key = getKey();
  if (!key) return null;

  const cached = responseCache.get(path);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const existing = inflight.get(path);
  if (existing) return existing;

  const p = (async () => {
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { 'x-apisports-key': key },
      });
      if (!res.ok) return null;
      const json = await res.json();
      if (json?.errors && Object.keys(json.errors).length > 0) return null;
      responseCache.set(path, { data: json, ts: Date.now() });
      return json;
    } catch {
      return null;
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, p);
  return p;
}

// ────────────────────────── data fetchers ──────────────────────────

interface TeamGoalsAvg {
  homeFor: number;
  homeAgainst: number;
  awayFor: number;
  awayAgainst: number;
  totalFor: number;
  totalAgainst: number;
}

interface PredictionData {
  underOver: string | null;   // "+2.5" or "-2.5" or null
  goalsHome: string | null;
  goalsAway: string | null;
  homeGoalsAvg: TeamGoalsAvg | null;
  awayGoalsAvg: TeamGoalsAvg | null;
  homeForm: string | null;    // e.g. "67%"
  awayForm: string | null;
  homeLast5GoalsForAvg: number | null;
  homeLast5GoalsAgainstAvg: number | null;
  awayLast5GoalsForAvg: number | null;
  awayLast5GoalsAgainstAvg: number | null;
}

/**
 * Find a fixture ID for a given match by searching upcoming fixtures.
 */
async function findFixtureId(
  teamAId: number,
  teamBId: number
): Promise<number | null> {
  // Try upcoming fixtures for team A
  const data = await apiFetch(`/fixtures?team=${teamAId}&next=10`);
  if (!data?.response?.length) return null;
  for (const f of data.response) {
    const home = f?.teams?.home?.id;
    const away = f?.teams?.away?.id;
    if ((home === teamAId && away === teamBId) ||
        (home === teamBId && away === teamAId)) {
      return f.fixture.id;
    }
  }
  return null;
}

/**
 * Fetch the API-Football predictions for a specific fixture.
 */
async function fetchPrediction(fixtureId: number): Promise<PredictionData | null> {
  const data = await apiFetch(`/predictions?fixture=${fixtureId}`);
  if (!data?.response?.length) return null;
  const p = data.response[0];
  const pred = p.predictions ?? {};

  function parseGoalsAvg(teamData: any): TeamGoalsAvg | null {
    const lg = teamData?.league;
    if (!lg?.goals) return null;
    return {
      homeFor: parseFloat(lg.goals.for?.average?.home ?? '0') || 0,
      homeAgainst: parseFloat(lg.goals.against?.average?.home ?? '0') || 0,
      awayFor: parseFloat(lg.goals.for?.average?.away ?? '0') || 0,
      awayAgainst: parseFloat(lg.goals.against?.average?.away ?? '0') || 0,
      totalFor: parseFloat(lg.goals.for?.average?.total ?? '0') || 0,
      totalAgainst: parseFloat(lg.goals.against?.average?.total ?? '0') || 0,
    };
  }

  const homeTeam = p.teams?.home ?? {};
  const awayTeam = p.teams?.away ?? {};

  return {
    underOver: pred.under_over ?? null,
    goalsHome: pred.goals?.home ?? null,
    goalsAway: pred.goals?.away ?? null,
    homeGoalsAvg: parseGoalsAvg(homeTeam),
    awayGoalsAvg: parseGoalsAvg(awayTeam),
    homeForm: homeTeam.last_5?.form ?? null,
    awayForm: awayTeam.last_5?.form ?? null,
    homeLast5GoalsForAvg: parseFloat(homeTeam.last_5?.goals?.for?.average ?? '0') || null,
    homeLast5GoalsAgainstAvg: parseFloat(homeTeam.last_5?.goals?.against?.average ?? '0') || null,
    awayLast5GoalsForAvg: parseFloat(awayTeam.last_5?.goals?.for?.average ?? '0') || null,
    awayLast5GoalsAgainstAvg: parseFloat(awayTeam.last_5?.goals?.against?.average ?? '0') || null,
  };
}

interface FixtureGoals {
  total: number;
  isUnder25: boolean;
}

/**
 * Fetch last N fixtures for a team and compute under 2.5 rate.
 */
async function fetchRecentU25Rate(
  teamId: number,
  count: number = 10
): Promise<{ rate: number; games: number; goals: FixtureGoals[] } | null> {
  const data = await apiFetch(`/fixtures?team=${teamId}&last=${count}`);
  if (!data?.response?.length) return null;
  const goals: FixtureGoals[] = data.response.map((f: any) => {
    const hg = f?.goals?.home ?? 0;
    const ag = f?.goals?.away ?? 0;
    const total = (hg || 0) + (ag || 0);
    return { total, isUnder25: total < 3 };
  });
  const u25Count = goals.filter(g => g.isUnder25).length;
  return { rate: u25Count / goals.length, games: goals.length, goals };
}

// ────────────────────────── Poisson under 2.5 ──────────────────────────

function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / f;
}

/**
 * Compute P(total goals < 3) using independent Poisson for each team.
 */
function poissonUnder25(lambdaA: number, lambdaB: number): number {
  let p = 0;
  for (let a = 0; a <= 2; a++) {
    for (let b = 0; b <= 2 - a; b++) {
      p += poissonPmf(lambdaA, a) * poissonPmf(lambdaB, b);
    }
  }
  return Math.min(1, Math.max(0, p));
}

// ────────────────────────── team ID resolution ──────────────────────────
// Re-use the same logic from api-football.ts but import would be circular,
// so we call resolveTeamId from the caller and accept IDs directly.

import { resolveTeamId, type H2HRecord } from '@/lib/api-football';

// ────────────────────────── main computation ──────────────────────────

export interface LowScoringInput {
  teamA: string;
  teamB: string;
  league?: string;
  /** If the research already computed xG, pass them to avoid duplication. */
  teamAXg?: number;
  teamBXg?: number;
  /** Sharp bookmaker under-2.5 probability from the-odds-api (pre-fetched). */
  sharpUnder25?: number;
  sharpBooksUsed?: number;
}

/**
 * Compute the low-scoring consensus for a match.
 * Fetches data from API-Football and computes multiple signals.
 * Gracefully degrades if data is unavailable.
 */
export async function computeLowScoringConsensus(
  input: LowScoringInput
): Promise<LowScoringConsensus> {
  const signals: LowScoringSignal[] = [];
  const key = getKey();

  if (!key) {
    return noDataResult('API-Football key not configured');
  }

  // Resolve team IDs
  const [idA, idB] = await Promise.all([
    resolveTeamId(input.teamA),
    resolveTeamId(input.teamB),
  ]);

  if (!idA && !idB) {
    return noDataResult(`Could not resolve teams: ${input.teamA}, ${input.teamB}`);
  }

  // Fetch all data in parallel
  const fixtureId = (idA && idB) ? await findFixtureId(idA, idB) : null;

  const [u25A, u25B, prediction, h2hData] = await Promise.all([
    idA ? fetchRecentU25Rate(idA, 10) : Promise.resolve(null),
    idB ? fetchRecentU25Rate(idB, 10) : Promise.resolve(null),
    fixtureId ? fetchPrediction(fixtureId) : Promise.resolve(null),
    (idA && idB) ? fetchH2HGoals(idA, idB) : Promise.resolve(null),
  ]);

  // ── Signal 1: Team goals averages (from predictions endpoint or fixtures) ──
  let expectedTotal = 0;
  let hasAvgSignal = false;

  if (prediction?.homeGoalsAvg && prediction?.awayGoalsAvg) {
    // Use home team's home scoring + away team's away scoring
    const homeAttack = prediction.homeGoalsAvg.homeFor;
    const homeDef = prediction.homeGoalsAvg.homeAgainst;
    const awayAttack = prediction.awayGoalsAvg.awayFor;
    const awayDef = prediction.awayGoalsAvg.awayAgainst;

    // Expected goals: average of attack/defense matchup
    const expHome = (homeAttack + awayDef) / 2;
    const expAway = (awayAttack + homeDef) / 2;
    expectedTotal = expHome + expAway;

    const u25Prob = expectedTotal < 2.5 ? 0.5 + (2.5 - expectedTotal) * 0.15 : 0.5 - (expectedTotal - 2.5) * 0.15;
    const clamped = Math.min(1, Math.max(0, u25Prob));

    signals.push({
      source: 'team_avg',
      label: `Season avg: ${input.teamA} scores ${homeAttack.toFixed(1)} at home (concedes ${homeDef.toFixed(1)}), ${input.teamB} scores ${awayAttack.toFixed(1)} away (concedes ${awayDef.toFixed(1)}). Expected total: ${expectedTotal.toFixed(1)}`,
      value: clamped,
      weight: 0.25,
    });
    hasAvgSignal = true;
  }

  // ── Signal 2: Recent under 2.5 rates ──
  if (u25A) {
    signals.push({
      source: 'recent_form_A',
      label: `${input.teamA}: ${Math.round(u25A.rate * 100)}% under 2.5 in last ${u25A.games} games`,
      value: u25A.rate,
      weight: 0.2,
    });
  }
  if (u25B) {
    signals.push({
      source: 'recent_form_B',
      label: `${input.teamB}: ${Math.round(u25B.rate * 100)}% under 2.5 in last ${u25B.games} games`,
      value: u25B.rate,
      weight: 0.2,
    });
  }

  // ── Signal 3: Head-to-head under 2.5 rate ──
  if (h2hData && h2hData.games > 0) {
    signals.push({
      source: 'h2h',
      label: `H2H: ${Math.round(h2hData.u25Rate * 100)}% under 2.5 in last ${h2hData.games} meetings (avg ${h2hData.avgGoals.toFixed(1)} goals)`,
      value: h2hData.u25Rate,
      weight: 0.15,
    });
  }

  // ── Signal 4: API-Football predictions model ──
  if (prediction?.underOver) {
    const isUnder = prediction.underOver.startsWith('-');
    signals.push({
      source: 'predictions',
      label: `API-Football model: ${isUnder ? 'Under' : 'Over'} 2.5 goals`,
      value: isUnder ? 0.65 : 0.35,
      weight: 0.1,
    });
  }

  // ── Signal 5: Last-5 goals averages ──
  if (prediction?.homeLast5GoalsForAvg != null && prediction?.awayLast5GoalsForAvg != null) {
    const last5Total =
      (prediction.homeLast5GoalsForAvg ?? 0) +
      (prediction.homeLast5GoalsAgainstAvg ?? 0) +
      (prediction.awayLast5GoalsForAvg ?? 0) +
      (prediction.awayLast5GoalsAgainstAvg ?? 0);
    // Average total per game in last 5
    const avgPerGame = last5Total / 2; // each side contributes half
    const u25Prob = avgPerGame < 2.5 ? 0.55 + (2.5 - avgPerGame) * 0.1 : 0.45 - (avgPerGame - 2.5) * 0.1;
    signals.push({
      source: 'last5_avg',
      label: `Last 5 form: ${input.teamA} avg ${((prediction.homeLast5GoalsForAvg ?? 0) + (prediction.homeLast5GoalsAgainstAvg ?? 0)).toFixed(1)} goals/game, ${input.teamB} avg ${((prediction.awayLast5GoalsForAvg ?? 0) + (prediction.awayLast5GoalsAgainstAvg ?? 0)).toFixed(1)} goals/game`,
      value: Math.min(1, Math.max(0, u25Prob)),
      weight: 0.15,
    });
  }

  // ── Signal 6: Sharp bookmaker consensus (from the-odds-api, pre-fetched) ──
  if (typeof input.sharpUnder25 === 'number' && isFinite(input.sharpUnder25)) {
    signals.push({
      source: 'sharp_books',
      label: `Sharp books: ${Math.round(input.sharpUnder25 * 100)}% under 2.5 (${input.sharpBooksUsed ?? '?'} books, de-vigged)`,
      value: input.sharpUnder25,
      weight: 0.2,
    });
  }

  // ── Signal 7: Poisson model (if xG available) ──
  if (input.teamAXg != null && input.teamBXg != null) {
    const p = poissonUnder25(input.teamAXg, input.teamBXg);
    signals.push({
      source: 'poisson',
      label: `Poisson model: ${Math.round(p * 100)}% under 2.5 (xG: ${input.teamAXg.toFixed(2)} vs ${input.teamBXg.toFixed(2)})`,
      value: p,
      weight: 0.2,
    });
    if (!hasAvgSignal) expectedTotal = input.teamAXg + input.teamBXg;
  }

  if (signals.length === 0) {
    return noDataResult(`No statistical data available for ${input.teamA} vs ${input.teamB}`);
  }

  // ── Compute weighted consensus ──
  const totalWeight = signals.reduce((s, sig) => s + sig.weight, 0);
  const weightedSum = signals.reduce((s, sig) => s + sig.value * sig.weight, 0);
  const rawProb = totalWeight > 0 ? weightedSum / totalWeight : 0.5;
  const score = Math.round(rawProb * 100);

  // If we don't have expectedTotal from averages, estimate from under2.5 prob
  if (!hasAvgSignal && expectedTotal === 0) {
    expectedTotal = rawProb > 0.5 ? 1.5 + (1 - rawProb) * 2 : 2.5 + (0.5 - rawProb) * 2;
  }

  const rating: LowScoringConsensus['rating'] =
    score >= 65 ? 'strong' :
    score >= 50 ? 'moderate' :
    score >= 35 ? 'weak' :
    'unlikely';

  const summary = buildSummary(input, signals, score, rating, expectedTotal);

  return {
    score,
    rating,
    expectedTotalGoals: Math.round(expectedTotal * 10) / 10,
    under25Probability: Math.round(rawProb * 1000) / 1000,
    signals,
    summary,
    dataAvailable: true,
  };
}

// ────────────────────────── H2H goals helper ──────────────────────────

async function fetchH2HGoals(
  teamAId: number,
  teamBId: number
): Promise<{ u25Rate: number; avgGoals: number; games: number } | null> {
  const data = await apiFetch(`/fixtures/headtohead?h2h=${teamAId}-${teamBId}&last=10`);
  if (!data?.response?.length) return null;
  const games = data.response.length;
  let u25 = 0;
  let totalGoals = 0;
  for (const f of data.response) {
    const hg = f?.goals?.home ?? 0;
    const ag = f?.goals?.away ?? 0;
    const t = (hg || 0) + (ag || 0);
    totalGoals += t;
    if (t < 3) u25++;
  }
  return { u25Rate: u25 / games, avgGoals: totalGoals / games, games };
}

// ────────────────────────── summary builder ──────────────────────────

function buildSummary(
  input: LowScoringInput,
  signals: LowScoringSignal[],
  score: number,
  rating: string,
  expectedTotal: number
): string {
  const parts: string[] = [];

  if (rating === 'strong') {
    parts.push(`Strong low-scoring signal (${score}/100) for ${input.teamA} vs ${input.teamB}.`);
  } else if (rating === 'moderate') {
    parts.push(`Moderate low-scoring signal (${score}/100) for ${input.teamA} vs ${input.teamB}.`);
  } else if (rating === 'weak') {
    parts.push(`Weak low-scoring signal (${score}/100) for ${input.teamA} vs ${input.teamB}.`);
  } else {
    parts.push(`Low-scoring unlikely (${score}/100) for ${input.teamA} vs ${input.teamB}.`);
  }

  parts.push(`Expected total goals: ${expectedTotal.toFixed(1)}.`);

  // Highlight the strongest signals
  const sorted = [...signals].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 3);
  for (const s of top) {
    parts.push(s.label + '.');
  }

  return parts.join(' ');
}

// ────────────────────────── no-data fallback ──────────────────────────

function noDataResult(reason: string): LowScoringConsensus {
  return {
    score: 50,
    rating: 'moderate',
    expectedTotalGoals: 2.5,
    under25Probability: 0.5,
    signals: [],
    summary: `Insufficient data for low-scoring analysis: ${reason}. Using neutral estimate.`,
    dataAvailable: false,
  };
}

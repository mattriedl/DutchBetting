/**
 * External prediction tracker
 * ───────────────────────────
 * Pulls third-party football predictions, stores them, grades them against the
 * real final score, and exposes (a) a per-source accuracy scoreboard and (b) a
 * consensus block that can be injected into the research prompts of every app
 * so the AI knows how much each outside source has actually been worth.
 *
 * Sources
 *  • api_football     — API-Football /predictions endpoint (paid key already configured)
 *  • footystats_math  — FootyStats mathematical over/under 2.5 potential
 *  • footystats       — FootyStats BTTS potential
 *
 * IMPORTANT (honesty note): footystats.org's HTML prediction pages sit behind
 * Cloudflare and return 403 to any server-side fetch, so they cannot be
 * scraped from the deployed runtime. The same numbers are served by FootyStats'
 * official API (api.football-data-api.com), which needs a paid key. When
 * FOOTYSTATS_API_KEY is absent we report the source as "needs key" rather than
 * inventing data.
 */

import { prisma } from '@/lib/db';
import { fetchPredictions, fetchFinalScoreByTeams, fetchFinalScoreByFixtureId } from '@/lib/api-football';
import { fetchGoalsMatches, type GoalsMatch } from '@/lib/goals-markets';
import { fetchPolymarketGoalsMatches } from '@/lib/polymarket-goals';

export type ExtSource = 'api_football' | 'footystats_math' | 'footystats';

export const EXT_SOURCES: { id: ExtSource; label: string; detail: string }[] = [
  { id: 'api_football', label: 'API-Football', detail: 'Algorithmic match forecast + total-goals advice' },
  { id: 'footystats_math', label: 'FootyStats (mathematical)', detail: 'Over/Under 2.5 goals potential' },
  { id: 'footystats', label: 'FootyStats (predictions)', detail: 'Both-teams-to-score potential' },
];

const FOOTYSTATS_BASE = 'https://api.football-data-api.com';

// ─────────────────────────── match key normalization ───────────────────────────

function slug(name: string): string {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|ac|afc|club|city|united|de|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Orientation-independent key: date + the two team slugs sorted. Lets rows from
 * different sources (which disagree on home/away naming) join on the same match.
 */
export function normalizeMatchKey(teamA: string, teamB: string, dateISO: string): string {
  const d = (dateISO || '').slice(0, 10);
  const parts = [slug(teamA), slug(teamB)].sort();
  return `${d}|${parts.join('|')}`;
}

// ─────────────────────────── tradeable match universe ───────────────────────────

/**
 * We only track predictions for games we can actually bet, so the accuracy
 * scoreboard is relevant to the book instead of a random global sample.
 */
async function loadTradeableMatches(): Promise<GoalsMatch[]> {
  const [kalshi, poly] = await Promise.all([
    fetchGoalsMatches().catch(() => [] as GoalsMatch[]),
    fetchPolymarketGoalsMatches().catch(() => [] as GoalsMatch[]),
  ]);
  const seen = new Set<string>();
  const out: GoalsMatch[] = [];
  for (const m of [...kalshi, ...poly]) {
    const k = normalizeMatchKey(m.teamA, m.teamB, m.matchDate);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

// ─────────────────────────── ingest: API-Football ───────────────────────────

async function upsertPrediction(row: {
  source: ExtSource;
  league: string;
  matchKey: string;
  matchTitle: string;
  teamA: string;
  teamB: string;
  matchDate: string;
  market: string;
  prediction: string;
  line?: number | null;
  probability?: number | null;
  confidence?: number | null;
  advice?: string | null;
  rawPayload?: any;
}): Promise<void> {
  const data = {
    source: row.source,
    league: row.league,
    matchKey: row.matchKey,
    matchTitle: row.matchTitle,
    teamA: row.teamA,
    teamB: row.teamB,
    matchDate: row.matchDate ? new Date(`${row.matchDate}T12:00:00Z`) : null,
    market: row.market,
    prediction: row.prediction,
    line: row.line ?? null,
    probability: row.probability ?? null,
    confidence: row.confidence ?? null,
    advice: row.advice ?? null,
    rawPayload: row.rawPayload ? JSON.stringify(row.rawPayload).slice(0, 4000) : null,
    fetchedAt: new Date(),
  };
  await prisma.externalPrediction.upsert({
    where: { source_matchKey_market: { source: row.source, matchKey: row.matchKey, market: row.market } },
    // Never clobber a graded row — a settled prediction is the historical record.
    update: { probability: data.probability, confidence: data.confidence, advice: data.advice, fetchedAt: data.fetchedAt },
    create: data,
  });
}

async function ingestApiFootball(matches: GoalsMatch[]): Promise<{ added: number; errors: number }> {
  if (!process.env.API_FOOTBALL_KEY) return { added: 0, errors: 0 };
  let added = 0;
  let errors = 0;
  for (const m of matches) {
    try {
      const p = await fetchPredictions(m.teamA, m.teamB);
      if (!p) continue;
      const key = normalizeMatchKey(m.teamA, m.teamB, m.matchDate);

      // 1) Match result forecast.
      if (p.winnerName) {
        const pickIsA = p.teamAIsHome ? p.winnerName === p.homeTeam : p.winnerName === p.awayTeam;
        await upsertPrediction({
          source: 'api_football',
          league: m.league,
          matchKey: key,
          matchTitle: m.matchTitle,
          teamA: m.teamA,
          teamB: m.teamB,
          matchDate: m.matchDate,
          market: 'match_result',
          prediction: pickIsA ? 'team_a' : 'team_b',
          probability: (pickIsA ? p.percentTeamA : p.percentTeamB) ?? null,
          advice: p.advice || p.winnerComment,
          rawPayload: p,
        });
        added++;
      }

      // 2) Total-goals advice ("+2.5" / "-2.5").
      if (p.totalGoalsDirection && p.totalGoalsLine != null) {
        await upsertPrediction({
          source: 'api_football',
          league: m.league,
          matchKey: key,
          matchTitle: m.matchTitle,
          teamA: m.teamA,
          teamB: m.teamB,
          matchDate: m.matchDate,
          market: 'total_goals',
          prediction: p.totalGoalsDirection, // 'over' | 'under'
          line: p.totalGoalsLine,
          advice: p.advice,
          rawPayload: { underOver: p.underOver },
        });
        added++;
      }
    } catch {
      errors++;
    }
  }
  return { added, errors };
}

// ─────────────────────────── ingest: FootyStats ───────────────────────────

interface FootyRow {
  home_name?: string;
  away_name?: string;
  date_unix?: number;
  competition_id?: number;
  btts_potential?: number;
  o25_potential?: number;
  u25_potential?: number;
  avg_potential?: number;
}

async function fetchFootystatsToday(): Promise<FootyRow[] | null> {
  const key = process.env.FOOTYSTATS_API_KEY;
  if (!key) return null;
  const days = [0, 1]; // today + tomorrow, to cover kickoff timezones
  const rows: FootyRow[] = [];
  for (const off of days) {
    const d = new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
    try {
      const res = await fetch(`${FOOTYSTATS_BASE}/todays-matches?key=${encodeURIComponent(key)}&date=${d}`, {
        cache: 'no-store',
      });
      if (!res.ok) continue;
      const json: any = await res.json();
      if (Array.isArray(json?.data)) rows.push(...json.data);
    } catch {
      /* skip the day */
    }
  }
  return rows;
}

async function ingestFootystats(matches: GoalsMatch[]): Promise<{ added: number; needsKey: boolean; matched: number }> {
  const rows = await fetchFootystatsToday();
  if (rows == null) return { added: 0, needsKey: true, matched: 0 };

  const byKey = new Map<string, FootyRow>();
  for (const r of rows) {
    if (!r.home_name || !r.away_name || !r.date_unix) continue;
    const dateISO = new Date(r.date_unix * 1000).toISOString().slice(0, 10);
    byKey.set(normalizeMatchKey(r.home_name, r.away_name, dateISO), r);
  }

  let added = 0;
  let matched = 0;
  for (const m of matches) {
    const key = normalizeMatchKey(m.teamA, m.teamB, m.matchDate);
    const r = byKey.get(key);
    if (!r) continue;
    matched++;
    const base = {
      league: m.league,
      matchKey: key,
      matchTitle: m.matchTitle,
      teamA: m.teamA,
      teamB: m.teamB,
      matchDate: m.matchDate,
    };

    // Mathematical over/under 2.5 potential (0-100).
    if (typeof r.o25_potential === 'number') {
      const prob = r.o25_potential / 100;
      await upsertPrediction({
        ...base,
        source: 'footystats_math',
        market: 'total_goals',
        prediction: prob >= 0.5 ? 'over' : 'under',
        line: 2.5,
        probability: prob >= 0.5 ? prob : 1 - prob,
        advice: `o25 potential ${r.o25_potential}%${r.avg_potential != null ? `, avg goals potential ${r.avg_potential}` : ''}`,
        rawPayload: { o25_potential: r.o25_potential, u25_potential: r.u25_potential, avg_potential: r.avg_potential },
      });
      added++;
    }

    // BTTS potential (0-100).
    if (typeof r.btts_potential === 'number') {
      const prob = r.btts_potential / 100;
      await upsertPrediction({
        ...base,
        source: 'footystats',
        market: 'btts',
        prediction: prob >= 0.5 ? 'yes' : 'no',
        probability: prob >= 0.5 ? prob : 1 - prob,
        advice: `BTTS potential ${r.btts_potential}%`,
        rawPayload: { btts_potential: r.btts_potential },
      });
      added++;
    }
  }
  return { added, needsKey: false, matched };
}

export interface IngestSummary {
  matchesConsidered: number;
  apiFootball: { added: number; errors: number; enabled: boolean };
  footystats: { added: number; matched: number; needsKey: boolean };
}

/** Pull fresh predictions for every currently-tradeable goals match. */
export async function ingestExternalPredictions(): Promise<IngestSummary> {
  const matches = await loadTradeableMatches();
  const af = await ingestApiFootball(matches);
  const fs = await ingestFootystats(matches);
  return {
    matchesConsidered: matches.length,
    apiFootball: { ...af, enabled: !!process.env.API_FOOTBALL_KEY },
    footystats: fs,
  };
}

// ─────────────────────────── settlement / grading ───────────────────────────

function grade(market: string, prediction: string, line: number | null, homeGoals: number, awayGoals: number, teamAIsHome: boolean): { correct: boolean; actual: string } {
  const total = homeGoals + awayGoals;
  const aGoals = teamAIsHome ? homeGoals : awayGoals;
  const bGoals = teamAIsHome ? awayGoals : homeGoals;

  if (market === 'total_goals') {
    const l = line ?? 2.5;
    const actual = total > l ? 'over' : 'under';
    return { correct: actual === prediction, actual: `${actual} ${l} (${total} goals)` };
  }
  if (market === 'btts') {
    const actual = homeGoals > 0 && awayGoals > 0 ? 'yes' : 'no';
    return { correct: actual === prediction, actual: `btts ${actual}` };
  }
  if (market === 'match_result') {
    const actual = aGoals > bGoals ? 'team_a' : bGoals > aGoals ? 'team_b' : 'draw';
    return { correct: actual === prediction, actual };
  }
  return { correct: false, actual: 'unknown' };
}

export interface SettleSummary {
  checked: number;
  settled: number;
  correct: number;
  unresolved: number;
  abandoned: number;
}

// A prediction whose kickoff is older than this and that still cannot be resolved
// to a FINISHED score is treated as dead — postponed, cancelled, rescheduled far
// out, or carrying a team name the score API cannot match — and is voided. This
// is essential: the settle queue is processed oldest-first, so without draining,
// a wall of permanently-unresolvable old rows sits at the front and blocks every
// finished game behind it from ever being graded (observed: 119/120 unresolved
// per run, only 1 graded).
const STALE_ABANDON_MS = 14 * 24 * 60 * 60 * 1000;

/** Grade every open prediction whose kickoff has passed, using the real result. */
export async function settleExternalPredictions(maxRows = 150): Promise<SettleSummary> {
  // Listed dates are often normalized to midday UTC, so a 3h window catches games
  // that have not actually kicked off yet and burns API quota. 12h is safe.
  const now = Date.now();
  const cutoff = new Date(now - 12 * 60 * 60 * 1000);
  const staleCutoff = now - STALE_ABANDON_MS;
  const open = await prisma.externalPrediction.findMany({
    where: { status: 'open', matchDate: { lt: cutoff } },
    orderBy: { matchDate: 'asc' },
    take: maxRows,
  });

  // Parse each row's payload up front and process rows that carry a fixture ID
  // FIRST, so a match's authoritative score is cached before any sibling row for
  // the same match (e.g. a total_goals row with no fixture ID) is evaluated and
  // possibly drained. Without this ordering a gradeable sibling could be voided.
  const parsed = open.map((row) => {
    let fixtureId: number | null = null;
    let payloadAIsHome: boolean | null = null;
    if (row.rawPayload) {
      try {
        const p = JSON.parse(row.rawPayload);
        if (typeof p?.fixtureId === 'number') fixtureId = p.fixtureId;
        if (typeof p?.teamAIsHome === 'boolean') payloadAIsHome = p.teamAIsHome;
      } catch { /* non-JSON payload — fall back to team lookup */ }
    }
    return { row, fixtureId, payloadAIsHome };
  });
  parsed.sort((a, b) => (a.fixtureId ? 0 : 1) - (b.fixtureId ? 0 : 1));

  // One score lookup per distinct match, shared across that match's rows.
  const scoreCache = new Map<string, Awaited<ReturnType<typeof fetchFinalScoreByTeams>>>();
  let settled = 0;
  let correct = 0;
  let unresolved = 0;
  let abandoned = 0;

  const voidRow = async (id: string, note: string) => {
    await prisma.externalPrediction.update({
      where: { id },
      data: { status: 'void', actualResult: 'void', finalScore: note, settledAt: new Date() },
    });
    abandoned++;
  };

  for (const { row, fixtureId, payloadAIsHome } of parsed) {
    const dateISO = row.matchDate ? row.matchDate.toISOString() : '';
    const isStale = row.matchDate ? row.matchDate.getTime() < staleCutoff : true;

    let score = scoreCache.get(row.matchKey);
    if (score === undefined) {
      // Primary path: direct fixture lookup by ID (reliable). Fallback: the
      // team-based lookup for older rows that lack a stored fixture ID.
      if (fixtureId) {
        score = await fetchFinalScoreByFixtureId(fixtureId, row.teamA).catch(() => null);
        scoreCache.set(row.matchKey, score);
      } else if (!isStale) {
        score = await fetchFinalScoreByTeams(row.teamA, row.teamB, dateISO).catch(() => null);
        scoreCache.set(row.matchKey, score);
      }
      // else: stale row with no fixture ID and no sibling result — leave score
      // undefined so it is drained below without spending an API call on the
      // near-hopeless team-name lookup.
    }
    if (!score) {
      // Not finished / unresolvable. Drain it when stale (postponed, cancelled,
      // rescheduled out of window, or un-matchable); otherwise keep waiting for
      // the result to post.
      if (isStale) {
        await voidRow(
          row.id,
          fixtureId ? 'abandoned — not completed within 14 days of kickoff' : 'abandoned — stale, no fixture id',
        );
      } else {
        unresolved++;
      }
      continue;
    }
    // Prefer the ingestion-time orientation when available (more reliable than
    // re-matching team names at settle time).
    const aIsHome = payloadAIsHome ?? score.queriedAIsHome;
    const g = grade(row.market, row.prediction, row.line, score.homeGoals, score.awayGoals, aIsHome);
    await prisma.externalPrediction.update({
      where: { id: row.id },
      data: {
        status: 'settled',
        actualResult: g.actual,
        correct: g.correct,
        finalScore: `${score.homeGoals}-${score.awayGoals}`,
        settledAt: new Date(),
      },
    });
    settled++;
    if (g.correct) correct++;
  }

  return { checked: open.length, settled, correct, unresolved, abandoned };
}

// ─────────────────────────── accuracy scoreboard ───────────────────────────

export interface SourceAccuracy {
  source: string;
  market: string;
  settled: number;
  correct: number;
  hitRate: number | null;
  brier: number | null;
  open: number;
}

export async function getSourceAccuracy(): Promise<SourceAccuracy[]> {
  const rows = await prisma.externalPrediction.findMany({
    select: { source: true, market: true, status: true, correct: true, probability: true },
  });
  const buckets = new Map<string, { settled: number; correct: number; open: number; bSum: number; bN: number }>();
  for (const r of rows) {
    const k = `${r.source}|${r.market}`;
    const b = buckets.get(k) ?? { settled: 0, correct: 0, open: 0, bSum: 0, bN: 0 };
    if (r.status === 'settled') {
      b.settled++;
      if (r.correct) b.correct++;
      if (typeof r.probability === 'number') {
        const outcome = r.correct ? 1 : 0;
        b.bSum += Math.pow(r.probability - outcome, 2);
        b.bN++;
      }
    } else if (r.status === 'open') {
      b.open++;
    }
    // status === 'void' rows are abandoned (postponed/unresolvable) — excluded
    // from both the graded and the open counts.
    buckets.set(k, b);
  }
  return Array.from(buckets.entries())
    .map(([k, b]) => {
      const [source, market] = k.split('|');
      return {
        source,
        market,
        settled: b.settled,
        correct: b.correct,
        hitRate: b.settled > 0 ? b.correct / b.settled : null,
        brier: b.bN > 0 ? b.bSum / b.bN : null,
        open: b.open,
      };
    })
    .sort((a, b) => b.settled - a.settled);
}

// ─────────────────────────── consensus for research prompts ───────────────────────────

/**
 * Build a compact text block describing what the outside sources say about ONE
 * match, annotated with each source's realized hit rate so the model can weight
 * them honestly. Returns '' when nothing is on file.
 */
export async function getExternalConsensus(teamA: string, teamB: string, dateISO: string): Promise<string> {
  try {
    const key = normalizeMatchKey(teamA, teamB, dateISO);
    const [rows, acc] = await Promise.all([
      prisma.externalPrediction.findMany({ where: { matchKey: key } }),
      getSourceAccuracy(),
    ]);
    if (!rows.length) return '';
    const accMap = new Map(acc.map(a => [`${a.source}|${a.market}`, a]));
    const lines = rows.map(r => {
      const a = accMap.get(`${r.source}|${r.market}`);
      const track =
        a && a.settled >= 10 && a.hitRate != null
          ? ` [this source is ${(a.hitRate * 100).toFixed(0)}% accurate on ${r.market} over ${a.settled} graded picks]`
          : ' [track record still thin]';
      const prob = r.probability != null ? ` @ ${(r.probability * 100).toFixed(0)}%` : '';
      const ln = r.line != null ? ` ${r.line}` : '';
      return `- ${r.source}: ${r.market} → ${r.prediction}${ln}${prob}${track}`;
    });
    return `THIRD-PARTY PREDICTIONS ON FILE FOR THIS MATCH:\n${lines.join('\n')}\nWeight each source by its stated accuracy above; ignore sources with a thin or poor track record.`;
  } catch {
    return '';
  }
}

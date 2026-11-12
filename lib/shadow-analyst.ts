/**
 * Autonomous AI shadow-pick engine (demo mode)
 * ─────────────────────────────────────────────
 * Runs the SAME research + analysis pipeline the manual goals app uses, but with
 * nobody in the loop: for every tradeable match it takes the single pick the
 * model rates as its best positive-EV opportunity, records it at the live price
 * with a fixed notional stake, and later grades it against the real market
 * result. That gives an untouched, selection-bias-free record of whether the
 * AI's "best bet" reads are actually profitable.
 *
 * This is entirely separate from the manual bet ledger — no orders are ever
 * sent, nothing here touches GoalsBetOrder.
 */

import { prisma } from '@/lib/db';
import {
  fetchGoalsMatches,
  analyzeGoals,
  calculateGoalsStake,
  type GoalsMatch,
  type GoalsPick,
} from '@/lib/goals-markets';
import { fetchPolymarketGoalsMatches, fetchPolymarketGoalsResolutions } from '@/lib/polymarket-goals';
import { researchGoalsMatch } from '@/lib/goals-research';
import { getActiveCalibration } from '@/lib/calibration';
import { kalshiPublicFetch } from '@/lib/kalshi-api';
import { fetchFinalScoreByTeams } from '@/lib/api-football';
import { kalshiEffectiveCents } from '@/lib/kalshi-fees';

/** Fixed demo stake per shadow pick, so ROI is comparable across picks. */
export const SHADOW_STAKE_DOLLARS = 10;
/** A shadow pick must clear this calibrated cent-edge to be recorded. */
export const SHADOW_MIN_EDGE_CENTS = 3;
/** ...and this calibrated win probability, to avoid longshot spread artifacts. */
export const SHADOW_MIN_PROB = 0.4;

export interface ShadowRunSummary {
  runId: string;
  matchesScanned: number;
  researched: number;
  picksRecorded: number;
  picksUpdated: number;
  skippedNoEdge: number;
  errors: number;
  calibrated: boolean;
  details: { match: string; outcome: string }[];
}

/** Don't take a pre-match pick closer to kick-off than this. */
const KICKOFF_BUFFER_MS = 15 * 60 * 1000;
/**
 * Matches researched without a qualifying edge are rested this long before being re-checked.
 * Without it, an hourly schedule re-researched the same soonest-kick-off matches every run (they
 * never get a pick, so they never leave the front of the queue) and never reached the rest.
 * In-memory: a restart just means one extra look.
 */
const NO_EDGE_COOLDOWN_MS = 6 * 3600 * 1000;
const noEdgeUntil = new Map<string, number>();

/** Last completed run in this server process (for the AI Tracker page). Resets on restart/deploy. */
export let lastShadowRun: {
  at: string; automated: boolean; matchesScanned: number; researched: number;
  picksRecorded: number; skippedNoEdge: number; errors: number;
} | null = null;

function newRunId(): string {
  return `shadow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Run one autonomous analysis pass.
 * `limit` caps how many matches get the (slow, paid) LLM research treatment.
 */
export async function runShadowAnalysis(opts: { userId: string; limit?: number; automated?: boolean } = { userId: '' }): Promise<ShadowRunSummary> {
  const limit = opts.limit ?? 8;
  const runId = newRunId();
  const summary: ShadowRunSummary = {
    runId,
    matchesScanned: 0,
    researched: 0,
    picksRecorded: 0,
    picksUpdated: 0,
    skippedNoEdge: 0,
    errors: 0,
    calibrated: false,
    details: [],
  };

  const [kalshi, poly, calibration] = await Promise.all([
    fetchGoalsMatches().catch(() => [] as GoalsMatch[]),
    fetchPolymarketGoalsMatches().catch(() => [] as GoalsMatch[]),
    getActiveCalibration('global').catch(() => null),
  ]);

  const all = [...kalshi, ...poly];
  summary.matchesScanned = all.length;

  // Skip matches we already have an open pick on — the engine records one pick
  // per match per app and does not churn it.
  const existing = await prisma.shadowPick.findMany({
    where: { status: 'open' },
    select: { app: true, matchKey: true },
  });
  const openKeys = new Set(existing.map(e => `${e.app}::${e.matchKey}`));

  const now = Date.now();
  for (const [k, until] of noEdgeUntil) if (until <= now) noEdgeUntil.delete(k);
  const candidates = all
    .filter(m => {
      const app = m.source === 'polymarket' ? 'polymarket_goals' : 'goals';
      if (openKeys.has(`${app}::${m.matchKey}`)) return false;
      if (noEdgeUntil.has(`${app}::${m.matchKey}`)) return false;
      // Pre-match picks only: skip matches that have kicked off (or are about to).
      const until = Date.parse(m.bettableUntil ?? '');
      if (Number.isFinite(until) && until - KICKOFF_BUFFER_MS <= now) return false;
      return true;
    })
    // Soonest kickoff first — those are the ones about to become gradeable.
    .sort((a, b) => String(a.matchDate).localeCompare(String(b.matchDate)))
    .slice(0, limit);

  for (const match of candidates) {
    const app = match.source === 'polymarket' ? 'polymarket_goals' : 'goals';
    try {
      const research = await researchGoalsMatch(match);
      summary.researched++;

      const analysis = analyzeGoals(match, {
        minEdge: SHADOW_MIN_EDGE_CENTS,
        lowScoringOnly: false, // the engine is free to take ANY side it likes best
        expectedTotalGoals: research.expectedTotalGoals,
        lowScore: research.lowScoring?.dataAvailable ? research.lowScoring.score : undefined,
        bttsYesProb: research.bttsYesProb,
        overProbByLine: research.overProbByLine,
        minProb: SHADOW_MIN_PROB,
        calibration,
      });
      if (analysis.calibrated) summary.calibrated = true;

      const pick: GoalsPick | null = analysis.recommended ?? analysis.bestOverall;
      const edge = pick?.edge ?? 0;
      const prob = pick?.modelProb ?? 0;
      if (!pick || edge < SHADOW_MIN_EDGE_CENTS || prob < SHADOW_MIN_PROB) {
        summary.skippedNoEdge++;
        noEdgeUntil.set(`${app}::${match.matchKey}`, Date.now() + NO_EDGE_COOLDOWN_MS);
        summary.details.push({
          match: match.matchTitle,
          outcome: `no qualifying edge (best ${pick ? `${pick.label} ${edge.toFixed(1)}¢ @ ${(prob * 100).toFixed(0)}%` : 'none'})`,
        });
        continue;
      }

      const stake = calculateGoalsStake(pick.cost, SHADOW_STAKE_DOLLARS, { kalshiFee: app === 'goals' });
      if (stake.contracts <= 0) {
        summary.skippedNoEdge++;
        continue;
      }

      // EV per contract in cents: p*100 - cost.
      const evPerContract = prob * 100 - (app === 'goals' ? kalshiEffectiveCents(pick.cost) : pick.cost);

      const data = {
        userId: opts.userId,
        runId,
        app,
        source: match.source ?? 'kalshi',
        league: match.league,
        matchKey: match.matchKey,
        matchTitle: match.matchTitle,
        teamA: match.teamA,
        teamB: match.teamB,
        matchDate: match.matchDate ? new Date(`${match.matchDate}T12:00:00Z`) : null,
        marketType: pick.marketType,
        line: pick.line ?? null,
        side: pick.side,
        pickLabel: pick.label,
        marketTicker: pick.marketTicker,
        entryPrice: pick.cost,
        rawModelProb: pick.rawModelProb ?? null,
        modelProb: prob,
        edgeCents: edge,
        evPerContract,
        expectedTotalGoals: research.expectedTotalGoals ?? null,
        lowScore: research.lowScoring?.dataAvailable ? research.lowScoring.score : null,
        rating: analysis.rating,
        contracts: stake.contracts,
        stakeCents: stake.totalCostCents, // includes the Kalshi fee for Kalshi picks
        feeCents: stake.feeCents,
        payoutIfWinCents: stake.expectedPayoutCents,
        researchNote: [
          research.analysis,
          research.keyFactors?.length ? `Key factors: ${research.keyFactors.join('; ')}` : '',
          `Method: ${research.method}`,
        ]
          .filter(Boolean)
          .join('\n\n')
          .slice(0, 4000),
        status: 'open',
      };

      const existingRow = await prisma.shadowPick.findUnique({
        where: { app_matchKey: { app, matchKey: match.matchKey } },
      });
      if (existingRow) {
        if (existingRow.status === 'open') {
          await prisma.shadowPick.update({ where: { id: existingRow.id }, data });
          summary.picksUpdated++;
        }
      } else {
        await prisma.shadowPick.create({ data });
        summary.picksRecorded++;
      }
      summary.details.push({
        match: match.matchTitle,
        outcome: `${pick.label} @ ${pick.cost}¢ — ${(prob * 100).toFixed(0)}% model, +${edge.toFixed(1)}¢ edge`,
      });
    } catch (err: any) {
      summary.errors++;
      summary.details.push({ match: match.matchTitle, outcome: `error: ${err?.message ?? 'unknown'}` });
    }
  }

  lastShadowRun = {
    at: new Date().toISOString(),
    automated: !!opts.automated,
    matchesScanned: summary.matchesScanned,
    researched: summary.researched,
    picksRecorded: summary.picksRecorded,
    skippedNoEdge: summary.skippedNoEdge,
    errors: summary.errors,
  };
  return summary;
}

// ───────────────────────────── settlement ──────────────────────────────

export interface ShadowSettleSummary {
  checked: number;
  settled: number;
  won: number;
  unresolved: number;
}

/**
 * Grade open shadow picks. Preference order:
 *   1. the exchange's own settlement (Kalshi market result / Polymarket resolution)
 *   2. the real final score from API-Football (covers markets that de-list)
 */
export async function settleShadowPicks(maxRows = 100): Promise<ShadowSettleSummary> {
  // 12h so we only look up genuinely finished fixtures (listed times are approximate).
  const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
  const open = await prisma.shadowPick.findMany({
    where: { status: 'open', matchDate: { lt: cutoff } },
    orderBy: { matchDate: 'asc' },
    take: maxRows,
  });

  let settled = 0;
  let won = 0;
  let unresolved = 0;

  const polyCache = new Map<string, Awaited<ReturnType<typeof fetchPolymarketGoalsResolutions>>>();

  for (const p of open) {
    try {
      // yesSide === true when the pick is a buy of the YES outcome.
      const yesSide = p.side === 'over' || p.side === 'btts_yes';
      let yesWon: boolean | null = null;
      let finalGoals: number | null = null;
      let finalScore: string | null = null;

      if (p.source === 'polymarket' && p.marketTicker) {
        let res = polyCache.get(p.matchKey);
        if (!res) {
          res = await fetchPolymarketGoalsResolutions(p.matchKey).catch(() => []);
          polyCache.set(p.matchKey, res);
        }
        const r = res.find(x => x.marketSlug === p.marketTicker);
        if (r?.resolved) yesWon = r.yesWon;
      } else if (p.marketTicker) {
        const mk = await kalshiPublicFetch(`/markets/${p.marketTicker}`).catch(() => null);
        const result = mk?.market?.result;
        if (result === 'yes' || result === 'no') yesWon = result === 'yes';
      }

      // Fallback: derive the outcome from the real final score.
      if (yesWon === null) {
        const score = await fetchFinalScoreByTeams(
          p.teamA,
          p.teamB,
          p.matchDate ? p.matchDate.toISOString() : '',
        ).catch(() => null);
        if (score) {
          finalGoals = score.homeGoals + score.awayGoals;
          finalScore = `${score.homeGoals}-${score.awayGoals}`;
          if (p.marketType === 'btts') {
            yesWon = score.homeGoals > 0 && score.awayGoals > 0;
          } else {
            const line = p.line ?? 2.5;
            yesWon = finalGoals > line;
          }
        }
      }

      if (yesWon === null) {
        unresolved++;
        continue;
      }

      const didWin = yesSide ? yesWon : !yesWon;
      const payout = didWin ? p.contracts * 100 : 0;
      const net = payout - p.stakeCents;

      await prisma.shadowPick.update({
        where: { id: p.id },
        data: {
          status: 'settled',
          settledResult: didWin ? 'won' : 'lost',
          finalGoals,
          finalScore,
          netProfitCents: net,
          settledAt: new Date(),
        },
      });
      settled++;
      if (didWin) won++;
    } catch {
      unresolved++;
    }
  }

  return { checked: open.length, settled, won, unresolved };
}

// ────────────────────────────── scoreboard ──────────────────────────────

export interface ShadowStats {
  open: number;
  settled: number;
  won: number;
  lost: number;
  winRate: number | null;
  stakedCents: number;
  netProfitCents: number;
  roi: number | null;
  brier: number | null;
  meanStatedProb: number | null;
  expectedEvCents: number;
  byApp: {
    app: string;
    settled: number;
    won: number;
    winRate: number | null;
    stakedCents: number;
    netProfitCents: number;
    roi: number | null;
  }[];
}

export async function getShadowStats(): Promise<ShadowStats> {
  const rows = await prisma.shadowPick.findMany({
    select: {
      app: true,
      status: true,
      settledResult: true,
      stakeCents: true,
      netProfitCents: true,
      modelProb: true,
      evPerContract: true,
      contracts: true,
    },
  });

  let open = 0;
  let settled = 0;
  let wonCount = 0;
  let lost = 0;
  let stakedCents = 0;
  let netProfitCents = 0;
  let bSum = 0;
  let bN = 0;
  let probSum = 0;
  let expectedEvCents = 0;

  const apps = new Map<string, { settled: number; won: number; stakedCents: number; netProfitCents: number }>();

  for (const r of rows) {
    expectedEvCents += (r.evPerContract ?? 0) * (r.contracts ?? 0);
    if (r.status !== 'settled') {
      open++;
      continue;
    }
    settled++;
    stakedCents += r.stakeCents ?? 0;
    netProfitCents += r.netProfitCents ?? 0;
    const w = r.settledResult === 'won';
    if (w) wonCount++;
    else lost++;
    if (typeof r.modelProb === 'number') {
      bSum += Math.pow(r.modelProb - (w ? 1 : 0), 2);
      bN++;
      probSum += r.modelProb;
    }
    const a = apps.get(r.app) ?? { settled: 0, won: 0, stakedCents: 0, netProfitCents: 0 };
    a.settled++;
    if (w) a.won++;
    a.stakedCents += r.stakeCents ?? 0;
    a.netProfitCents += r.netProfitCents ?? 0;
    apps.set(r.app, a);
  }

  return {
    open,
    settled,
    won: wonCount,
    lost,
    winRate: settled > 0 ? wonCount / settled : null,
    stakedCents,
    netProfitCents,
    roi: stakedCents > 0 ? netProfitCents / stakedCents : null,
    brier: bN > 0 ? bSum / bN : null,
    meanStatedProb: bN > 0 ? probSum / bN : null,
    expectedEvCents,
    byApp: Array.from(apps.entries()).map(([app, a]) => ({
      app,
      settled: a.settled,
      won: a.won,
      winRate: a.settled > 0 ? a.won / a.settled : null,
      stakedCents: a.stakedCents,
      netProfitCents: a.netProfitCents,
      roi: a.stakedCents > 0 ? a.netProfitCents / a.stakedCents : null,
    })),
  };
}

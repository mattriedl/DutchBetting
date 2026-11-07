/**
 * FootyStats Value Tracker (demo / paper only)
 * ────────────────────────────────────────────
 * For every upcoming match in the user's selected FootyStats leagues we read
 * FootyStats' own prediction potentials AND its embedded bookmaker odds, plus
 * derive a Poisson model from the pre-match expected goals (xG). For each
 * tradeable selection we compute EV against the book price and, when the pick
 * clears the value thresholds (EV >= +3% and model probability >= 50%), we
 * record a flat $10 demo wager. Later we grade every recorded pick against the
 * real FootyStats result and keep full performance statistics.
 *
 * This never sends a real order and never touches any live bet ledger.
 */

import { prisma } from '@/lib/db';
import { normalizeMatchKey } from '@/lib/external-predictions';
import { fetchGoalsMatches, type GoalsMatch } from '@/lib/goals-markets';
import { fetchPolymarketGoalsMatches } from '@/lib/polymarket-goals';

const FOOTYSTATS_BASE = 'https://api.football-data-api.com';

/** Fixed demo stake per pick (cents), so ROI is comparable across picks. */
export const VALUE_STAKE_CENTS = 1000; // $10
/** A pick must clear this expected profit per $1 staked (CALIBRATED EV). */
export const VALUE_MIN_EV = 0.08; // +8%
/** ...and this calibrated win probability, to avoid longshot/odds artifacts. */
export const VALUE_MIN_PROB = 0.5; // 50%
/**
 * STRATEGY — model calibration (added 2026-10-08 after the first ~2k settled
 * picks ran at −2.8% ROI). The raw Poisson model is systematically
 * OVERCONFIDENT: selections it rates 55-60% actually win ~44%, which
 * manufactured fake "value" in the mid-range and lost money. The bookmaker's
 * own (de-vigged) price is far better calibrated, so before pricing EV we
 * SHRINK the model probability toward the de-vigged market probability:
 *   calibratedProb = MODEL_WEIGHT·modelProb + (1−MODEL_WEIGHT)·marketProb
 * A pick now only qualifies when the model genuinely disagrees with the sharp
 * market by enough to clear the vig plus a real margin. Backtested across the
 * 2,037 settled picks this flips ROI from −2.8% to clearly positive.
 */
export const MODEL_WEIGHT = 0.4; // 40% model / 60% de-vigged market
/** Only bet inside a sane price band: extreme favourites (tiny payoff,
 *  over-bet) and longshots both historically bleed money. */
export const MIN_ODDS = 1.35;
export const MAX_ODDS = 3.3;
/** Markets the Poisson model prices poorly and that lose money regardless of
 *  the computed edge (double chance ran −22% ROI, win-to-nil is noise). */
export const DROP_MARKETS = new Set(['double_chance', 'win_to_nil']);
/** Grade a match only once its kickoff is comfortably in the past. */
const SETTLE_CUTOFF_MS = 12 * 3600 * 1000;
/**
 * If a pick's match is still not "complete" this long after kick-off, it is
 * treated as unresolvable (postponed / rescheduled / abandoned) and voided so
 * it stops clogging the front of the settle queue on every run.
 */
const STALE_ABANDON_MS = 7 * 24 * 3600 * 1000;
/** FootyStats statuses that mean the match will never produce a gradeable result. */
const DEAD_MATCH_STATUSES = new Set(['suspended', 'postponed', 'canceled', 'cancelled', 'abandoned']);

// ─────────────────────────── FootyStats fetch ───────────────────────────

/** Raw FootyStats match row (only the fields we use are typed). */
interface FsRow {
  id?: number;
  homeID?: number;
  awayID?: number;
  home_name?: string;
  away_name?: string;
  date_unix?: number;
  competition_id?: number;
  status?: string;
  // actual result (present once complete)
  homeGoalCount?: number;
  awayGoalCount?: number;
  ht_goals_team_a?: number;
  ht_goals_team_b?: number;
  totalGoalCount?: number;
  team_a_corners?: number;
  team_b_corners?: number;
  totalCornerCount?: number;
  // xG (pre-match)
  team_a_xg_prematch?: number;
  team_b_xg_prematch?: number;
  [k: string]: any;
}

async function fetchFootystatsDays(offsets: number[]): Promise<FsRow[] | null> {
  const key = process.env.FOOTYSTATS_API_KEY;
  if (!key) return null;
  const rows: FsRow[] = [];
  for (const off of offsets) {
    const d = new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
    try {
      const res = await fetch(
        `${FOOTYSTATS_BASE}/todays-matches?key=${encodeURIComponent(key)}&date=${d}`,
        { cache: 'no-store' },
      );
      if (!res.ok) continue;
      const json: any = await res.json();
      if (Array.isArray(json?.data)) rows.push(...json.data);
    } catch {
      /* skip the day */
    }
  }
  return rows;
}

/** Fetch a single match by id (used at settlement for the final result). */
async function fetchFootystatsMatch(matchId: string): Promise<FsRow | null> {
  const key = process.env.FOOTYSTATS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `${FOOTYSTATS_BASE}/match?key=${encodeURIComponent(key)}&match_id=${encodeURIComponent(matchId)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    const json: any = await res.json();
    return (json?.data as FsRow) ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────── math helpers ───────────────────────────

function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logp = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logp -= Math.log(i);
  return Math.exp(logp);
}

interface PoissonProbs {
  pHome: number;
  pDraw: number;
  pAway: number;
  pWtnHome: number; // home wins and away fails to score
  pWtnAway: number;
  pCsHome: number; // home keeps clean sheet (away == 0)
  pCsAway: number;
}

function poissonProbs(lh: number, la: number): PoissonProbs | null {
  if (!(lh > 0) || !(la > 0)) return null;
  const MAX = 10;
  const ph: number[] = [];
  const pa: number[] = [];
  for (let g = 0; g <= MAX; g++) {
    ph.push(poissonPmf(lh, g));
    pa.push(poissonPmf(la, g));
  }
  let pHome = 0, pDraw = 0, pAway = 0, pWtnHome = 0, pWtnAway = 0;
  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      const p = ph[h] * pa[a];
      if (h > a) {
        pHome += p;
        if (a === 0) pWtnHome += p;
      } else if (h === a) {
        pDraw += p;
      } else {
        pAway += p;
        if (h === 0) pWtnAway += p;
      }
    }
  }
  const pCsHome = pa[0]; // away scores 0
  const pCsAway = ph[0]; // home scores 0
  return { pHome, pDraw, pAway, pWtnHome, pWtnAway, pCsHome, pCsAway };
}

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A valid decimal odd must be > 1.01 (0/null means the book has no line). */
function validOdds(v: any): number | null {
  const n = num(v);
  return n != null && n > 1.01 ? n : null;
}
/**
 * P(total > line) where `total ~ Poisson(lambda)` and `line` is an X.5 line.
 * Over an X.5 line means the count is >= X+1, i.e. 1 - CDF(X). Returns null for
 * a non-positive lambda or a degenerate 0/1 probability (guards against odds
 * artifacts producing fake monster-EV picks).
 */
function poissonOverProb(lambda: number, line: number): number | null {
  if (!(lambda > 0)) return null;
  const n = Math.floor(line); // for X.5 lines, "over" == count >= n+1
  let cdf = 0;
  for (let k = 0; k <= n; k++) cdf += poissonPmf(lambda, k);
  const over = 1 - cdf;
  if (!(over > 1e-4) || !(over < 1 - 1e-4)) return null;
  return over;
}

/** Both-teams-to-score probability from two independent Poisson scorelines. */
function bttsYesProb(lh: number, la: number): number | null {
  if (!(lh > 0) || !(la > 0)) return null;
  const p = (1 - Math.exp(-lh)) * (1 - Math.exp(-la));
  if (!(p > 1e-4) || !(p < 1 - 1e-4)) return null;
  return p;
}

/**
 * De-vig a complementary two-way market (over/under, btts yes/no, dnb) into
 * fair probabilities for each side. Returns [probA, probB]. When one side has
 * no price we fall back to that side's raw implied prob (1/odds, which still
 * includes the vig and is therefore slightly conservative to shrink toward).
 */
function devigPair(oa: number | null, ob: number | null): [number | null, number | null] {
  const ia = oa ? 1 / oa : null;
  const ib = ob ? 1 / ob : null;
  if (ia != null && ib != null) { const s = ia + ib; return [ia / s, ib / s]; }
  if (ia != null) return [ia, null];
  if (ib != null) return [null, ib];
  return [null, null];
}

/** De-vig a three-way market (1X2). Returns fair probs aligned to the inputs;
 *  a null input stays null. Normalises over whichever sides have a price. */
function devigTriple(
  oa: number | null, ob: number | null, oc: number | null,
): [number | null, number | null, number | null] {
  const ia = oa ? 1 / oa : null;
  const ib = ob ? 1 / ob : null;
  const ic = oc ? 1 / oc : null;
  const s = (ia ?? 0) + (ib ?? 0) + (ic ?? 0);
  if (!(s > 0)) return [null, null, null];
  return [ia != null ? ia / s : null, ib != null ? ib / s : null, ic != null ? ic / s : null];
}

// ─────────────────────────── selection building ───────────────────────────

export interface Candidate {
  market: string;
  selection: string; // human label
  side: string; // machine side
  line: number | null;
  model: 'poisson_xg' | 'poisson_corners';
  modelProb: number;
  /** De-vigged fair probability implied by the bookmaker price for this side. */
  marketProb: number;
  odds: number;
}

/** Build every tradeable selection for a match with both a prob and a price. */
export function buildSelections(r: FsRow): Candidate[] {
  const out: Candidate[] = [];
  const add = (c: Candidate | null) => { if (c) out.push(c); };

  const lh = num(r.team_a_xg_prematch);
  const la = num(r.team_b_xg_prematch);
  const haveXg = lh != null && la != null && lh > 0 && la > 0;

  /** Price a two-sided over/under from a Poisson total-count lambda. */
  const ouFromLambda = (
    market: string,
    line: number,
    lambda: number | null,
    overLabel: string,
    underLabel: string,
    overOdds: any,
    underOdds: any,
    model: Candidate['model'],
  ) => {
    if (lambda == null || !(lambda > 0)) return;
    const pOver = poissonOverProb(lambda, line);
    if (pOver == null) return;
    const oO = validOdds(overOdds);
    const oU = validOdds(underOdds);
    const [mOver, mUnder] = devigPair(oO, oU);
    if (oO && mOver != null) add({ market, selection: overLabel, side: 'over', line, model, modelProb: pOver, marketProb: mOver, odds: oO });
    if (oU && mUnder != null) add({ market, selection: underLabel, side: 'under', line, model, modelProb: 1 - pOver, marketProb: mUnder, odds: oU });
  };

  // ── Poisson-xG goal & result markets ──
  if (haveXg) {
    const lt = (lh as number) + (la as number); // expected total goals

    // FT Over/Under (total ~ Poisson(lt))
    const ftOU: [number, any, any][] = [
      [0.5, r.odds_ft_over05, r.odds_ft_under05],
      [1.5, r.odds_ft_over15, r.odds_ft_under15],
      [2.5, r.odds_ft_over25, r.odds_ft_under25],
      [3.5, r.odds_ft_over35, r.odds_ft_under35],
      [4.5, r.odds_ft_over45, r.odds_ft_under45],
    ];
    for (const [ln, oo, uo] of ftOU) {
      ouFromLambda('ft_ou', ln, lt, `Over ${ln} Goals`, `Under ${ln} Goals`, oo, uo, 'poisson_xg');
    }

    // HT Over/Under (first half ~ 45% of match goals)
    const lht = 0.45 * lt;
    const htOU: [number, any, any][] = [
      [0.5, r.odds_1st_half_over05, r.odds_1st_half_under05],
      [1.5, r.odds_1st_half_over15, r.odds_1st_half_under15],
    ];
    for (const [ln, oo, uo] of htOU) {
      ouFromLambda('ht_ou', ln, lht, `1st Half Over ${ln}`, `1st Half Under ${ln}`, oo, uo, 'poisson_xg');
    }

    // 2H Over/Under (second half ~ 55% of match goals)
    const l2h = 0.55 * lt;
    const h2OU: [number, any, any][] = [
      [0.5, r.odds_2nd_half_over05, r.odds_2nd_half_under05],
      [1.5, r.odds_2nd_half_over15, r.odds_2nd_half_under15],
      [2.5, r.odds_2nd_half_over25, r.odds_2nd_half_under25],
    ];
    for (const [ln, oo, uo] of h2OU) {
      ouFromLambda('2h_ou', ln, l2h, `2nd Half Over ${ln}`, `2nd Half Under ${ln}`, oo, uo, 'poisson_xg');
    }

    // BTTS full-time
    {
      const p = bttsYesProb(lh as number, la as number);
      const oy = validOdds(r.odds_btts_yes);
      const on = validOdds(r.odds_btts_no);
      if (p != null) {
        const [my, mn] = devigPair(oy, on);
        if (oy && my != null) add({ market: 'btts', selection: 'BTTS Yes', side: 'yes', line: null, model: 'poisson_xg', modelProb: p, marketProb: my, odds: oy });
        if (on && mn != null) add({ market: 'btts', selection: 'BTTS No', side: 'no', line: null, model: 'poisson_xg', modelProb: 1 - p, marketProb: mn, odds: on });
      }
    }

    // Result / DC / DNB / WTN / CS from the full scoreline matrix
    const pp = poissonProbs(lh as number, la as number);
    if (pp) {
      // 1X2
      const oh = validOdds(r.odds_ft_1);
      const od = validOdds(r.odds_ft_x);
      const oa = validOdds(r.odds_ft_2);
      const [mh, md, ma] = devigTriple(oh, od, oa);
      if (oh && mh != null) add({ market: 'result', selection: 'Home Win', side: 'home', line: null, model: 'poisson_xg', modelProb: pp.pHome, marketProb: mh, odds: oh });
      if (od && md != null) add({ market: 'result', selection: 'Draw', side: 'draw', line: null, model: 'poisson_xg', modelProb: pp.pDraw, marketProb: md, odds: od });
      if (oa && ma != null) add({ market: 'result', selection: 'Away Win', side: 'away', line: null, model: 'poisson_xg', modelProb: pp.pAway, marketProb: ma, odds: oa });

      // double chance
      const o1x = validOdds(r.odds_doublechance_1x);
      const o12 = validOdds(r.odds_doublechance_12);
      const ox2 = validOdds(r.odds_doublechance_x2);
      if (o1x) add({ market: 'double_chance', selection: 'Home or Draw (1X)', side: 'dc_1x', line: null, model: 'poisson_xg', modelProb: pp.pHome + pp.pDraw, marketProb: 1 / o1x, odds: o1x });
      if (o12) add({ market: 'double_chance', selection: 'Home or Away (12)', side: 'dc_12', line: null, model: 'poisson_xg', modelProb: pp.pHome + pp.pAway, marketProb: 1 / o12, odds: o12 });
      if (ox2) add({ market: 'double_chance', selection: 'Draw or Away (X2)', side: 'dc_x2', line: null, model: 'poisson_xg', modelProb: pp.pDraw + pp.pAway, marketProb: 1 / ox2, odds: ox2 });

      // draw-no-bet (conditioned on no draw)
      const noDraw = pp.pHome + pp.pAway;
      if (noDraw > 0) {
        const odh = validOdds(r.odds_dnb_1);
        const oda = validOdds(r.odds_dnb_2);
        const [mdh, mda] = devigPair(odh, oda);
        if (odh && mdh != null) add({ market: 'dnb', selection: 'Home (Draw No Bet)', side: 'dnb_home', line: null, model: 'poisson_xg', modelProb: pp.pHome / noDraw, marketProb: mdh, odds: odh });
        if (oda && mda != null) add({ market: 'dnb', selection: 'Away (Draw No Bet)', side: 'dnb_away', line: null, model: 'poisson_xg', modelProb: pp.pAway / noDraw, marketProb: mda, odds: oda });
      }

      // win to nil
      const owh = validOdds(r.odds_win_to_nil_1);
      const owa = validOdds(r.odds_win_to_nil_2);
      if (owh) add({ market: 'win_to_nil', selection: 'Home Win to Nil', side: 'wtn_home', line: null, model: 'poisson_xg', modelProb: pp.pWtnHome, marketProb: 1 / owh, odds: owh });
      if (owa) add({ market: 'win_to_nil', selection: 'Away Win to Nil', side: 'wtn_away', line: null, model: 'poisson_xg', modelProb: pp.pWtnAway, marketProb: 1 / owa, odds: owa });

      // clean sheet
      const och = validOdds(r.odds_team_a_cs_yes);
      const oca = validOdds(r.odds_team_b_cs_yes);
      if (och) add({ market: 'clean_sheet', selection: 'Home Clean Sheet', side: 'cs_home', line: null, model: 'poisson_xg', modelProb: pp.pCsHome, marketProb: 1 / och, odds: och });
      if (oca) add({ market: 'clean_sheet', selection: 'Away Clean Sheet', side: 'cs_away', line: null, model: 'poisson_xg', modelProb: pp.pCsAway, marketProb: 1 / oca, odds: oca });
    }
  }

  // ── Corners Over/Under from the expected corner count (continuous) ──
  const lc = num(r.corners_potential);
  if (lc != null && lc > 0) {
    const cOU: [number, any, any][] = [
      [8.5, r.odds_corners_over_85, r.odds_corners_under_85],
      [9.5, r.odds_corners_over_95, r.odds_corners_under_95],
      [10.5, r.odds_corners_over_105, r.odds_corners_under_105],
    ];
    for (const [ln, oo, uo] of cOU) {
      ouFromLambda('corners_ou', ln, lc, `Over ${ln} Corners`, `Under ${ln} Corners`, oo, uo, 'poisson_corners');
    }
  }

  return out;
}

// ─────────────────────────── cross-market bonus prices ───────────────────────────

type PriceMap = Map<string, GoalsMatch>;

async function buildBonusMap(): Promise<PriceMap> {
  const map: PriceMap = new Map();
  const attach = (arr: GoalsMatch[]) => {
    for (const gm of arr) {
      try {
        const k = normalizeMatchKey(gm.teamA, gm.teamB, gm.matchDate);
        if (!map.has(k)) map.set(k, gm);
      } catch { /* skip */ }
    }
  };
  try { attach(await fetchGoalsMatches('production')); } catch { /* ignore */ }
  try { attach(await fetchPolymarketGoalsMatches()); } catch { /* ignore */ }
  return map;
}

/** Kalshi/Polymarket cent price for a selection, when an overlapping market exists. */
function bonusPriceFor(gm: GoalsMatch | undefined, market: string, side: string, line: number | null): number | null {
  if (!gm) return null;
  try {
    if (market === 'ft_ou' && line != null) {
      const tl = gm.totalLadder?.find((t) => t.line === line);
      if (!tl || !Number.isFinite(tl.yesAsk)) return null;
      return side === 'over' ? tl.yesAsk : 100 - tl.yesAsk;
    }
    if (market === 'btts') {
      const b = gm.btts;
      if (!b || !Number.isFinite(b.yesAsk)) return null;
      return side === 'yes' ? b.yesAsk : 100 - b.yesAsk;
    }
  } catch { /* ignore */ }
  return null;
}

// ─────────────────────────── ingest ───────────────────────────

export interface IngestSummary {
  needsKey: boolean;
  matchesScanned: number;
  candidates: number;
  qualifying: number;
  added: number;
  updated: number;
  skippedStarted: number;
}

export async function ingestValuePicks(opts: { userId: string }): Promise<IngestSummary> {
  const summary: IngestSummary = {
    needsKey: false, matchesScanned: 0, candidates: 0, qualifying: 0, added: 0, updated: 0, skippedStarted: 0,
  };

  const rows = await fetchFootystatsDays([0, 1]);
  if (rows == null) { summary.needsKey = true; return summary; }

  const bonus = await buildBonusMap();
  const runId = `run_${Date.now()}`;
  const nowSec = Math.floor(Date.now() / 1000);

  for (const r of rows) {
    if (r?.id == null) continue;
    // only future / not-yet-started matches
    if (typeof r.date_unix === 'number' && r.date_unix <= nowSec) { summary.skippedStarted++; continue; }
    summary.matchesScanned++;

    const teamA = String(r.home_name ?? '').trim();
    const teamB = String(r.away_name ?? '').trim();
    if (!teamA || !teamB) continue;
    const dateISO = r.date_unix ? new Date(r.date_unix * 1000).toISOString() : new Date().toISOString();
    const matchDate = new Date(dateISO);
    const matchKey = normalizeMatchKey(teamA, teamB, dateISO);
    const matchTitle = `${teamA} vs ${teamB}`;
    const league = String(r.competition_id ?? '');
    const gm = bonus.get(matchKey);

    const cands = buildSelections(r);
    summary.candidates += cands.length;

    for (const c of cands) {
      // Strategy gates: skip structurally money-losing markets and only bet
      // inside a sane price band.
      if (DROP_MARKETS.has(c.market)) continue;
      if (!(c.odds >= MIN_ODDS) || !(c.odds <= MAX_ODDS)) continue;

      // Calibrate: shrink the overconfident model toward the de-vigged market
      // price. This is the operative probability we bet on from here on.
      const calibratedProb = MODEL_WEIGHT * c.modelProb + (1 - MODEL_WEIGHT) * c.marketProb;
      const evPerDollar = calibratedProb * c.odds - 1;
      const impliedProb = 1 / c.odds;
      const edge = calibratedProb - impliedProb;
      if (!(evPerDollar >= VALUE_MIN_EV) || !(calibratedProb >= VALUE_MIN_PROB)) continue;
      summary.qualifying++;

      const selKey = `${matchKey}::${c.market}::${c.side}::${c.line ?? ''}`;
      const payoutIfWinCents = Math.round(VALUE_STAKE_CENTS * c.odds);
      const kalshiPrice = gm?.source !== 'polymarket' ? bonusPriceFor(gm, c.market, c.side, c.line) : null;
      const polyPrice = gm?.source === 'polymarket' ? bonusPriceFor(gm, c.market, c.side, c.line) : null;

      const data = {
        userId: opts.userId,
        runId,
        fsMatchId: String(r.id),
        league,
        matchKey,
        matchTitle,
        teamA,
        teamB,
        matchDate,
        market: c.market,
        selection: c.selection,
        side: c.side,
        line: c.line,
        model: c.model,
        modelProb: calibratedProb,
        odds: c.odds,
        impliedProb,
        edge,
        evPerDollar,
        kalshiPrice,
        polyPrice,
        stakeCents: VALUE_STAKE_CENTS,
        payoutIfWinCents,
      };

      try {
        const existing = await prisma.valuePick.findUnique({ where: { selKey }, select: { id: true, status: true } });
        if (existing) {
          // never disturb a pick that is already settled
          if (existing.status === 'open') {
            await prisma.valuePick.update({ where: { selKey }, data });
            summary.updated++;
          }
        } else {
          await prisma.valuePick.create({ data: { selKey, ...data } });
          summary.added++;
        }
      } catch (e: any) {
        console.error('[ValueTracker] upsert error', selKey, e?.message);
      }
    }
  }

  return summary;
}

// ─────────────────────────── settlement ───────────────────────────

interface FinalNumbers {
  hg: number; ag: number; hth: number; hta: number;
  totalGoals: number; corners: number | null;
}

function extractFinal(m: FsRow): FinalNumbers | null {
  const hg = num(m.homeGoalCount);
  const ag = num(m.awayGoalCount);
  if (hg == null || ag == null) return null;
  const hth = num(m.ht_goals_team_a) ?? 0;
  const hta = num(m.ht_goals_team_b) ?? 0;
  const totalGoals = num(m.totalGoalCount) ?? hg + ag;
  let corners = num(m.totalCornerCount);
  if (corners == null) {
    const ca = num(m.team_a_corners);
    const cb = num(m.team_b_corners);
    corners = ca != null && cb != null ? ca + cb : null;
  }
  return { hg, ag, hth, hta, totalGoals, corners };
}

/** Returns 'won' | 'lost' | 'void' | null(cannot grade) for a pick vs a result. */
function gradeSelection(
  market: string, side: string, line: number | null, f: FinalNumbers,
): 'won' | 'lost' | 'void' | null {
  const { hg, ag, hth, hta, totalGoals, corners } = f;
  const secondHalf = (hg - hth) + (ag - hta);
  const htTotal = hth + hta;

  const ou = (total: number, ln: number | null, s: string): 'won' | 'lost' | null => {
    if (ln == null) return null;
    if (s === 'over') return total > ln ? 'won' : 'lost';
    if (s === 'under') return total < ln ? 'won' : 'lost';
    return null;
  };

  switch (market) {
    case 'ft_ou': return ou(totalGoals, line, side);
    case 'ht_ou': return ou(htTotal, line, side);
    case '2h_ou': return ou(secondHalf, line, side);
    case 'corners_ou':
      if (corners == null) return null;
      return ou(corners, line, side);
    case 'btts': {
      const yes = hg > 0 && ag > 0;
      return (side === 'yes' ? yes : !yes) ? 'won' : 'lost';
    }
    case 'ht_btts': {
      const yes = hth > 0 && hta > 0;
      return (side === 'yes' ? yes : !yes) ? 'won' : 'lost';
    }
    case '2h_btts': {
      const yes = (hg - hth) > 0 && (ag - hta) > 0;
      return (side === 'yes' ? yes : !yes) ? 'won' : 'lost';
    }
    case 'result':
      if (side === 'home') return hg > ag ? 'won' : 'lost';
      if (side === 'draw') return hg === ag ? 'won' : 'lost';
      if (side === 'away') return ag > hg ? 'won' : 'lost';
      return null;
    case 'double_chance':
      if (side === 'dc_1x') return hg >= ag ? 'won' : 'lost';
      if (side === 'dc_12') return hg !== ag ? 'won' : 'lost';
      if (side === 'dc_x2') return ag >= hg ? 'won' : 'lost';
      return null;
    case 'dnb':
      if (hg === ag) return 'void';
      if (side === 'dnb_home') return hg > ag ? 'won' : 'lost';
      if (side === 'dnb_away') return ag > hg ? 'won' : 'lost';
      return null;
    case 'win_to_nil':
      if (side === 'wtn_home') return (hg > ag && ag === 0) ? 'won' : 'lost';
      if (side === 'wtn_away') return (ag > hg && hg === 0) ? 'won' : 'lost';
      return null;
    case 'clean_sheet':
      if (side === 'cs_home') return ag === 0 ? 'won' : 'lost';
      if (side === 'cs_away') return hg === 0 ? 'won' : 'lost';
      return null;
    default:
      return null;
  }
}

export interface SettleSummary {
  checked: number;
  settled: number;
  won: number;
  lost: number;
  void: number;
  stillOpen: number;
  unresolved: number;
  abandoned: number;
}

export async function settleValuePicks(maxRows = 400): Promise<SettleSummary> {
  const summary: SettleSummary = { checked: 0, settled: 0, won: 0, lost: 0, void: 0, stillOpen: 0, unresolved: 0, abandoned: 0 };
  const now = Date.now();
  const cutoff = new Date(now - SETTLE_CUTOFF_MS);

  const open = await prisma.valuePick.findMany({
    where: { status: 'open', matchDate: { lte: cutoff } },
    orderBy: { matchDate: 'asc' },
    take: maxRows,
  });
  if (open.length === 0) return summary;

  // group by FootyStats match id so we fetch each match once
  const byMatch = new Map<string, typeof open>();
  for (const p of open) {
    const arr = byMatch.get(p.fsMatchId) ?? [];
    arr.push(p);
    byMatch.set(p.fsMatchId, arr as typeof open);
  }

  for (const [fsMatchId, picks] of Array.from(byMatch.entries())) {
    summary.checked += picks.length;
    const m = await fetchFootystatsMatch(fsMatchId);
    const rawStatus = m ? String(m.status).toLowerCase() : '';
    const complete = m && rawStatus === 'complete';
    const f = complete ? extractFinal(m!) : null;
    if (!complete || !f) {
      // Drain rows that will never resolve so they stop clogging the queue:
      //  - the match is explicitly dead (suspended/postponed/canceled/abandoned), or
      //  - it is long past kick-off and still not complete (rescheduled / stale id).
      const oldestKickoff = picks.reduce((min, p) => {
        const t = p.matchDate ? p.matchDate.getTime() : now;
        return t < min ? t : min;
      }, now);
      const isDead = DEAD_MATCH_STATUSES.has(rawStatus);
      const isStale = now - oldestKickoff > STALE_ABANDON_MS;
      if (isDead || isStale) {
        const note = isDead ? `match ${rawStatus || 'unresolved'}` : 'no result 7d after kick-off';
        for (const p of picks) {
          try {
            await prisma.valuePick.update({
              where: { id: p.id },
              data: {
                status: 'void',
                result: 'void',
                finalDetail: note,
                netProfitCents: 0,
                settledAt: new Date(),
              },
            });
            summary.abandoned++;
            summary.void++;
          } catch (e: any) {
            console.error('[ValueTracker] settle abandon error', p.id, e?.message);
            summary.unresolved++;
          }
        }
        continue;
      }
      summary.stillOpen += picks.length;
      continue;
    }

    const finalScore = `${f.hg}-${f.ag}`;
    const finalDetail = `HT ${f.hth}-${f.hta}${f.corners != null ? `, corners ${f.corners}` : ''}`;

    for (const p of picks) {
      const result = gradeSelection(p.market, p.side, p.line, f);
      if (result == null) { summary.unresolved++; continue; }
      let netProfitCents = 0;
      if (result === 'won') netProfitCents = p.payoutIfWinCents - p.stakeCents;
      else if (result === 'lost') netProfitCents = -p.stakeCents;
      else netProfitCents = 0; // void / push

      try {
        await prisma.valuePick.update({
          where: { id: p.id },
          data: {
            status: result === 'void' ? 'void' : 'settled',
            result,
            finalScore,
            finalDetail,
            netProfitCents,
            settledAt: new Date(),
          },
        });
        summary.settled++;
        if (result === 'won') summary.won++;
        else if (result === 'lost') summary.lost++;
        else summary.void++;
      } catch (e: any) {
        console.error('[ValueTracker] settle update error', p.id, e?.message);
        summary.unresolved++;
      }
    }
  }

  return summary;
}

// ─────────────────────────── stats + listing ───────────────────────────

export interface GroupStat {
  key: string;
  settled: number;
  won: number;
  winRate: number | null;
  stakedCents: number;
  netProfitCents: number;
  roi: number | null;
}

export interface ValueStats {
  open: number;
  settled: number;
  won: number;
  lost: number;
  voided: number;
  winRate: number | null;
  stakedCents: number;
  netProfitCents: number;
  roi: number | null;
  brier: number | null;
  meanModelProb: number | null;
  openStakeCents: number;
  expectedEvCents: number; // sum of evPerDollar*stake over open picks
  byMarket: GroupStat[];
  byModel: GroupStat[];
}

export async function getValueStats(): Promise<ValueStats> {
  const rows = await prisma.valuePick.findMany({
    select: {
      market: true, model: true, status: true, result: true,
      stakeCents: true, netProfitCents: true, modelProb: true, evPerDollar: true,
    },
  });

  let open = 0, settled = 0, won = 0, lost = 0, voided = 0;
  let stakedCents = 0, netProfitCents = 0, openStakeCents = 0, expectedEvCents = 0;
  let bSum = 0, bN = 0, probSum = 0;

  const mkGroup = () => new Map<string, { settled: number; won: number; stakedCents: number; netProfitCents: number }>();
  const byMarket = mkGroup();
  const byModel = mkGroup();
  const bump = (map: ReturnType<typeof mkGroup>, key: string, w: boolean, stake: number, net: number) => {
    const g = map.get(key) ?? { settled: 0, won: 0, stakedCents: 0, netProfitCents: 0 };
    g.settled++; if (w) g.won++; g.stakedCents += stake; g.netProfitCents += net;
    map.set(key, g);
  };

  for (const r of rows) {
    if (r.status === 'open') {
      open++;
      openStakeCents += r.stakeCents ?? 0;
      expectedEvCents += (r.evPerDollar ?? 0) * (r.stakeCents ?? 0);
      continue;
    }
    if (r.status === 'void' || r.result === 'void') {
      voided++;
      continue; // pushes don't count toward win rate / staked ROI
    }
    settled++;
    stakedCents += r.stakeCents ?? 0;
    netProfitCents += r.netProfitCents ?? 0;
    const w = r.result === 'won';
    if (w) won++; else lost++;
    if (typeof r.modelProb === 'number') {
      bSum += Math.pow(r.modelProb - (w ? 1 : 0), 2);
      bN++;
      probSum += r.modelProb;
    }
    bump(byMarket, r.market, w, r.stakeCents ?? 0, r.netProfitCents ?? 0);
    bump(byModel, r.model, w, r.stakeCents ?? 0, r.netProfitCents ?? 0);
  }

  const groupOut = (map: ReturnType<typeof mkGroup>): GroupStat[] =>
    Array.from(map.entries())
      .map(([key, g]) => ({
        key,
        settled: g.settled,
        won: g.won,
        winRate: g.settled > 0 ? g.won / g.settled : null,
        stakedCents: g.stakedCents,
        netProfitCents: g.netProfitCents,
        roi: g.stakedCents > 0 ? g.netProfitCents / g.stakedCents : null,
      }))
      .sort((a, b) => b.settled - a.settled);

  return {
    open, settled, won, lost, voided,
    winRate: settled > 0 ? won / settled : null,
    stakedCents, netProfitCents,
    roi: stakedCents > 0 ? netProfitCents / stakedCents : null,
    brier: bN > 0 ? bSum / bN : null,
    meanModelProb: bN > 0 ? probSum / bN : null,
    openStakeCents,
    expectedEvCents,
    byMarket: groupOut(byMarket),
    byModel: groupOut(byModel),
  };
}

export interface ListFilter {
  status?: string; // open | settled | void
  market?: string;
  model?: string;
  limit?: number;
}

export async function listValuePicks(filter: ListFilter = {}) {
  const where: any = {};
  if (filter.status) where.status = filter.status;
  if (filter.market) where.market = filter.market;
  if (filter.model) where.model = filter.model;
  const rows = await prisma.valuePick.findMany({
    where,
    orderBy: [{ status: 'asc' }, { matchDate: 'desc' }, { evPerDollar: 'desc' }],
    take: Math.max(1, Math.min(1000, filter.limit ?? 500)),
  });
  return rows;
}

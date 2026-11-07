/**
 * Calibration feedback loop.
 *
 * Analyzes SETTLED bet outcomes (correct-score + Polymarket correct-score +
 * goals baskets) and derives corrections that are fed back into the research
 * models over time:
 *   - xgBias           additive correction to expected total goals
 *   - confidenceScale  multiplier that shrinks (or expands) the model's edge
 *   - lowScoringThreshold / hit-rate insight for the low-scoring gate
 *   - brierScore       where model probabilities are stored (goals bets)
 *
 * The result is persisted to the ModelCalibration table (one active row per
 * scope) and read back by the research modules at runtime via
 * getActiveCalibration(), which caches in-memory to respect DB connection limits.
 */
import { prisma } from './db';

export interface CalibrationParams {
  id: string;
  scope: string;
  sampleSize: number;
  scoredSample: number;
  wonCount: number;
  lostCount: number;
  winRate: number; // 0..1
  impliedWinRate: number; // 0..1
  avgActualGoals: number;
  avgCoveredGoals: number;
  xgBias: number; // goals (actual - covered), clamped
  lowScoringThreshold: number;
  lowScoringHitRate: number; // 0..1
  confidenceScale: number; // multiplier on edge
  brierScore: number | null;
  probSlope: number | null; // reliability-curve slope fitted on settled model probabilities
  probIntercept: number | null; // reliability-curve intercept
  probSample: number; // number of settled bets behind the reliability fit
  computedAt: Date;
}

// Minimum settled bets with a model probability before the fitted reliability
// curve is trusted enough to reshape live probabilities.
export const MIN_SAMPLE_FOR_PROB_CALIBRATION = 60;

/** Parse a total-goals count from any of the final-score string formats we store. */
export function parseTotalGoals(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = String(s).match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (!isFinite(a) || !isFinite(b)) return null;
  return a + b;
}

/** Parse the covered scoreline totals from a basket's scorelines JSON. */
function parseCoveredGoals(scorelinesJson: string | null | undefined): number[] {
  if (!scorelinesJson) return [];
  try {
    const legs = JSON.parse(scorelinesJson);
    if (!Array.isArray(legs)) return [];
    const out: number[] = [];
    for (const l of legs) {
      const g = parseTotalGoals(l?.label);
      if (g != null) out.push(g);
    }
    return out;
  } catch {
    return [];
  }
}

const LOW_SCORING_THRESHOLD = 2; // total goals <= 2 counts as "low-scoring"
// Clamp corrections so a noisy or thin sample cannot destabilize the model.
const MAX_ABS_XG_BIAS = 0.75;
const MIN_CONF_SCALE = 0.6;
const MAX_CONF_SCALE = 1.15;
const MIN_PROB_SLOPE = 0.35;
const MAX_PROB_SLOPE = 1.25;
const MIN_SAMPLE_FOR_CORRECTION = 25; // below this, corrections are damped toward neutral

interface SettledRow {
  finalScore: string | null;
  scorelines: string | null;
  combinedCost: number;
  settledResult: string | null;
  source: string;
}

/**
 * Recompute calibration from all settled baskets for a user and persist a new
 * active ModelCalibration row (deactivating the prior one). Returns the params.
 */
export async function computeAndStoreCalibration(userId: string, scope = 'global'): Promise<CalibrationParams> {
  // The calibration is a property of the shared MODEL, so it learns from the
  // full settled-basket history across the app (not just the triggering user).
  // The userId is recorded on the row only for an audit trail of who recomputed.
  const [cs, pm, goals] = await Promise.all([
    prisma.correctScoreBetOrder.findMany({
      where: { settledResult: { in: ['won', 'lost'] } },
      select: { finalScore: true, scorelines: true, combinedCost: true, settledResult: true },
    }),
    prisma.polymarketBetOrder.findMany({
      where: { settledResult: { in: ['won', 'lost'] } },
      select: { finalScore: true, scorelines: true, combinedCost: true, settledResult: true },
    }),
    // Goals baskets (BTTS / totals) carry a per-bet model probability and a
    // single-leg entry price, so they feed the win-rate, implied break-even and
    // Brier score — but NOT xgBias (they have no covered-scoreline structure).
    prisma.goalsBetOrder.findMany({
      where: { settledResult: { in: ['won', 'lost'] } },
      select: { settledResult: true, modelProb: true, entryPrice: true },
    }),
  ]);

  const rows: SettledRow[] = [
    ...cs.map((r) => ({ ...r, source: 'kalshi' })),
    ...pm.map((r) => ({ ...r, source: 'polymarket' })),
  ];

  let won = 0;
  let lost = 0;
  let actualGoalsSum = 0;
  let scoredSample = 0;
  let lowScoringHits = 0;
  let coveredSum = 0;
  let coveredN = 0;
  let impliedSum = 0;
  let impliedN = 0;

  for (const r of rows) {
    if (r.settledResult === 'won') won++;
    else if (r.settledResult === 'lost') lost++;

    if (r.combinedCost > 0) {
      // A basket costing X cents/unit needs P(win) >= X/100 to break even.
      impliedSum += Math.min(1, r.combinedCost / 100);
      impliedN++;
    }

    const g = parseTotalGoals(r.finalScore);
    if (g != null) {
      scoredSample++;
      actualGoalsSum += g;
      if (g <= LOW_SCORING_THRESHOLD) lowScoringHits++;
    }

    for (const cg of parseCoveredGoals(r.scorelines)) {
      coveredSum += cg;
      coveredN++;
    }
  }

  // Fold in settled goals baskets: outcomes count toward the overall win rate
  // and break-even, and (where a model probability was recorded) the Brier score.
  let brierSum = 0;
  let brierN = 0;
  // Least-squares accumulators for the reliability (probability) curve.
  let fitSx = 0;
  let fitSy = 0;
  let fitSxx = 0;
  let fitSxy = 0;
  let fitN = 0;
  for (const gr of goals) {
    if (gr.settledResult === 'won') won++;
    else if (gr.settledResult === 'lost') lost++;

    if (typeof gr.entryPrice === 'number' && gr.entryPrice > 0) {
      // A single-leg contract costing X cents needs P(win) >= X/100 to break even.
      impliedSum += Math.min(1, gr.entryPrice / 100);
      impliedN++;
    }

    if (typeof gr.modelProb === 'number' && isFinite(gr.modelProb)) {
      const outcome = gr.settledResult === 'won' ? 1 : 0;
      const diff = gr.modelProb - outcome;
      brierSum += diff * diff;
      brierN++;
      // Accumulate the least-squares reliability fit (outcome regressed on the
      // model's stated probability). A slope < 1 or a negative intercept means
      // the model's confidence runs ahead of its realized hit rate.
      fitSx += gr.modelProb;
      fitSy += outcome;
      fitSxx += gr.modelProb * gr.modelProb;
      fitSxy += gr.modelProb * outcome;
      fitN++;
    }
  }
  const brierScore = brierN > 0 ? Math.round((brierSum / brierN) * 10000) / 10000 : null;

  // ── Reliability curve: outcome ≈ intercept + slope × statedProbability ──
  let probSlope: number | null = null;
  let probIntercept: number | null = null;
  if (fitN >= MIN_SAMPLE_FOR_PROB_CALIBRATION) {
    const meanX = fitSx / fitN;
    const meanY = fitSy / fitN;
    const varX = fitSxx - fitN * meanX * meanX;
    if (varX > 1e-9) {
      const rawSlope = (fitSxy - fitN * meanX * meanY) / varX;
      // Clamp so a noisy sample can never invert or wildly amplify the mapping.
      const s = clamp(rawSlope, MIN_PROB_SLOPE, MAX_PROB_SLOPE);
      probSlope = Math.round(s * 10000) / 10000;
      probIntercept = Math.round((meanY - s * meanX) * 10000) / 10000;
    }
  }

  const sampleSize = won + lost;
  const winRate = sampleSize > 0 ? won / sampleSize : 0;
  const impliedWinRate = impliedN > 0 ? impliedSum / impliedN : 0;
  const avgActualGoals = scoredSample > 0 ? actualGoalsSum / scoredSample : 0;
  const avgCoveredGoals = coveredN > 0 ? coveredSum / coveredN : 0;
  const lowScoringHitRate = scoredSample > 0 ? lowScoringHits / scoredSample : 0;

  // Damp corrections when the sample is thin (linear ramp to full strength).
  const strength = Math.max(0, Math.min(1, sampleSize / (MIN_SAMPLE_FOR_CORRECTION * 2)));

  // xG bias: how far actual goals ran above/below the covered scorelines' center.
  let xgBias = 0;
  if (scoredSample > 0 && coveredN > 0) {
    const raw = avgActualGoals - avgCoveredGoals;
    xgBias = clamp(raw * strength, -MAX_ABS_XG_BIAS, MAX_ABS_XG_BIAS);
    xgBias = Math.round(xgBias * 100) / 100;
  }

  // Confidence scale: if realized win rate lags the implied breakeven, the model
  // is overstating its edge, so shrink it; if it beats breakeven, allow a mild boost.
  let confidenceScale = 1;
  if (impliedWinRate > 0 && sampleSize >= 5) {
    const raw = winRate / impliedWinRate; // <1 overconfident, >1 underconfident
    const damped = 1 + (raw - 1) * strength;
    confidenceScale = Math.round(clamp(damped, MIN_CONF_SCALE, MAX_CONF_SCALE) * 100) / 100;
  }

  const notes = JSON.stringify({
    bySource: {
      kalshi: cs.length,
      polymarket: pm.length,
      goals: goals.length,
    },
    brierSample: brierN,
    probFit: probSlope != null ? { slope: probSlope, intercept: probIntercept, n: fitN } : null,
    rawXgBias: coveredN > 0 && scoredSample > 0 ? Math.round((avgActualGoals - avgCoveredGoals) * 1000) / 1000 : null,
    strength: Math.round(strength * 100) / 100,
    unscored: sampleSize - scoredSample,
  });

  // Deactivate previous active rows for this scope, then insert the new one.
  await prisma.modelCalibration.updateMany({
    where: { scope, isActive: true },
    data: { isActive: false },
  });

  const created = await prisma.modelCalibration.create({
    data: {
      userId,
      scope,
      sampleSize,
      scoredSample,
      wonCount: won,
      lostCount: lost,
      winRate,
      impliedWinRate,
      avgActualGoals,
      avgCoveredGoals,
      xgBias,
      lowScoringThreshold: LOW_SCORING_THRESHOLD,
      lowScoringHitRate,
      confidenceScale,
      brierScore, // mean squared error of goals-basket model probabilities vs outcomes
      probSlope,
      probIntercept,
      probSample: fitN,
      isActive: true,
      notes,
    },
  });

  // Invalidate the in-memory cache so the new calibration takes effect immediately.
  cacheClear();

  return toParams(created);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function toParams(row: any): CalibrationParams {
  return {
    id: row.id,
    scope: row.scope,
    sampleSize: row.sampleSize,
    scoredSample: row.scoredSample,
    wonCount: row.wonCount,
    lostCount: row.lostCount,
    winRate: row.winRate,
    impliedWinRate: row.impliedWinRate,
    avgActualGoals: row.avgActualGoals,
    avgCoveredGoals: row.avgCoveredGoals,
    xgBias: row.xgBias,
    lowScoringThreshold: row.lowScoringThreshold,
    lowScoringHitRate: row.lowScoringHitRate,
    confidenceScale: row.confidenceScale,
    brierScore: row.brierScore ?? null,
    probSlope: row.probSlope ?? null,
    probIntercept: row.probIntercept ?? null,
    probSample: row.probSample ?? 0,
    computedAt: row.computedAt,
  };
}

// ── In-memory cache for runtime reads by the research modules ────────────────
let _cache: { at: number; value: CalibrationParams | null } | null = null;
const CAL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheClear() {
  _cache = null;
}

/**
 * Read the latest ACTIVE calibration for a scope (cached). Returns null when no
 * calibration has been computed yet — callers must treat null as "no correction".
 */
export async function getActiveCalibration(scope = 'global'): Promise<CalibrationParams | null> {
  const now = Date.now();
  if (_cache && now - _cache.at < CAL_CACHE_TTL_MS) return _cache.value;
  try {
    const row = await prisma.modelCalibration.findFirst({
      where: { scope, isActive: true },
      orderBy: { computedAt: 'desc' },
    });
    const value = row ? toParams(row) : null;
    _cache = { at: now, value };
    return value;
  } catch {
    return null;
  }
}

/** Get the latest calibration for a scope without touching the runtime cache. */
export async function getLatestCalibration(_userId: string, scope = 'global'): Promise<CalibrationParams | null> {
  try {
    const row = await prisma.modelCalibration.findFirst({
      where: { scope },
      orderBy: { computedAt: 'desc' },
    });
    return row ? toParams(row) : null;
  } catch {
    return null;
  }
}

/**
 * Grounding text summarizing the learned calibration, injected into the LLM
 * xG-estimation prompt so the model is aware of its historical bias.
 */
export function formatCalibrationForPrompt(cal: CalibrationParams | null): string {
  if (!cal || cal.sampleSize < 5) return '';
  const dir = cal.xgBias > 0.05 ? 'UNDER-predicted' : cal.xgBias < -0.05 ? 'OVER-predicted' : 'tracked';
  const parts: string[] = [];
  parts.push(`\n\nHISTORICAL CALIBRATION (learned from ${cal.sampleSize} settled baskets):`);
  if (Math.abs(cal.xgBias) > 0.05) {
    parts.push(`- Past baskets ${dir} total goals; actual games averaged ${cal.avgActualGoals.toFixed(2)} vs a targeted ${cal.avgCoveredGoals.toFixed(2)}. Nudge your expected total goals by ${cal.xgBias > 0 ? '+' : ''}${cal.xgBias.toFixed(2)} accordingly.`);
  }
  parts.push(`- Low-scoring (\u2264${cal.lowScoringThreshold} goals) games occurred ${(cal.lowScoringHitRate * 100).toFixed(0)}% of the time historically.`);
  if (cal.impliedWinRate > 0) {
    parts.push(`- Realized basket win rate ${(cal.winRate * 100).toFixed(0)}% vs ${(cal.impliedWinRate * 100).toFixed(0)}% break-even. ${cal.confidenceScale < 0.98 ? 'Be conservative — the model has been overconfident.' : cal.confidenceScale > 1.02 ? 'The model has slightly underestimated its edge.' : 'The model has been well-calibrated.'}`);
  }
  return parts.join('\n');
}

/**
 * Apply the learned xG bias to a pair of per-team expected goals, preserving
 * the home/away split. Returns the adjusted pair. No-op when cal is null/zero.
 */
export function applyXgBias(
  ega: number,
  egb: number,
  cal: CalibrationParams | null,
): { ega: number; egb: number } {
  if (!cal || !cal.xgBias) return { ega, egb };
  const total = ega + egb;
  if (total <= 0) return { ega, egb };
  const adjTotal = Math.max(0.4, total + cal.xgBias);
  const scale = adjTotal / total;
  return { ega: ega * scale, egb: egb * scale };
}

/**
 * Map a raw model probability through the learned reliability curve.
 *
 * The model has historically been OVERCONFIDENT: settled goals bets show a
 * stated ~66% average win chance against a realized ~57%. Fitting outcome on
 * stated probability gives a slope/intercept pair that pulls stated confidence
 * back onto the realized curve, which is what actually drives edge and EV.
 *
 * Returns the raw probability unchanged when there is no trustworthy fit yet.
 */
export function calibrateProb(p: number, cal: CalibrationParams | null): number {
  if (typeof p !== 'number' || !isFinite(p)) return p;
  if (!cal || cal.probSlope == null || cal.probIntercept == null) return p;
  if (cal.probSample < MIN_SAMPLE_FOR_PROB_CALIBRATION) return p;
  const mapped = cal.probIntercept + cal.probSlope * p;
  if (!isFinite(mapped)) return p;
  return clamp(mapped, 0.02, 0.98);
}

/** True when a usable reliability curve has been fitted. */
export function hasProbCalibration(cal: CalibrationParams | null): boolean {
  return !!cal && cal.probSlope != null && cal.probIntercept != null && cal.probSample >= MIN_SAMPLE_FOR_PROB_CALIBRATION;
}

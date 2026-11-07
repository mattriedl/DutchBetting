/**
 * Goals Markets Research (Phase A)
 *
 * Produces model probabilities for BTTS and Over/Under Total-Goals markets from
 * a Dixon-Coles-corrected Poisson goals model driven by AI-estimated expected
 * goals (xG), blended with the live market-implied prices. Also runs the
 * low-scoring consensus so the analyzer can favour/gate the low-scoring side
 * (the proven +ROI edge from the 440-bet historical analysis).
 *
 * Output feeds analyzeGoals():
 *   - bttsYesProb: P(both teams score)
 *   - overProbByLine: { "2.5": P(total > 2.5), ... }
 *   - expectedTotalGoals, lowScore (0-100)
 */

import type { GoalsMatch } from '@/lib/goals-markets';
import { fetchMatchResearch, formatResearchForPrompt, fetchPredictions, formatPredictionForPrompt, type MatchPrediction } from '@/lib/api-football';
import { getExternalConsensus } from '@/lib/external-predictions';
import { computeLowScoringConsensus, type LowScoringConsensus } from '@/lib/low-scoring-consensus';
import { fetchSharpSignal, type SharpSignal } from '@/lib/odds-api';
import { getActiveCalibration, formatCalibrationForPrompt, applyXgBias, type CalibrationParams } from '@/lib/calibration';

export interface GoalsResearch {
  teamAExpectedGoals: number;
  teamBExpectedGoals: number;
  expectedTotalGoals: number;
  confidence: number;
  analysis: string;
  keyFactors: string[];
  teamAForm?: string;
  teamBForm?: string;
  headToHead?: string;
  bttsYesProb: number;             // model P(both teams score)
  overProbByLine: Record<string, number>; // model P(total > line)
  method: string;
  lowScoring?: LowScoringConsensus;
  sharp?: SharpSignal;             // sharp bookmaker consensus (when available)
  prediction?: MatchPrediction;    // API-Football algorithmic forecast (when available)
}

// ──────── Poisson + Dixon-Coles grid ────────
const GRID_MAX = 10;
const DC_RHO = -0.1;

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}
function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}
function dixonColesTau(x: number, y: number, lambda: number, mu: number, rho = DC_RHO): number {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/** Build a normalized joint score grid and derive BTTS / totals probabilities. */
function goalsModel(la: number, mu: number): {
  bttsYes: number;
  overProb: (line: number) => number;
  expectedTotal: number;
} {
  const grid: number[][] = [];
  let sum = 0;
  for (let x = 0; x <= GRID_MAX; x++) {
    grid[x] = [];
    for (let y = 0; y <= GRID_MAX; y++) {
      const p = Math.max(0, dixonColesTau(x, y, la, mu)) * poissonPmf(la, x) * poissonPmf(mu, y);
      grid[x][y] = p;
      sum += p;
    }
  }
  const norm = sum || 1;

  let bttsYes = 0;
  let expectedTotal = 0;
  for (let x = 0; x <= GRID_MAX; x++) {
    for (let y = 0; y <= GRID_MAX; y++) {
      const p = grid[x][y] / norm;
      if (x >= 1 && y >= 1) bttsYes += p;
      expectedTotal += (x + y) * p;
    }
  }

  const overProb = (line: number): number => {
    // total goals strictly greater than the line (line is x.5, so total >= line+0.5)
    const threshold = Math.ceil(line); // e.g. 2.5 -> need total >= 3
    let over = 0;
    for (let x = 0; x <= GRID_MAX; x++) {
      for (let y = 0; y <= GRID_MAX; y++) {
        if (x + y >= threshold) over += grid[x][y] / norm;
      }
    }
    return over;
  };

  return { bttsYes, overProb, expectedTotal };
}

// ──────── LLM expected-goals estimator ────────
async function fetchExpectedGoals(match: GoalsMatch, sharp?: SharpSignal | null, prediction?: MatchPrediction | null, cal?: CalibrationParams | null, externalConsensus?: string): Promise<{
  ega: number; egb: number; confidence: number; analysis: string; keyFactors: string[];
  teamAForm?: string; teamBForm?: string; headToHead?: string;
} | null> {
  const apiKey = process.env.ABACUSAI_API_KEY;
  if (!apiKey) return null;

  let liveDataBlock = '';
  try {
    // Skip injuries here: they cost 2 extra API calls per team and add little to
    // goals/totals pricing. Keeps the API-Football daily quota for more matches.
    const data = await fetchMatchResearch(match.teamA, match.teamB, { includeInjuries: false });
    if (data) liveDataBlock = formatResearchForPrompt(data, match.teamA, match.teamB);
  } catch (err: any) {
    console.warn('[goals-research] API-Football fetch failed:', err?.message);
  }

  // Market grounding: prediction-market prices + sharp bookmaker consensus.
  const over25 = match.totalLadder.find(t => t.line === 2.5);
  const marketBits: string[] = [];
  if (over25) marketBits.push(`Kalshi Over 2.5 goals ≈ ${(over25.yesAsk)}%`);
  if (match.btts) marketBits.push(`Kalshi BTTS Yes ≈ ${match.btts.yesAsk}%`);
  // Sharp bookmaker consensus (de-vigged multi-book averages from the-odds-api)
  if (sharp?.totals?.length) {
    for (const t of sharp.totals) {
      marketBits.push(`Sharp books Over ${t.line} goals ≈ ${Math.round(t.overProb * 100)}% (${t.booksUsed} books)`);
    }
  }
  if (sharp?.btts) {
    marketBits.push(`Sharp books BTTS Yes ≈ ${Math.round(sharp.btts.yesProb * 100)}% (${sharp.btts.booksUsed} books)`);
  }
  const marketGround = marketBits.length ? `\nLIVE MARKET GROUNDING: ${marketBits.join(', ')}.` : '';

  // Algorithmic forecast grounding (API-Football /predictions).
  const predBlock = prediction ? formatPredictionForPrompt(prediction, match.teamA, match.teamB) : '';
  const predSection = predBlock ? `\n\n${predBlock}\n` : '';

  // Learned calibration grounding (from settled-outcome feedback loop).
  const calSection = formatCalibrationForPrompt(cal ?? null);

  // Third-party prediction sources, annotated with their realized hit rates.
  const extSection = externalConsensus ? `\n\n${externalConsensus}\n` : '';

  const liveSection = liveDataBlock
    ? `\n\nLIVE STATISTICAL DATA (current season, from API-Football — treat as ground truth):\n${liveDataBlock}\n`
    : '\n\nNOTE: No live statistical feed available. If you lack reliable current-season data, SAY SO and lower your confidence rather than inventing results.\n';

  const prompt = `You are a professional soccer analyst pricing GOALS markets (Both Teams To Score, and Over/Under total goals) for a betting desk. Be rigorous and quantitative.

MATCH: ${match.teamA} (home/first) vs ${match.teamB} (away/second)
Competition: ${match.league}
Date: ${match.matchDate || 'upcoming'}${marketGround}${predSection}${calSection}${extSection}${liveSection}
Using the live data above (where available) plus ESTABLISHED STATISTICAL REASONING (never anecdotal social-media chatter), analyse this fixture across:
1. Recent form and goals scored/conceded for each team (last 5-6 matches).
2. Over/Under 2.5 tendencies and BTTS rates for both teams this season.
3. Head-to-head goal totals between these clubs.
4. Squad quality, key injuries/suspensions, defensive solidity.
5. Home advantage, venue and competition context (knockouts are tighter).

From that, estimate the REGULATION-TIME expected goals (xG) for each team.

Respond with RAW JSON ONLY, no markdown:
{
  "teamAExpectedGoals": number,
  "teamBExpectedGoals": number,
  "confidence": number,          // 0..1, higher when live data is available
  "teamAForm": "e.g. W-W-D-L-W or 'data unavailable'",
  "teamBForm": "e.g. L-D-W-W-D or 'data unavailable'",
  "headToHead": "1-2 sentence H2H goals summary",
  "analysis": "3-4 sentence rationale tying factors to the xG and goal expectation",
  "keyFactors": ["factor 1", "factor 2", "factor 3", "factor 4"]
}`;

  try {
    const res = await fetch('https://apps.abacus.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(content);
    const ega = Number(parsed?.teamAExpectedGoals);
    const egb = Number(parsed?.teamBExpectedGoals);
    if (!isFinite(ega) || !isFinite(egb) || ega < 0 || egb < 0) return null;
    return {
      ega: Math.min(ega, 5),
      egb: Math.min(egb, 5),
      confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0.5)),
      analysis: String(parsed?.analysis ?? '').slice(0, 900),
      keyFactors: Array.isArray(parsed?.keyFactors) ? parsed.keyFactors.slice(0, 6).map((x: any) => String(x)) : [],
      teamAForm: parsed?.teamAForm ? String(parsed.teamAForm).slice(0, 40) : undefined,
      teamBForm: parsed?.teamBForm ? String(parsed.teamBForm).slice(0, 40) : undefined,
      headToHead: parsed?.headToHead ? String(parsed.headToHead).slice(0, 300) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Estimate xG from the market when the LLM is unavailable, using the totals
 * ladder to back out expected total goals and the BTTS price to split it.
 */
function marketExpectedGoals(match: GoalsMatch): { ega: number; egb: number } {
  // Expected total goals from the over ladder: E[total] ≈ sum of P(total > k-0.5)
  // over integer thresholds, which equals sum over lines of P(over line).
  let expTotal = 0;
  for (const t of match.totalLadder) {
    expTotal += Math.max(0, Math.min(1, t.yesAsk / 100));
  }
  if (expTotal <= 0) expTotal = 2.5; // sensible default
  // Split evenly with a mild home tilt; BTTS price nudges the split toward balance.
  const homeShare = 0.54;
  return { ega: Math.max(0.2, expTotal * homeShare), egb: Math.max(0.2, expTotal * (1 - homeShare)) };
}

/**
 * Run the goals research pipeline for one match. Returns model probabilities
 * (blended with market) for BTTS and every total line present.
 */
export async function researchGoalsMatch(match: GoalsMatch): Promise<GoalsResearch> {
  // Phase 0: fetch the sharp bookmaker consensus + API-Football algorithmic
  // prediction first (both independent, fast, cached). Then feed them to BOTH
  // the low-scoring consensus and the LLM grounding prompt.
  const [sharpResult, prediction, calibration, externalConsensus] = await Promise.all([
    fetchSharpSignal(match.leagueCode || match.league, match.teamA, match.teamB).catch(() => null),
    fetchPredictions(match.teamA, match.teamB).catch(() => null),
    getActiveCalibration('global').catch(() => null),
    // Tracked third-party predictions for THIS match, weighted by each source's
    // realized accuracy. Empty string when nothing is on file.
    getExternalConsensus(match.teamA, match.teamB, match.matchDate).catch(() => ''),
  ]);

  // Extract the sharp under-2.5 probability (if available) for low-scoring consensus.
  const sharpU25 = sharpResult?.totals?.find(t => t.line === 2.5);

  // Phase 1: low-scoring consensus + LLM xG in parallel.
  const [lowScoringInit, llm] = await Promise.all([
    computeLowScoringConsensus({
      teamA: match.teamA,
      teamB: match.teamB,
      league: match.league,
      sharpUnder25: sharpU25?.underProb,
      sharpBooksUsed: sharpU25?.booksUsed,
    }).catch(() => null),
    fetchExpectedGoals(match, sharpResult, prediction, calibration, externalConsensus),
  ]);

  const hasApiFootball = !!process.env.API_FOOTBALL_KEY;
  const hasSharp = !!sharpResult?.totals?.length;
  const methodParts = ['poisson'];
  if (llm) methodParts.push('llm');
  if (hasApiFootball) methodParts.push('live');
  if (hasSharp) methodParts.push('sharp');
  if (prediction) methodParts.push('af-pred');
  if (calibration && calibration.xgBias) methodParts.push('cal');
  const method = methodParts.join('+');

  // Apply the learned xG-bias correction from the calibration feedback loop
  // (splits the additive goals correction across both teams proportionally).
  const rawGoals = llm ? { ega: llm.ega, egb: llm.egb } : marketExpectedGoals(match);
  const { ega, egb } = applyXgBias(rawGoals.ega, rawGoals.egb, calibration);

  const lowScoring = lowScoringInit;
  const model = goalsModel(ega, egb);

  // ── Three-way blend: Poisson model × prediction-market mid × sharp consensus ──
  // Weights: model gets "w", prediction market gets "pm", sharp gets "sh".
  // If sharp is absent, model+market blend as before. If prediction-market mid is
  // unavailable on a line, model+sharp (or model alone).
  const wModel = llm ? 0.30 + 0.35 * llm.confidence : 0.40;
  const wSharp = hasSharp ? 0.25 : 0;
  const wMarket = 1 - wModel - wSharp; // remainder goes to prediction market mid

  /** Blend up to 3 probability estimates, skipping any that are unavailable. */
  const blend3 = (poisson: number, pmMid?: number, sharpProb?: number): number => {
    let sum = wModel * poisson;
    let wTotal = wModel;
    if (typeof pmMid === 'number' && isFinite(pmMid)) {
      sum += wMarket * pmMid;
      wTotal += wMarket;
    }
    if (typeof sharpProb === 'number' && isFinite(sharpProb)) {
      sum += wSharp * sharpProb;
      wTotal += wSharp;
    }
    return sum / (wTotal || 1);
  };

  // Build a lookup of sharp totals by line for O(1) access.
  const sharpByLine = new Map<number, number>();
  if (sharpResult?.totals) {
    for (const st of sharpResult.totals) sharpByLine.set(st.line, st.overProb);
  }

  // BTTS blended (3-way when sharp BTTS available).
  const bttsMarketYes = match.btts ? (match.btts.yesAsk + match.btts.yesBid) / 2 / 100 : undefined;
  const sharpBttsYes = sharpResult?.btts?.yesProb;
  const bttsYesProb = Math.max(0.01, Math.min(0.99, blend3(model.bttsYes, bttsMarketYes, sharpBttsYes)));

  // Over probability per line, blended with the market mid and the sharp consensus.
  const overProbByLine: Record<string, number> = {};
  for (const t of match.totalLadder) {
    const pmMid = (t.yesAsk + t.yesBid) / 2 / 100;
    // Sharp lines may differ from Kalshi lines (e.g. 3.0 vs 2.5). When an exact
    // match exists use it; otherwise interpolate from the two nearest sharp lines.
    let sharpOver: number | undefined;
    if (sharpByLine.has(t.line)) {
      sharpOver = sharpByLine.get(t.line);
    } else if (sharpResult?.totals?.length) {
      // Linear interpolation between nearest sharp lines.
      const sorted = sharpResult.totals.slice().sort((a, b) => a.line - b.line);
      const below = sorted.filter(s => s.line < t.line).pop();
      const above = sorted.find(s => s.line > t.line);
      if (below && above) {
        const frac = (t.line - below.line) / (above.line - below.line);
        sharpOver = below.overProb + frac * (above.overProb - below.overProb);
      } else if (below) {
        sharpOver = below.overProb;
      } else if (above) {
        sharpOver = above.overProb;
      }
    }
    const p = Math.max(0.01, Math.min(0.99, blend3(model.overProb(t.line), pmMid, sharpOver)));
    overProbByLine[String(t.line)] = p;
  }

  const expectedTotalGoals = Math.round((ega + egb) * 100) / 100;

  return {
    teamAExpectedGoals: Math.round(ega * 100) / 100,
    teamBExpectedGoals: Math.round(egb * 100) / 100,
    expectedTotalGoals,
    confidence: llm?.confidence ?? 0.4,
    analysis: llm?.analysis ?? `Model derived from live market prices: ${match.teamA} expected ${ega.toFixed(2)} goals, ${match.teamB} expected ${egb.toFixed(2)} (Dixon-Coles Poisson).`,
    keyFactors: llm?.keyFactors ?? ['Derived from Kalshi market-implied goals distribution'],
    teamAForm: llm?.teamAForm,
    teamBForm: llm?.teamBForm,
    headToHead: llm?.headToHead,
    bttsYesProb,
    overProbByLine,
    method,
    lowScoring: lowScoring ?? undefined,
    sharp: sharpResult ?? undefined,
    prediction: prediction ?? undefined,
  };
}

/**
 * Score Research Library
 *
 * Produces data-driven probabilities for each soccer scoreline using:
 *  1. A Poisson goals model (the quantitative backbone used by professional
 *     soccer modellers) driven by each team's expected goals (xG).
 *  2. An LLM analyst that estimates expected goals from reputable-style
 *     full-game analysis (team form, attack/defense strength, head-to-head,
 *     injuries, home/venue). It is instructed to rely on statistical reasoning
 *     and established analysis, never anecdotal forum/social chatter.
 *  3. A blend with the market-implied distribution so the model is anchored to
 *     live prices and never wildly overconfident.
 *
 * The output sets `modelProb` on each available scoreline so the basket
 * optimizer can rank picks by true probability instead of raw market price.
 */

import type { CorrectScoreMatch, Scoreline } from '@/lib/correct-score';
import { fetchMatchResearch, formatResearchForPrompt, fetchPredictions, formatPredictionForPrompt, type MatchPrediction } from '@/lib/api-football';
import { computeLowScoringConsensus, type LowScoringConsensus } from '@/lib/low-scoring-consensus';
import { fetchSharpSignal, type SharpSignal } from '@/lib/odds-api';
import { getActiveCalibration, formatCalibrationForPrompt, applyXgBias, type CalibrationParams } from '@/lib/calibration';
import { getExternalConsensus } from '@/lib/external-predictions';

export interface ScoreResearch {
  teamAExpectedGoals: number;
  teamBExpectedGoals: number;
  confidence: number;          // 0-1 model confidence
  analysis: string;            // narrative rationale
  keyFactors: string[];        // bullet factors
  teamAForm?: string;          // e.g. "W-W-D-L-W"
  teamBForm?: string;
  headToHead?: string;         // short H2H summary
  expertConsensus?: string;    // widely-reported expert / consensus call
  likelyScores: { label: string; prob: number }[]; // top model scorelines (available ones)
  method: string;              // 'poisson+llm' | 'poisson+market'
  lowScoring?: LowScoringConsensus;  // low-scoring consensus analysis
  sharp?: SharpSignal;          // sharp bookmaker consensus
  prediction?: MatchPrediction;  // API-Football algorithmic forecast
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

// Dixon-Coles low-score dependence correction. Independent Poisson misprices
// the four most common low scores (0-0, 1-0, 0-1, 1-1) because goals are not
// truly independent; this tau adjustment is the standard, empirically-validated
// fix used in professional soccer correct-score models (Dixon & Coles, 1997).
const DC_RHO = -0.1;
function dixonColesTau(x: number, y: number, lambda: number, mu: number, rho = DC_RHO): number {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}
function scoreProb(lambda: number, mu: number, x: number, y: number): number {
  return Math.max(0, dixonColesTau(x, y, lambda, mu)) * poissonPmf(lambda, x) * poissonPmf(mu, y);
}

/**
 * Ask the LLM analyst for expected goals + a reputable-style rationale.
 * Returns null on any failure so the caller can fall back to a market model.
 */
async function fetchExpectedGoals(
  match: CorrectScoreMatch
): Promise<{ ega: number; egb: number; confidence: number; analysis: string; keyFactors: string[]; teamAForm?: string; teamBForm?: string; headToHead?: string; expertConsensus?: string } | null> {
  const apiKey = process.env.ABACUSAI_API_KEY;
  if (!apiKey) return null;

  // ── Fetch live stats from API-Football (non-blocking) ──
  let liveDataBlock = '';
  let apiFootballData: Awaited<ReturnType<typeof fetchMatchResearch>> = null;
  try {
    apiFootballData = await fetchMatchResearch(match.teamA, match.teamB);
    if (apiFootballData) {
      liveDataBlock = formatResearchForPrompt(apiFootballData, match.teamA, match.teamB);
    }
  } catch (err: any) {
    console.warn('[score-research] API-Football fetch failed, continuing without:', err?.message);
  }

  // Give the model the current market-implied outcome split for grounding.
  const totalAsk = match.scorelines.reduce((s, x) => s + x.ask, 0) || 1;
  const pWin = match.scorelines.filter(s => s.outcome === 'teamA').reduce((s, x) => s + x.ask, 0) / totalAsk;
  const pDraw = match.scorelines.filter(s => s.outcome === 'draw').reduce((s, x) => s + x.ask, 0) / totalAsk;
  const pLose = match.scorelines.filter(s => s.outcome === 'teamB').reduce((s, x) => s + x.ask, 0) / totalAsk;

  // Sharp bookmaker consensus grounding (passed in via researchMatch).
  const sharpBits: string[] = [];
  if ((match as any)._sharp?.totals?.length) {
    for (const t of (match as any)._sharp.totals) {
      sharpBits.push(`Sharp books Over ${t.line} goals ≈ ${Math.round(t.overProb * 100)}% (${t.booksUsed} books)`);
    }
  }
  if ((match as any)._sharp?.btts) {
    const b = (match as any)._sharp.btts;
    sharpBits.push(`Sharp books BTTS Yes ≈ ${Math.round(b.yesProb * 100)}% (${b.booksUsed} books)`);
  }
  const sharpLine = sharpBits.length ? ` | ${sharpBits.join(', ')}` : '';

  // Algorithmic forecast grounding (API-Football /predictions, passed via researchMatch).
  const predBlock = (match as any)._prediction
    ? formatPredictionForPrompt((match as any)._prediction as MatchPrediction, match.teamA, match.teamB)
    : '';
  const predSection = predBlock ? `\n\n${predBlock}\n` : '';

  // Learned calibration grounding (from the settled-outcome feedback loop).
  const calSection = formatCalibrationForPrompt(((match as any)._cal as CalibrationParams | null) ?? null);
  const extBlock = ((match as any)._extConsensus as string | undefined) || '';
  const extSection = extBlock ? `\n\n${extBlock}` : '';

  const liveSection = liveDataBlock
    ? `\n\nLIVE STATISTICAL DATA (current season, from API-Football — treat as ground truth for form, results, and injuries):\n${liveDataBlock}\n`
    : '\n\nNOTE: No live statistical feed available for these teams. If you do not have reliable current-season data for a factor (e.g. exact recent form for a minor league), SAY SO explicitly and lower your confidence rather than inventing results.\n';

  const prompt = `You are a professional soccer analyst building a correct-score model for a betting desk. Be rigorous and quantitative.

MATCH: ${match.teamA} (home/first) vs ${match.teamB} (away/second)
Competition: ${match.league}
Date: ${match.matchDate || 'upcoming'}

LIVE MARKET GROUNDING (regulation time): ${match.teamA} win ${(pWin * 100).toFixed(0)}%, Draw ${(pDraw * 100).toFixed(0)}%, ${match.teamB} win ${(pLose * 100).toFixed(0)}%${sharpLine}.${predSection}${calSection}${extSection}${liveSection}
Using the live data above (where available) plus ESTABLISHED STATISTICAL REASONING (never anecdotal social-media/forum chatter), analyse this specific fixture across:
1. Recent form and results for each team (last 5-6 matches).
2. Goals-scored / goals-conceded patterns and over/under 2.5 tendencies.
3. Head-to-head history between these two clubs.
4. Squad quality, key injuries/suspensions, and rotation risk.
5. Home advantage and venue effects.
6. Any widely-reported expert or consensus correct-score / result call.
7. LOW-SCORING LIKELIHOOD: explicitly assess whether this match is likely to be low-scoring (under 2.5 goals). Consider defensive styles, low-scoring recent form, tournament context (e.g. knockout stages are typically tighter), and historical under 2.5 rates for both teams.

From that analysis, estimate the REGULATION-TIME expected goals (xG) for each team.

Respond with RAW JSON ONLY, no markdown:
{
  "teamAExpectedGoals": number,   // e.g. 1.6
  "teamBExpectedGoals": number,   // e.g. 1.1
  "confidence": number,           // 0..1, higher when live data is available
  "teamAForm": "last results e.g. W-W-D-L-W, or 'data unavailable'",
  "teamBForm": "last results e.g. L-D-W-W-D, or 'data unavailable'",
  "headToHead": "1-2 sentence H2H summary",
  "expertConsensus": "most-likely scoreline(s) per consensus, or 'no strong public consensus'",
  "lowScoringAssessment": "1-2 sentence assessment of under 2.5 goals likelihood with supporting data",
  "analysis": "3-4 sentence rationale tying the factors to the xG estimate",
  "keyFactors": ["factor 1", "factor 2", "factor 3", "factor 4"]
}`;

  try {
    const res = await fetch('https://apps.abacus.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1100,
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
      expertConsensus: parsed?.expertConsensus ? String(parsed.expertConsensus).slice(0, 200) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Estimate expected goals directly from the market when the LLM is unavailable.
 * Uses the market-implied average total goals across priced scorelines and the
 * win/lose skew to split it between the two teams.
 */
function marketExpectedGoals(match: CorrectScoreMatch): { ega: number; egb: number } {
  const totalAsk = match.scorelines.reduce((s, x) => s + x.ask, 0) || 1;
  let expA = 0;
  let expB = 0;
  for (const s of match.scorelines) {
    const p = s.ask / totalAsk;
    expA += p * s.teamAScore;
    expB += p * s.teamBScore;
  }
  return { ega: Math.max(0.2, expA), egb: Math.max(0.2, expB) };
}

/**
 * Run the full research pipeline for one match and attach modelProb to each
 * available scoreline. Returns both the enriched match and the research summary.
 */
export async function researchMatch(
  match: CorrectScoreMatch
): Promise<{ match: CorrectScoreMatch; research: ScoreResearch }> {
  // Phase 0: sharp bookmaker consensus + API-Football algorithmic prediction
  // (both fast, cached). Attached to match for LLM grounding.
  const [sharp, prediction, calibration, extConsensus] = await Promise.all([
    fetchSharpSignal(match.league, match.teamA, match.teamB).catch(() => null),
    fetchPredictions(match.teamA, match.teamB).catch(() => null),
    getActiveCalibration('global').catch(() => null),
    getExternalConsensus(match.teamA, match.teamB, match.matchDate).catch(() => ''),
  ]);

  // Attach to match for LLM grounding (accessed via (match as any)._sharp / _prediction / _cal).
  (match as any)._sharp = sharp;
  (match as any)._prediction = prediction;
  (match as any)._cal = calibration;
  (match as any)._extConsensus = extConsensus;

  const sharpU25 = sharp?.totals?.find(t => t.line === 2.5);

  // Phase 1: LLM xG + low-scoring consensus (with sharp under-2.5 piped in) in parallel.
  const [llm, lowScoring] = await Promise.all([
    fetchExpectedGoals(match),
    computeLowScoringConsensus({
      teamA: match.teamA,
      teamB: match.teamB,
      league: match.league,
      sharpUnder25: sharpU25?.underProb,
      sharpBooksUsed: sharpU25?.booksUsed,
    }).catch(() => null),
  ]);

  const hasApiFootball = !!process.env.API_FOOTBALL_KEY;
  const hasSharp = !!sharp?.totals?.length;
  const methodParts = ['poisson'];
  if (llm) methodParts.push('llm');
  if (hasApiFootball) methodParts.push('live');
  if (hasSharp) methodParts.push('sharp');
  if (prediction) methodParts.push('af-pred');
  if (calibration && calibration.xgBias) methodParts.push('cal');
  const method = methodParts.join('+');
  const rawGoals = llm ? { ega: llm.ega, egb: llm.egb } : marketExpectedGoals(match);
  const { ega, egb } = applyXgBias(rawGoals.ega, rawGoals.egb, calibration);

  const lowScoringFinal = lowScoring;

  // Dixon-Coles-corrected Poisson probability for each available scoreline.
  const rawPoisson: number[] = match.scorelines.map(s =>
    scoreProb(ega, egb, s.teamAScore, s.teamBScore)
  );
  const poissonSum = rawPoisson.reduce((a, b) => a + b, 0) || 1;

  // Market-implied (vig-removed) probability for each available scoreline.
  const totalAsk = match.scorelines.reduce((s, x) => s + x.ask, 0) || 1;

  // Blend: lean on Poisson but anchor to market. Weight Poisson by confidence.
  const w = llm ? 0.35 + 0.4 * llm.confidence : 0.4; // 0.35..0.75 with LLM, 0.4 otherwise
  const enriched: Scoreline[] = match.scorelines.map((s, i) => {
    const pPoisson = rawPoisson[i] / poissonSum;
    const pMarket = s.ask / totalAsk;
    const modelProb = w * pPoisson + (1 - w) * pMarket;
    return { ...s, modelProb };
  });

  // Renormalize model probs over available scorelines.
  const modelSum = enriched.reduce((a, b) => a + (b.modelProb ?? 0), 0) || 1;
  for (const s of enriched) s.modelProb = (s.modelProb ?? 0) / modelSum;

  const likelyScores = [...enriched]
    .sort((a, b) => (b.modelProb ?? 0) - (a.modelProb ?? 0))
    .slice(0, 6)
    .map(s => ({ label: s.label, prob: Math.round((s.modelProb ?? 0) * 1000) / 1000 }));

  const research: ScoreResearch = {
    teamAExpectedGoals: Math.round(ega * 100) / 100,
    teamBExpectedGoals: Math.round(egb * 100) / 100,
    confidence: llm?.confidence ?? 0.4,
    analysis: llm?.analysis ?? `Model derived from live market prices: ${match.teamA} expected ${ega.toFixed(2)} goals, ${match.teamB} expected ${egb.toFixed(2)} goals (Dixon-Coles Poisson).`,
    keyFactors: llm?.keyFactors ?? ['Derived from Kalshi market-implied scoreline distribution'],
    teamAForm: llm?.teamAForm,
    teamBForm: llm?.teamBForm,
    headToHead: llm?.headToHead,
    expertConsensus: llm?.expertConsensus,
    likelyScores,
    method,
    lowScoring: lowScoringFinal ?? undefined,
    sharp: sharp ?? undefined,
    prediction: prediction ?? undefined,
  };

  return { match: { ...match, scorelines: enriched }, research };
}

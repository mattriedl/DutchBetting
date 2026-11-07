'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { FadeIn, Stagger, StaggerItem } from '@/components/animations';
import { CalibrationPanel } from '@/components/calibration-panel';
import {
  Percent,
  Loader2,
  RefreshCw,
  DollarSign,
  TrendingUp,
  TrendingDown,
  Target,
  ShieldCheck,
  Shield,
  CheckCircle2,
  XCircle,
  Sparkles,
  BarChart3,
  Settings as SettingsIcon,
  Sliders,
  Clock,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react';

// ─────────────── types (mirror lib/goals-markets.ts) ───────────────
interface GoalsPick {
  marketType: 'total' | 'btts';
  line?: number;
  side: 'under' | 'over' | 'btts_no' | 'btts_yes';
  label: string;
  isLowScoring: boolean;
  marketTicker: string;
  seriesTicker: string;
  eventTicker: string;
  cost: number;
  bid: number;
  impliedProb: number;
  modelProb?: number;
  edge?: number;
}

interface BttsMarket { ticker: string; yesAsk: number; yesBid: number; last: number; }
interface TotalLine { ticker: string; line: number; yesAsk: number; yesBid: number; last: number; }

interface GoalsMatch {
  matchKey: string;
  source?: 'kalshi' | 'polymarket';
  league: string;
  leagueCode: string;
  teamA: string;
  teamB: string;
  matchTitle: string;
  matchDate: string;
  expirationTime: string;
  bttsEventTicker?: string;
  bttsSeriesTicker?: string;
  btts?: BttsMarket;
  totalEventTicker?: string;
  totalSeriesTicker?: string;
  totalLadder: TotalLine[];
}

interface GoalsAnalysis {
  match: GoalsMatch;
  picks: GoalsPick[];
  recommended: GoalsPick | null;
  bestEdge: number;
  bestOverall: GoalsPick | null;
  edgeThreshold: number;
  lowScore?: number;
  expectedTotalGoals?: number;
  gateReason: string | null;
  rating: 'excellent' | 'good' | 'marginal' | 'none';
  researched: boolean;
}

interface LowScoring {
  score: number;
  rating: string;
  expectedTotalGoals: number;
  under25Probability: number;
  signals: { source: string; label: string; value: number; weight: number }[];
  summary: string;
  dataAvailable: boolean;
}

interface SharpTotals { line: number; overProb: number; underProb: number; booksUsed: number; }
interface SharpBtts { yesProb: number; noProb: number; booksUsed: number; }
interface SharpSignal { totals: SharpTotals[]; btts?: SharpBtts; sport: string; }

interface GoalsResearch {
  teamAExpectedGoals: number;
  teamBExpectedGoals: number;
  expectedTotalGoals: number;
  confidence: number;
  analysis: string;
  keyFactors: string[];
  teamAForm?: string;
  teamBForm?: string;
  headToHead?: string;
  bttsYesProb: number;
  overProbByLine: Record<string, number>;
  method: string;
  lowScoring?: LowScoring;
  sharp?: SharpSignal;
}

interface GoalsOrder {
  id: string;
  league: string;
  marketType: string;
  line: number | null;
  eventTicker: string;
  marketTicker: string;
  matchTitle: string;
  teamA: string;
  teamB: string;
  matchDate: string;
  side: string;
  source?: string;
  pickLabel: string;
  entryPrice: number;
  modelProb: number | null;
  edgeCents: number | null;
  lowScore: number | null;
  contracts: number;
  totalStake: number;
  totalCost: number;
  expectedPayout: number;
  researchNote: string | null;
  environment: string;
  isPaper: boolean;
  status: string;
  errorMessage: string | null;
  settledResult: string | null;
  settledPayout: number | null;
  marketResult: string | null;
  finalGoals: number | null;
  netProfit: number | null;
  createdAt: string;
}

function getRatingBg(rating: string) {
  switch (rating) {
    case 'excellent': return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    case 'good': return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    case 'marginal': return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    default: return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
  }
}

// Map an internal pick side to the yes/no side the place route expects.
function toBinarySide(side: GoalsPick['side']): 'yes' | 'no' {
  return side === 'over' || side === 'btts_yes' ? 'yes' : 'no';
}

// Build the public URL of the game/event on the source market.
// Polymarket event slug is carried in eventTicker; Kalshi uses the series ticker page.
function marketUrl(source?: string, eventTicker?: string, seriesTicker?: string): string | null {
  if (source === 'polymarket') {
    const slug = (eventTicker || '').trim();
    return slug ? `https://polymarket.com/event/${slug}` : null;
  }
  const series = (seriesTicker || '').trim().toLowerCase();
  return series ? `https://kalshi.com/markets/${series}` : null;
}

// Small "View on <market>" link opening the game page on the source exchange.
function MarketLink({ source, eventTicker, seriesTicker }: { source?: string; eventTicker?: string; seriesTicker?: string }) {
  const url = marketUrl(source, eventTicker, seriesTicker);
  if (!url) return null;
  const isPoly = source === 'polymarket';
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 text-[10px] font-medium rounded px-1.5 py-0.5 border transition-colors ${
        isPoly
          ? 'text-indigo-300 border-indigo-500/30 hover:bg-indigo-500/10'
          : 'text-violet-300 border-violet-500/30 hover:bg-violet-500/10'
      }`}
      title={`View this game on ${isPoly ? 'Polymarket' : 'Kalshi'}`}
    >
      <ExternalLink className="w-3 h-3" /> View on {isPoly ? 'Polymarket' : 'Kalshi'}
    </a>
  );
}

// Small source badge (Kalshi = violet, Polymarket = indigo).
function SourceBadge({ source }: { source?: string }) {
  const isPoly = source === 'polymarket';
  return (
    <Badge
      variant="outline"
      className={`text-[10px] px-1.5 py-0 ${
        isPoly
          ? 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30'
          : 'bg-violet-500/10 text-violet-300 border-violet-500/30'
      }`}
    >
      {isPoly ? 'Polymarket' : 'Kalshi'}
    </Badge>
  );
}

export function GoalsContent() {
  const [analyses, setAnalyses] = useState<GoalsAnalysis[]>([]);
  const [orders, setOrders] = useState<GoalsOrder[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [orderSummary, setOrderSummary] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [settling, setSettling] = useState(false);
  const [placingBet, setPlacingBet] = useState<string | null>(null);
  const [researching, setResearching] = useState<string | null>(null);
  const [repricing, setRepricing] = useState<string | null>(null);
  const [pricedAt, setPricedAt] = useState<Record<string, string>>({});
  const [researchMap, setResearchMap] = useState<Record<string, GoalsResearch>>({});
  const [leagueFilter, setLeagueFilter] = useState('all');
  const [leagues, setLeagues] = useState<string[]>([]);
  const [source, setSource] = useState<'kalshi' | 'polymarket' | 'both'>('kalshi');
  const [tab, setTab] = useState<'opportunities' | 'orders'>('opportunities');
  const [sortBy, setSortBy] = useState<'edge' | 'date-asc' | 'date-desc'>('date-asc');

  // config / settings
  const [showSettings, setShowSettings] = useState(false);
  const [stake, setStake] = useState(2);
  const [maxStake, setMaxStake] = useState(5);
  const [minEdge, setMinEdge] = useState(3);
  const [minLowScore, setMinLowScore] = useState(0);
  const [lowScoringOnly, setLowScoringOnly] = useState(true);
  const [paperMode, setPaperMode] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);

  useEffect(() => {
    fetch('/api/goals/config')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const c = d?.config;
        if (!c) return;
        if (typeof c.minStakePerBet === 'number') setStake(c.minStakePerBet);
        if (typeof c.maxStakePerBet === 'number') setMaxStake(c.maxStakePerBet);
        if (typeof c.minEdgeCents === 'number') setMinEdge(c.minEdgeCents);
        if (typeof c.minLowScore === 'number') setMinLowScore(c.minLowScore);
        if (typeof c.lowScoringOnly === 'boolean') setLowScoringOnly(c.lowScoringOnly);
        if (typeof c.paperMode === 'boolean') setPaperMode(c.paperMode);
      })
      .catch(() => {});
  }, []);

  const saveConfig = useCallback(async (overrides?: Record<string, any>) => {
    setSavingConfig(true);
    try {
      await fetch('/api/goals/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          minStakePerBet: stake,
          maxStakePerBet: maxStake,
          minEdgeCents: minEdge,
          minLowScore,
          lowScoringOnly,
          paperMode,
          ...overrides,
        }),
      });
    } catch {} finally {
      setSavingConfig(false);
    }
  }, [stake, maxStake, minEdge, minLowScore, lowScoringOnly, paperMode]);

  const togglePaperMode = useCallback(async (next: boolean) => {
    setPaperMode(next);
    await saveConfig({ paperMode: next });
    toast.success(next
      ? 'Demo (paper) mode ON — picks are tracked, no real bets placed'
      : 'Demo mode OFF — real bets will be placed (YES-side only)');
  }, [saveConfig]);

  const fetchMarkets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/goals/markets?source=${source}`);
      if (!res.ok) throw new Error('Failed to fetch goals markets');
      const data = await res.json();
      setAnalyses(data.analyses ?? []);
      setSummary(data.summary ?? null);
      setLeagues(data.summary?.leagues ?? []);
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to fetch markets');
    } finally {
      setLoading(false);
    }
  }, [source]);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/goals/orders');
      if (!res.ok) return;
      const data = await res.json();
      setOrders(data.orders ?? []);
      setOrderSummary(data.summary ?? null);
    } catch {}
  }, []);

  const handleSettle = useCallback(async () => {
    setSettling(true);
    try {
      const res = await fetch('/api/goals/settle', { method: 'POST' });
      const data = await res.json();
      if (data.settled > 0) {
        toast.success(`Settled ${data.settled} bet(s)`);
        fetchOrders();
      } else {
        toast.info('No bets to settle yet');
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Settlement failed');
    } finally {
      setSettling(false);
    }
  }, [fetchOrders]);

  const handleResearch = useCallback(async (matchKey: string, matchSource?: string) => {
    setResearching(matchKey);
    try {
      const res = await fetch('/api/goals/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchKey, minEdge, minLowScore, lowScoringOnly, source: matchSource }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Research failed');
      setAnalyses(prev => prev.map(a => a.match.matchKey === matchKey ? data.analysis : a));
      setResearchMap(prev => ({ ...prev, [matchKey]: data.research }));
      toast.success('Research complete — picks priced by model');
    } catch (err: any) {
      toast.error(err?.message ?? 'Research failed');
    } finally {
      setResearching(null);
    }
  }, [minEdge, minLowScore, lowScoringOnly]);

  // Lightweight per-match price refresh: snap ONE card's prices/edges back to
  // the live market without re-running the LLM research. Reuses the stored model
  // probabilities so edges stay meaningful. Ideal right before placing, since
  // prices drift while working down the list.
  const handleReprice = useCallback(async (matchKey: string, matchSource?: string) => {
    setRepricing(matchKey);
    try {
      const r = researchMap[matchKey];
      const res = await fetch('/api/goals/reprice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchKey,
          source: matchSource,
          minEdge,
          minLowScore,
          lowScoringOnly,
          bttsYesProb: r?.bttsYesProb,
          overProbByLine: r?.overProbByLine,
          expectedTotalGoals: r?.expectedTotalGoals,
          lowScore: r?.lowScoring?.dataAvailable ? r?.lowScoring?.score : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Reprice failed');
      setAnalyses(prev => prev.map(a => a.match.matchKey === matchKey ? data.analysis : a));
      if (data.pricedAt) setPricedAt(prev => ({ ...prev, [matchKey]: data.pricedAt }));
      toast.success('Prices refreshed to live market');
    } catch (err: any) {
      toast.error(err?.message ?? 'Reprice failed');
    } finally {
      setRepricing(null);
    }
  }, [researchMap, minEdge, minLowScore, lowScoringOnly]);

  const handlePlaceBet = useCallback(async (analysis: GoalsAnalysis, pick: GoalsPick) => {
    const key = analysis.match.matchKey;
    setPlacingBet(key + pick.marketTicker + pick.side);
    try {
      const research = researchMap[key];
      const res = await fetch('/api/goals/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchKey: analysis.match.matchKey,
          league: analysis.match.league,
          marketType: pick.marketType,
          line: pick.line,
          seriesTicker: pick.seriesTicker,
          eventTicker: pick.eventTicker,
          marketTicker: pick.marketTicker,
          matchTitle: analysis.match.matchTitle,
          teamA: analysis.match.teamA,
          teamB: analysis.match.teamB,
          matchDate: analysis.match.matchDate,
          side: toBinarySide(pick.side),
          source: analysis.match.source,
          pickLabel: pick.label,
          price: pick.cost,
          modelProb: pick.modelProb,
          edge: pick.edge,
          lowScore: analysis.lowScore,
          researchNote: research
            ? `xG ${research.teamAExpectedGoals}-${research.teamBExpectedGoals} → exp total ${research.expectedTotalGoals} (${research.method}). ${research.analysis}`
            : null,
          totalStake: stake,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Price moved / couldn't be verified: refresh this card so the user sees
        // the current price before deciding to retry.
        if (data.priceMoved || data.priceUnavailable) {
          handleReprice(analysis.match.matchKey, analysis.match.source);
        }
        throw new Error(data.error ?? 'Failed to place bet');
      }
      if (data.success) {
        toast.success(data.paper
          ? `Demo pick tracked: ${pick.label} on ${analysis.match.matchTitle}`
          : `Bet placed: ${pick.label} on ${analysis.match.matchTitle} (${data.order?.status})`);
        fetchOrders();
      } else {
        toast.error(`Order failed: ${data.order?.error ?? 'Unknown error'}`);
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to place bet');
    } finally {
      setPlacingBet(null);
    }
  }, [stake, researchMap, fetchOrders, handleReprice]);

  useEffect(() => {
    fetchMarkets();
    fetchOrders();
  }, [fetchMarkets, fetchOrders]);

  const filteredAnalyses = (() => {
    const base = leagueFilter === 'all'
      ? [...analyses]
      : analyses.filter(a => a.match.league === leagueFilter);
    if (sortBy === 'date-asc' || sortBy === 'date-desc') {
      base.sort((a, b) => {
        const da = a.match.matchDate ?? '';
        const db = b.match.matchDate ?? '';
        return sortBy === 'date-asc' ? da.localeCompare(db) : db.localeCompare(da);
      });
    } else {
      base.sort((a, b) => (b.bestEdge ?? -999) - (a.bestEdge ?? -999));
    }
    return base;
  })();

  return (
    <FadeIn>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Percent className="w-6 h-6 text-violet-400" />
              Goals Markets — Directional Value Bets
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Single-leg value bets on Both Teams To Score &amp; Total Goals, favouring the proven low-scoring edge (Under 2.5 / No BTTS)
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={showSettings ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowSettings(s => !s)}
              className={showSettings ? 'bg-violet-600 hover:bg-violet-700' : ''}
            >
              <SettingsIcon className="w-4 h-4 mr-1" /> Settings
            </Button>
            <Button variant="outline" size="sm" onClick={handleSettle} disabled={settling}>
              {settling ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-1" />}
              Check Settlements
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={fetchMarkets}
              disabled={loading}
              className="bg-violet-600 hover:bg-violet-700"
            >
              {loading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
              Refresh Markets
            </Button>
          </div>
        </div>

        {/* Calibration Feedback Loop */}
        <CalibrationPanel />

        {/* Settings Panel */}
        {showSettings && (
          <Card className="bg-card/50 border-violet-500/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Sliders className="w-4 h-4 text-violet-400" /> Goals Market Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Test Bet Amount ($ per bet)</Label>
                  <Input
                    type="number" min={0.5} step={0.5} value={stake}
                    onChange={(e) => setStake(Math.max(0.5, parseFloat(e.target.value) || 0))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">Start small while you follow the system.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Max Bet Amount ($)</Label>
                  <Input
                    type="number" min={1} step={0.5} value={maxStake}
                    onChange={(e) => setMaxStake(Math.max(1, parseFloat(e.target.value) || 0))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">Hard cap per bet.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Min Edge / EV (¢ per unit)</Label>
                  <Input
                    type="number" min={0} step={0.5} value={minEdge}
                    onChange={(e) => setMinEdge(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">After Research, only recommend a side whose model edge clears this. Guards against paying the vig.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Min Low-Scoring Score (0 = off)</Label>
                  <Input
                    type="number" min={0} max={100} step={5} value={minLowScore}
                    onChange={(e) => setMinLowScore(Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">Only recommend when the low-scoring consensus (0-100) is at least this high.</p>
                </div>
              </div>

              {/* Low-scoring-only toggle */}
              <div className="rounded-lg border border-border/60 bg-card/60 p-3 flex items-center justify-between flex-wrap gap-3">
                <div className="space-y-0.5">
                  <div className="text-sm font-semibold flex items-center gap-2">
                    <Shield className={`w-4 h-4 ${lowScoringOnly ? 'text-emerald-400' : 'text-zinc-400'}`} />
                    Low-scoring side only
                    <Badge variant="outline" className={lowScoringOnly ? 'border-emerald-500/40 text-emerald-400' : 'border-zinc-500/40 text-zinc-400'}>
                      {lowScoringOnly ? 'ON' : 'OFF'}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground max-w-md">
                    When ON, only Under-goals and No-BTTS picks are eligible for a recommendation — the proven +ROI edge. Turn OFF to let the model recommend either side.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant={lowScoringOnly ? 'default' : 'outline'}
                    className={lowScoringOnly ? 'bg-emerald-600 hover:bg-emerald-700' : ''}
                    disabled={savingConfig}
                    onClick={() => { setLowScoringOnly(true); saveConfig({ lowScoringOnly: true }); }}>
                    Low-scoring
                  </Button>
                  <Button size="sm" variant={!lowScoringOnly ? 'default' : 'outline'}
                    className={!lowScoringOnly ? 'bg-violet-600 hover:bg-violet-700' : ''}
                    disabled={savingConfig}
                    onClick={() => { setLowScoringOnly(false); saveConfig({ lowScoringOnly: false }); }}>
                    Both sides
                  </Button>
                </div>
              </div>

              {/* Demo / paper trading toggle */}
              <div className="rounded-lg border border-border/60 bg-card/60 p-3 flex items-center justify-between flex-wrap gap-3">
                <div className="space-y-0.5">
                  <div className="text-sm font-semibold flex items-center gap-2">
                    <ShieldCheck className={`w-4 h-4 ${paperMode ? 'text-amber-400' : 'text-emerald-400'}`} />
                    Demo (paper) mode
                    <Badge variant="outline" className={paperMode ? 'border-amber-500/40 text-amber-400' : 'border-emerald-500/40 text-emerald-400'}>
                      {paperMode ? 'ON — tracking picks' : 'OFF — real bets'}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground max-w-md">
                    When ON, selecting a pick records it <span className="font-semibold">without placing any real bet</span> or spending money. Check settlements later to see how your picks would have done. Low-scoring picks (Under / No BTTS) are demo-only — the live quick-order path cannot express NO-side orders.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant={paperMode ? 'default' : 'outline'}
                    className={paperMode ? 'bg-amber-600 hover:bg-amber-700' : ''}
                    disabled={savingConfig}
                    onClick={() => togglePaperMode(true)}>
                    Demo
                  </Button>
                  <Button size="sm" variant={!paperMode ? 'default' : 'outline'}
                    className={!paperMode ? 'bg-emerald-600 hover:bg-emerald-700' : ''}
                    disabled={savingConfig}
                    onClick={() => togglePaperMode(false)}>
                    Real
                  </Button>
                </div>
              </div>

              <div className="flex items-center justify-end pt-1">
                <Button size="sm" className="bg-violet-600 hover:bg-violet-700"
                  onClick={() => { saveConfig(); fetchMarkets(); toast.success('Settings applied'); }}
                  disabled={loading}>
                  {loading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
                  Apply &amp; Rescan
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Summary Cards */}
        {(summary || orderSummary) && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Matches</div>
              <div className="text-xl font-bold font-mono">{summary?.totalMatches ?? 0}</div>
            </CardContent></Card>
            <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
              <div className="text-xs text-muted-foreground">BTTS Markets</div>
              <div className="text-xl font-bold font-mono text-violet-400">{summary?.bttsCount ?? 0}</div>
            </CardContent></Card>
            <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Totals Markets</div>
              <div className="text-xl font-bold font-mono text-blue-400">{summary?.totalsCount ?? 0}</div>
            </CardContent></Card>
            <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Bets Placed</div>
              <div className="text-xl font-bold font-mono">{orderSummary?.total ?? 0}</div>
            </CardContent></Card>
            <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Win Rate</div>
              <div className="text-xl font-bold font-mono text-emerald-400">{orderSummary?.winRate ?? 0}%</div>
            </CardContent></Card>
            <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
              <div className="text-xs text-muted-foreground">ROI</div>
              <div className={`text-xl font-bold font-mono ${(orderSummary?.roi ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {(orderSummary?.roi ?? 0) >= 0 ? '+' : ''}{(orderSummary?.roi ?? 0).toFixed(1)}%
              </div>
            </CardContent></Card>
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-2 border-b border-border/50 pb-2">
          <Button variant={tab === 'opportunities' ? 'default' : 'ghost'} size="sm"
            onClick={() => setTab('opportunities')}
            className={tab === 'opportunities' ? 'bg-violet-600 hover:bg-violet-700' : ''}>
            <Target className="w-4 h-4 mr-1" /> Opportunities ({filteredAnalyses.length})
          </Button>
          <Button variant={tab === 'orders' ? 'default' : 'ghost'} size="sm"
            onClick={() => setTab('orders')}
            className={tab === 'orders' ? 'bg-violet-600 hover:bg-violet-700' : ''}>
            <BarChart3 className="w-4 h-4 mr-1" /> Bet History ({orders.length})
          </Button>
          {tab === 'opportunities' && (
            <div className="ml-auto flex items-center gap-2">
              <Select value={source} onValueChange={(v) => { setSource(v as typeof source); setLeagueFilter('all'); }}>
                <SelectTrigger className="w-[180px] h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="kalshi">Source: Kalshi</SelectItem>
                  <SelectItem value="polymarket">Source: Polymarket</SelectItem>
                  <SelectItem value="both">Source: Both</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                <SelectTrigger className="w-[190px] h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="date-asc">Sort: Date (soonest)</SelectItem>
                  <SelectItem value="date-desc">Sort: Date (latest)</SelectItem>
                  <SelectItem value="edge">Sort: Best model edge</SelectItem>
                </SelectContent>
              </Select>
              {leagues.length > 1 && (
                <Select value={leagueFilter} onValueChange={setLeagueFilter}>
                  <SelectTrigger className="w-[180px] h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Leagues</SelectItem>
                    {leagues.map(l => (<SelectItem key={l} value={l}>{l}</SelectItem>))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
        </div>

        {/* Opportunities */}
        {tab === 'opportunities' && (
          <>
            {loading && analyses.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-violet-400" />
                <span className="ml-3 text-muted-foreground">Scanning BTTS &amp; Total-Goals markets...</span>
              </div>
            ) : filteredAnalyses.length === 0 ? (
              <Card className="bg-card/50 border-border/50">
                <CardContent className="p-8 text-center text-muted-foreground">
                  No open Both-Teams-To-Score or Total-Goals markets found right now. These appear when soccer fixtures are scheduled (MLS &amp; UEFA competitions are the usual sources) — check back closer to match day.
                </CardContent>
              </Card>
            ) : (
              <Stagger className="grid gap-4">
                {filteredAnalyses.map((a) => (
                  <StaggerItem key={a.match.matchKey}>
                    <GoalsMatchCard
                      analysis={a}
                      onResearch={() => handleResearch(a.match.matchKey, a.match.source)}
                      researching={researching === a.match.matchKey}
                      onReprice={() => handleReprice(a.match.matchKey, a.match.source)}
                      repricing={repricing === a.match.matchKey}
                      pricedAt={pricedAt[a.match.matchKey]}
                      research={researchMap[a.match.matchKey]}
                      onPlaceBet={(pick) => handlePlaceBet(a, pick)}
                      placingKey={placingBet}
                      paperMode={paperMode}
                      lowScoringOnly={lowScoringOnly}
                      stake={stake}
                      orders={orders}
                    />
                  </StaggerItem>
                ))}
              </Stagger>
            )}
          </>
        )}

        {/* History */}
        {tab === 'orders' && (
          <div className="space-y-3">
            {orders.length === 0 ? (
              <Card className="bg-card/50 border-border/50">
                <CardContent className="p-8 text-center text-muted-foreground">
                  No bets placed yet. Find opportunities above and track your first pick.
                </CardContent>
              </Card>
            ) : (
              <>
                {orderSummary && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
                      <div className="text-xs text-muted-foreground">Settled</div>
                      <div className="text-lg font-bold font-mono">{orderSummary?.settled ?? 0}</div>
                    </CardContent></Card>
                    <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
                      <div className="text-xs text-muted-foreground">Won / Lost</div>
                      <div className="text-lg font-bold font-mono">
                        <span className="text-emerald-400">{orderSummary?.won ?? 0}</span>
                        <span className="text-muted-foreground"> / </span>
                        <span className="text-red-400">{orderSummary?.lost ?? 0}</span>
                      </div>
                    </CardContent></Card>
                    <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
                      <div className="text-xs text-muted-foreground">Net P&amp;L</div>
                      <div className={`text-lg font-bold font-mono ${(orderSummary?.netProfit ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {(orderSummary?.netProfit ?? 0) >= 0 ? '+' : ''}${(orderSummary?.netProfit ?? 0).toFixed(2)}
                      </div>
                    </CardContent></Card>
                    <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
                      <div className="text-xs text-muted-foreground">ROI</div>
                      <div className={`text-lg font-bold font-mono ${(orderSummary?.roi ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {(orderSummary?.roi ?? 0) >= 0 ? '+' : ''}{(orderSummary?.roi ?? 0).toFixed(1)}%
                      </div>
                    </CardContent></Card>
                  </div>
                )}
                <Stagger className="space-y-3">
                  {orders.map(order => (
                    <StaggerItem key={order.id}>
                      <GoalsOrderCard order={order} />
                    </StaggerItem>
                  ))}
                </Stagger>
              </>
            )}
          </div>
        )}
      </div>
    </FadeIn>
  );
}

function GoalsMatchCard({
  analysis, onResearch, researching, onReprice, repricing, pricedAt, research, onPlaceBet, placingKey, paperMode, lowScoringOnly, stake, orders,
}: {
  analysis: GoalsAnalysis;
  onResearch: () => void;
  researching: boolean;
  onReprice: () => void;
  repricing: boolean;
  pricedAt?: string;
  research?: GoalsResearch;
  onPlaceBet: (pick: GoalsPick) => void;
  placingKey: string | null;
  paperMode: boolean;
  lowScoringOnly: boolean;
  stake: number;
  orders: GoalsOrder[];
}) {
  const { match, picks, recommended, bestOverall, rating, gateReason, researched, lowScore, expectedTotalGoals } = analysis;

  // Short side tag shown in the big recommendation banner (e.g. "BTTS YES", "UNDER 2.5").
  const sideTag = (p: GoalsPick): string => {
    if (p.marketType === 'btts') return p.side === 'btts_yes' ? 'BTTS YES' : 'BTTS NO';
    return `${p.side === 'over' ? 'OVER' : 'UNDER'} ${p.line}`;
  };

  // Default selected pick: the recommendation, else the low-scoring Under 2.5 if
  // present, else the first low-scoring pick, else the first pick.
  const pick25Under = picks.find(p => p.marketType === 'total' && p.line === 2.5 && p.side === 'under');
  const defaultPick = recommended ?? pick25Under ?? picks.find(p => p.isLowScoring) ?? picks[0] ?? null;
  const [selectedTicker, setSelectedTicker] = useState<string>(
    defaultPick ? defaultPick.marketTicker + defaultPick.side : ''
  );

  useEffect(() => {
    if (defaultPick) setSelectedTicker(defaultPick.marketTicker + defaultPick.side);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommended?.marketTicker, recommended?.side, researched]);

  // Display picks: when low-scoring-only, still show both sides but rank
  // low-scoring first so the edge side is prominent.
  const orderedPicks = [...picks].sort((a, b) => {
    if (a.isLowScoring !== b.isLowScoring) return a.isLowScoring ? -1 : 1;
    // within a side, sort by line asc then market type
    if (a.marketType !== b.marketType) return a.marketType === 'total' ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });

  const selected = picks.find(p => p.marketTicker + p.side === selectedTicker) ?? defaultPick;

  const contracts = selected && selected.cost > 0 ? Math.max(1, Math.floor((stake * 100) / selected.cost)) : 0;
  const totalCost = selected ? (contracts * selected.cost) / 100 : 0;
  const payoutIfHit = contracts;
  const placing = placingKey === match.matchKey + (selected?.marketTicker ?? '') + (selected?.side ?? '');

  const existingOrder = selected
    ? orders.find(o => o.marketTicker === selected.marketTicker
        && o.side === toBinarySide(selected.side)
        && o.status !== 'failed'
        && o.isPaper === paperMode)
    : undefined;
  const alreadyBet = !!existingOrder;

  const ls = research?.lowScoring;

  return (
    <Card className={`transition-all ${
      recommended
        ? 'bg-emerald-500/[0.04] border-emerald-500/50 ring-1 ring-emerald-500/40 shadow-lg shadow-emerald-500/5'
        : 'bg-card/50 border-border/50 hover:border-violet-500/30'
    }`}>
      {/* Prominent recommendation banner */}
      {recommended && (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-t-lg bg-gradient-to-r from-emerald-500/20 via-emerald-500/10 to-transparent border-b border-emerald-500/30">
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
            </div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">Recommended</span>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <span className="px-2.5 py-1 rounded-md bg-emerald-500 text-white text-sm font-extrabold tracking-wide shadow-sm whitespace-nowrap">
              {sideTag(recommended)}
            </span>
            <span className="text-xs text-emerald-200/90 truncate">{recommended.label} @ {recommended.cost}¢</span>
          </div>
          {typeof recommended.edge === 'number' && (
            <span className="ml-auto shrink-0 text-base font-extrabold font-mono text-emerald-400">
              +{recommended.edge.toFixed(1)}¢ <span className="text-[10px] font-semibold text-emerald-300/80">edge</span>
            </span>
          )}
        </div>
      )}
      <CardContent className="p-4">
        <div className="flex flex-col lg:flex-row lg:items-start gap-4">
          {/* Left: match + picks */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-violet-500/30 text-violet-400">{match.league}</Badge>
              <SourceBadge source={match.source} />
              <MarketLink
                source={match.source}
                eventTicker={match.totalEventTicker || match.bttsEventTicker || match.matchKey}
                seriesTicker={match.totalSeriesTicker || match.bttsSeriesTicker}
              />
              <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{match.matchDate}</span>
              {researched && rating !== 'none' && (
                <Badge variant="outline" className={getRatingBg(rating)}>{rating}</Badge>
              )}
              {research && (
                <Badge variant="outline" className="bg-violet-500/10 text-violet-300 border-violet-500/30 text-[10px]">
                  <Sparkles className="w-3 h-3 mr-1" /> xG {research.teamAExpectedGoals}-{research.teamBExpectedGoals}
                </Badge>
              )}
              {research?.sharp?.totals?.length ? (
                <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/30 text-[10px]">
                  <BarChart3 className="w-3 h-3 mr-1" /> Sharp {research.sharp.totals.map(t => `O${t.line} ${Math.round(t.overProb * 100)}%`).join(', ')}
                </Badge>
              ) : null}
              {ls?.dataAvailable && (
                <Badge variant="outline" className={`text-[10px] ${
                  ls.rating === 'strong' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                  ls.rating === 'moderate' ? 'bg-blue-500/10 text-blue-400 border-blue-500/30' :
                  ls.rating === 'unlikely' ? 'bg-red-500/10 text-red-400 border-red-500/30' :
                  'bg-zinc-500/10 text-zinc-400 border-zinc-500/30'
                }`}>
                  <Shield className="w-3 h-3 mr-1" /> Low-scoring {ls.score}%
                </Badge>
              )}
            </div>

            <h3 className="font-semibold text-base truncate">
              {match.teamA} <span className="text-muted-foreground">vs</span> {match.teamB}
            </h3>
            <p className="text-[11px] text-muted-foreground mb-3">
              {match.btts ? 'BTTS' : ''}{match.btts && match.totalLadder.length ? ' + ' : ''}
              {match.totalLadder.length ? `${match.totalLadder.length} total line${match.totalLadder.length === 1 ? '' : 's'}` : ''}
              {typeof expectedTotalGoals === 'number' ? ` • model exp total ${expectedTotalGoals.toFixed(2)} goals` : ''}
            </p>

            {/* Pick selector */}
            <div className="space-y-1.5">
              {orderedPicks.map(p => {
                const key = p.marketTicker + p.side;
                const isSelected = key === selectedTicker;
                const isRec = recommended && recommended.marketTicker === p.marketTicker && recommended.side === p.side;
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedTicker(key)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-left transition-colors ${
                      isRec
                        ? 'bg-emerald-500/15 border-emerald-500/60 ring-1 ring-emerald-500/40'
                        : isSelected
                          ? 'bg-violet-600/15 border-violet-500/50'
                          : 'bg-muted/30 border-border/40 hover:border-violet-500/40'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {p.isLowScoring
                        ? <TrendingDown className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        : <TrendingUp className="w-3.5 h-3.5 text-zinc-400 shrink-0" />}
                      <span className={`text-sm truncate ${isRec ? 'font-bold text-emerald-100' : ''}`}>{p.label}</span>
                      {isRec && (
                        <span className="inline-flex items-center gap-1 bg-emerald-500 text-white text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0">
                          <CheckCircle2 className="w-3 h-3" /> Pick
                        </span>
                      )}
                      {p.isLowScoring && !isRec && (
                        <span className="text-[9px] text-emerald-500/70 uppercase tracking-wide hidden sm:inline">edge side</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-2">
                      {typeof p.modelProb === 'number' && (
                        <span className="text-[11px] font-mono text-blue-300">{(p.modelProb * 100).toFixed(0)}%</span>
                      )}
                      <span className="text-xs font-mono text-violet-300">{p.cost}¢</span>
                      {typeof p.edge === 'number' && (
                        <span className={`text-xs font-mono font-semibold ${p.edge >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {p.edge >= 0 ? '+' : ''}{p.edge.toFixed(1)}¢
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Research analysis */}
            {research?.analysis && (
              <div className="mt-3 border-l-2 border-violet-500/40 pl-2 space-y-1">
                <p className="text-[11px] text-muted-foreground">
                  <span className="text-violet-300 font-medium">Analysis:</span> {research.analysis}
                </p>
                {(research.teamAForm || research.teamBForm) && (
                  <p className="text-[11px] text-muted-foreground">
                    <span className="text-violet-300 font-medium">Recent form:</span>{' '}
                    {research.teamAForm && <span>{match.teamA} {research.teamAForm}</span>}
                    {research.teamAForm && research.teamBForm && <span> • </span>}
                    {research.teamBForm && <span>{match.teamB} {research.teamBForm}</span>}
                  </p>
                )}
                {research.headToHead && (
                  <p className="text-[11px] text-muted-foreground">
                    <span className="text-violet-300 font-medium">H2H:</span> {research.headToHead}
                  </p>
                )}
                {research.sharp?.totals?.length ? (
                  <div className="mt-1 rounded-md bg-amber-500/5 border border-amber-500/20 px-2 py-1.5">
                    <div className="flex items-center gap-1.5 mb-1">
                      <BarChart3 className="w-3.5 h-3.5 text-amber-400" />
                      <span className="text-[11px] font-medium text-amber-300">Sharp Bookmaker Consensus</span>
                    </div>
                    <div className="space-y-0.5 text-[10px] text-muted-foreground">
                      {research.sharp.totals.map((t, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <div className="w-16 shrink-0">
                            <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
                              <div className="h-full rounded-full bg-amber-500" style={{ width: `${Math.round(t.overProb * 100)}%` }} />
                            </div>
                          </div>
                          <span>Over {t.line}: {Math.round(t.overProb * 100)}% / Under: {Math.round(t.underProb * 100)}%</span>
                          <span className="text-muted-foreground/60 ml-auto">({t.booksUsed} books)</span>
                        </div>
                      ))}
                      {research.sharp.btts && (
                        <div className="flex items-center gap-2">
                          <div className="w-16 shrink-0">
                            <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
                              <div className="h-full rounded-full bg-amber-500" style={{ width: `${Math.round(research.sharp.btts.yesProb * 100)}%` }} />
                            </div>
                          </div>
                          <span>BTTS Yes: {Math.round(research.sharp.btts.yesProb * 100)}% / No: {Math.round(research.sharp.btts.noProb * 100)}%</span>
                          <span className="text-muted-foreground/60 ml-auto">({research.sharp.btts.booksUsed} books)</span>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
                {ls?.dataAvailable && (
                  <div className="mt-2 rounded-lg bg-muted/20 border border-border/40 p-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <Shield className={`w-4 h-4 ${
                        ls.rating === 'strong' ? 'text-emerald-400' :
                        ls.rating === 'moderate' ? 'text-blue-400' :
                        ls.rating === 'unlikely' ? 'text-red-400' : 'text-zinc-400'
                      }`} />
                      <span className="text-[11px] font-medium">
                        Low-Scoring Consensus: <span className={`font-bold ${
                          ls.rating === 'strong' ? 'text-emerald-400' :
                          ls.rating === 'moderate' ? 'text-blue-400' :
                          ls.rating === 'unlikely' ? 'text-red-400' : 'text-zinc-400'
                        }`}>{ls.score}/100 ({ls.rating})</span>
                      </span>
                      <span className="text-[10px] text-muted-foreground ml-auto">
                        Est. total: {ls.expectedTotalGoals} goals
                      </span>
                    </div>
                    {ls.signals.length > 0 && (
                      <div className="space-y-0.5">
                        {ls.signals.map((sig, i) => (
                          <div key={i} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <div className="w-16 shrink-0">
                              <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
                                <div className={`h-full rounded-full ${
                                  sig.value >= 0.6 ? 'bg-emerald-500' :
                                  sig.value >= 0.4 ? 'bg-blue-500' : 'bg-red-500'
                                }`} style={{ width: `${Math.round(sig.value * 100)}%` }} />
                              </div>
                            </div>
                            <span className="truncate">{sig.label}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: economics + actions */}
          <div className="lg:w-64 shrink-0 space-y-2">
            {/* Headline: model edge for the selected pick */}
            <div className={`rounded-lg p-3 border ${
              selected && typeof selected.edge === 'number'
                ? (selected.edge >= 0 ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/10 border-red-500/30')
                : 'bg-muted/20 border-border/40'
            }`}>
              <div className="text-[10px] text-muted-foreground flex items-center gap-1"><TrendingUp className="w-3 h-3" />Model Edge (selected pick)</div>
              {selected && typeof selected.edge === 'number' ? (
                <div className={`text-2xl font-bold font-mono leading-tight ${selected.edge >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {selected.edge >= 0 ? '+' : ''}{selected.edge.toFixed(1)}¢
                  {typeof selected.modelProb === 'number' && (
                    <span className="text-xs font-semibold ml-2">({(selected.modelProb * 100).toFixed(0)}% model)</span>
                  )}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground mt-0.5">Run Research to price a model edge.</div>
              )}
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {selected
                  ? `${selected.label} @ ${selected.cost}¢ — ${selected.isLowScoring ? 'low-scoring edge side' : 'higher-scoring side'}`
                  : 'No market priced.'}
              </p>
            </div>

            {/* Gate reason */}
            {gateReason && !recommended && (
              <div className="rounded-lg p-2 border bg-amber-500/10 border-amber-500/30 text-[11px] text-amber-300 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{gateReason}</span>
              </div>
            )}

            {/* Best +EV across ALL sides — surfaced even when low-scoring-only is on,
                so a strong Over / BTTS-Yes is never hidden. */}
            {researched && lowScoringOnly && bestOverall && !bestOverall.isLowScoring
              && typeof bestOverall.edge === 'number' && bestOverall.edge >= analysis.edgeThreshold
              && (!recommended || (bestOverall.edge > (recommended.edge ?? -999))) && (
              <button
                type="button"
                onClick={() => setSelectedTicker(bestOverall.marketTicker + bestOverall.side)}
                className="w-full text-left rounded-lg p-2 border bg-sky-500/10 border-sky-500/30 hover:border-sky-400/60 transition-colors"
              >
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                  <Sparkles className="w-3 h-3" /> Best +EV across all sides
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs font-bold text-sky-100">{sideTag(bestOverall)}</span>
                  <span className="text-sm font-mono font-bold text-sky-300">+{bestOverall.edge.toFixed(1)}¢</span>
                </div>
                <p className="text-[10px] text-sky-200/70 mt-0.5">
                  Higher-scoring side — not eligible under “Low-scoring only”. Switch to “Both sides” in Settings to recommend &amp; bet it.
                </p>
              </button>
            )}

            {selected && (
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg bg-muted/30 p-2">
                  <div className="text-[10px] text-muted-foreground flex items-center gap-1"><DollarSign className="w-3 h-3" />Cost</div>
                  <div className="text-sm font-bold font-mono">{selected.cost}¢</div>
                </div>
                <div className="rounded-lg bg-muted/30 p-2">
                  <div className="text-[10px] text-muted-foreground flex items-center gap-1"><Percent className="w-3 h-3" />Implied</div>
                  <div className="text-sm font-bold font-mono text-blue-400">{(selected.impliedProb * 100).toFixed(0)}%</div>
                </div>
                <div className="rounded-lg bg-muted/30 p-2">
                  <div className="text-[10px] text-muted-foreground flex items-center gap-1"><ShieldCheck className="w-3 h-3" />Model</div>
                  <div className="text-sm font-bold font-mono text-emerald-400">
                    {typeof selected.modelProb === 'number' ? `${(selected.modelProb * 100).toFixed(0)}%` : '—'}
                  </div>
                </div>
              </div>
            )}

            {selected && (
              <div className="rounded-lg bg-muted/20 p-2 text-[11px] text-muted-foreground">
                Stake ${stake.toFixed(2)} → <span className="text-foreground font-mono">{contracts}</span> contracts •
                cost <span className="text-foreground font-mono">${totalCost.toFixed(2)}</span> •
                payout if hit <span className="text-emerald-400 font-mono">${payoutIfHit.toFixed(2)}</span>
              </div>
            )}

            {/* Live NO-side warning */}
            {!paperMode && selected && toBinarySide(selected.side) === 'no' && (
              <div className="rounded-lg p-2 border bg-amber-500/10 border-amber-500/30 text-[10px] text-amber-300">
                This is a NO-side pick (low-scoring). Live orders can&apos;t express it — switch to Demo mode to track it.
              </div>
            )}

            {/* Freshness note: when the card was last snapped to the live market */}
            {pricedAt && (
              <div className="text-[10px] text-cyan-300/80 flex items-center gap-1">
                <RefreshCw className="w-3 h-3" />
                Prices as of {new Date(pricedAt).toLocaleTimeString()}
              </div>
            )}

            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1" onClick={onResearch} disabled={researching || repricing}>
                {researching ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />}
                Research
              </Button>
              <Button variant="outline" size="sm" className="flex-1" onClick={onReprice} disabled={repricing || researching}
                title="Snap prices to the live market without re-running research">
                {repricing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
                Refresh Price
              </Button>
            </div>
            <div className="flex gap-2">
              <Button size="sm" className="flex-1 bg-violet-600 hover:bg-violet-700"
                onClick={() => selected && onPlaceBet(selected)}
                disabled={placing || alreadyBet || !selected}>
                {placing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Target className="w-4 h-4 mr-1" />}
                {alreadyBet ? 'Placed' : paperMode ? 'Track (Demo)' : 'Place Bet'}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function GoalsOrderCard({ order }: { order: GoalsOrder }) {
  const settled = order.settledResult === 'won' || order.settledResult === 'lost';
  const won = order.settledResult === 'won';

  return (
    <Card className="bg-card/50 border-border/50">
      <CardContent className="p-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-violet-500/30 text-violet-400">{order.league}</Badge>
              <SourceBadge source={order.source} />
              <MarketLink
                source={order.source}
                eventTicker={order.eventTicker}
                seriesTicker={order.source === 'polymarket' ? order.eventTicker : (order.eventTicker || '').split('-')[0]}
              />
              <span className="text-xs text-muted-foreground">{order.matchDate}</span>
              {order.isPaper ? (
                <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/30 text-[10px]">DEMO</Badge>
              ) : (
                <Badge variant="outline" className={
                  order.environment === 'production'
                    ? 'bg-red-500/10 text-red-400 border-red-500/30 text-[10px]'
                    : 'bg-sky-500/10 text-sky-400 border-sky-500/30 text-[10px]'
                }>{order.environment === 'production' ? 'LIVE' : 'SANDBOX'}</Badge>
              )}
              {settled ? (
                <Badge variant="outline" className={won ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-red-500/15 text-red-400 border-red-500/30'}>
                  {won ? <CheckCircle2 className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                  {won ? 'Won' : 'Lost'}
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-zinc-500/15 text-zinc-300 border-zinc-500/30">{order.status}</Badge>
              )}
            </div>
            <h3 className="font-semibold text-sm">{order.teamA} <span className="text-muted-foreground">vs</span> {order.teamB}</h3>
            <div className="text-[11px] text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2">
              <span className="px-1.5 py-0.5 rounded bg-violet-500/10 border border-violet-500/30 text-violet-200 font-mono">{order.pickLabel}</span>
              <span>{order.contracts} contracts @ {order.entryPrice}¢</span>
              {typeof order.edgeCents === 'number' && (
                <span className={order.edgeCents >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  edge {order.edgeCents >= 0 ? '+' : ''}{order.edgeCents.toFixed(1)}¢
                </span>
              )}
              {typeof order.lowScore === 'number' && <span>low-scoring {order.lowScore}/100</span>}
              {settled && typeof order.finalGoals === 'number' && (
                <span className={won ? 'text-emerald-400' : 'text-red-400'}>final ≥{order.finalGoals} goals</span>
              )}
              {settled && order.marketResult && (
                <span className="uppercase">market: {order.marketResult}</span>
              )}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-xs text-muted-foreground">Cost / Payout</div>
            <div className="text-sm font-mono">${(order.totalCost / 100).toFixed(2)} → ${(order.expectedPayout / 100).toFixed(2)}</div>
            {settled && (
              <div className={`text-sm font-bold font-mono mt-1 ${(order.netProfit ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {(order.netProfit ?? 0) >= 0 ? '+' : ''}${((order.netProfit ?? 0) / 100).toFixed(2)}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

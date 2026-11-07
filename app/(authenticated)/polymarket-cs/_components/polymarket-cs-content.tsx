'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { FadeIn, Stagger, StaggerItem } from '@/components/animations';
import { CalibrationPanel } from '@/components/calibration-panel';
import { formatOdds, type OddsFormat, ODDS_FORMAT_LABELS } from '@/lib/odds-format';
import {
  Trophy,
  Loader2,
  RefreshCw,
  DollarSign,
  TrendingUp,
  Target,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Wallet,
  Layers,
  Percent,
  BarChart3,
  Settings as SettingsIcon,
  Sliders,
  Clock,
  AlertTriangle,
  Sparkles,
  ExternalLink,
  CalendarClock,
  X,
  Plus,
  Shield,
} from 'lucide-react';

interface Scoreline {
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  label: string;
  teamAScore: number;
  teamBScore: number;
  outcome: string;
  ask: number;
  bid: number;
  last: number;
  impliedProb: number;
  modelProb?: number;
  tickSize: number;
  minOrderSize: number;
  acceptingOrders: boolean;
  isAnyOther: boolean;
}

interface Basket {
  numPicks: number;
  scorelines: Scoreline[];
  combinedCost: number;
  dutchProfit: number;
  dutchMargin: number;
  coverage: number;
  expectedValue: number;
  viable: boolean;
}

interface CSMatch {
  slug: string;
  eventId: string;
  league: string;
  matchTitle: string;
  teamA: string;
  teamB: string;
  matchDate: string;
  startDate: string;
  endDate: string;
  negRisk: boolean;
  scorelines: Scoreline[];
  overround: number;
}

interface ResearchInfo {
  teamAExpectedGoals: number;
  teamBExpectedGoals: number;
  confidence: number;
  analysis: string;
  keyFactors: string[];
  teamAForm?: string;
  teamBForm?: string;
  headToHead?: string;
  expertConsensus?: string;
  likelyScores: { label: string; prob: number }[];
  method: string;
  lowScoring?: {
    score: number;
    rating: string;
    expectedTotalGoals: number;
    under25Probability: number;
    signals: { source: string; label: string; value: number; weight: number }[];
    summary: string;
    dataAvailable: boolean;
  };
}

interface CSAnalysis {
  match: CSMatch;
  baskets: Basket[];
  recommended: Basket | null;
  bestMargin: number;
  rating: string;
  bestEdge?: number;
  edgeThreshold?: number;
  lowScore?: number;
  gateReason?: string | null;
}

interface CSOrder {
  id: string;
  league: string;
  eventSlug: string;
  matchTitle: string;
  teamA: string;
  teamB: string;
  matchDate: string;
  numPicks: number;
  scorelines: string;
  combinedCost: number;
  dutchMargin: number;
  contracts: number;
  totalStake: number;
  totalCost: number;
  expectedPayout: number;
  researchNote: string | null;
  status: string;
  errorMessage: string | null;
  settledResult: string | null;
  settledPayout: number | null;
  winningScore: string | null;
  finalScore: string | null;
  netProfit: number | null;
  isPaper: boolean;
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

export function PolymarketCSContent() {
  const [analyses, setAnalyses] = useState<CSAnalysis[]>([]);
  const [orders, setOrders] = useState<CSOrder[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [placingBet, setPlacingBet] = useState<string | null>(null);
  const [leagueFilter, setLeagueFilter] = useState('all');
  const [tab, setTab] = useState<'opportunities' | 'orders'>('opportunities');
  const [leagues, setLeagues] = useState<string[]>([]);

  const [oddsFormat, setOddsFormat] = useState<OddsFormat>('shares');

  const [showSettings, setShowSettings] = useState(false);
  const [minStake, setMinStake] = useState(2);
  const [maxStake, setMaxStake] = useState(5);
  const [stake, setStake] = useState(2);
  const [minMargin, setMinMargin] = useState(0);
  const [minEdge, setMinEdge] = useState(2);
  const [minLowScore, setMinLowScore] = useState(0);
  const [maxPicks, setMaxPicks] = useState(6);
  const [slippage, setSlippage] = useState(1);
  const [includeAnyOther, setIncludeAnyOther] = useState(false);
  const [signatureType, setSignatureType] = useState(0);

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [credsConfigured, setCredsConfigured] = useState(false);
  const [researching, setResearching] = useState<string | null>(null);
  const [researchMap, setResearchMap] = useState<Record<string, ResearchInfo>>({});
  const [paperMode, setPaperMode] = useState(false);
  const [sortBy, setSortBy] = useState<'margin' | 'date-asc' | 'date-desc'>('margin');
  const [settling, setSettling] = useState(false);

  useEffect(() => {
    fetch('/api/preferences')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.oddsFormat) setOddsFormat(d.oddsFormat as OddsFormat); })
      .catch(() => {});
    fetch('/api/polymarket-cs/config')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const c = d?.config;
        setWalletAddress(d?.walletAddress ?? null);
        setCredsConfigured(!!d?.credsConfigured);
        if (!c) return;
        if (typeof c.minStakePerBet === 'number') { setMinStake(c.minStakePerBet); setStake(c.minStakePerBet); }
        if (typeof c.maxStakePerBet === 'number') setMaxStake(c.maxStakePerBet);
        if (typeof c.minProfitMargin === 'number') setMinMargin(c.minProfitMargin);
        if (typeof c.minEdgeCents === 'number') setMinEdge(c.minEdgeCents);
        if (typeof c.minLowScore === 'number') setMinLowScore(c.minLowScore);
        if (typeof c.maxPicks === 'number') setMaxPicks(c.maxPicks);
        if (typeof c.slippageCents === 'number') setSlippage(c.slippageCents);
        if (typeof c.includeAnyOther === 'boolean') setIncludeAnyOther(c.includeAnyOther);
        if (typeof c.signatureType === 'number') setSignatureType(c.signatureType);
        if (typeof c.paperMode === 'boolean') setPaperMode(c.paperMode);
      })
      .catch(() => {});
  }, []);

  const fetchBalance = useCallback(async () => {
    try {
      const res = await fetch('/api/polymarket-cs/balance');
      if (!res.ok) return;
      const d = await res.json();
      setWalletAddress(d?.walletAddress ?? null);
      setCredsConfigured(!!d?.credsConfigured);
      setUsdcBalance(typeof d?.usdcBalance === 'number' ? d.usdcBalance : null);
    } catch {}
  }, []);

  const handleOddsFormatChange = useCallback(async (fmt: OddsFormat) => {
    setOddsFormat(fmt);
    try {
      await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oddsFormat: fmt }),
      });
    } catch {}
  }, []);

  const saveConfig = useCallback(async () => {
    try {
      await fetch('/api/polymarket-cs/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          minStakePerBet: minStake,
          maxStakePerBet: maxStake,
          minProfitMargin: minMargin,
          minEdgeCents: minEdge,
          minLowScore,
          maxPicks,
          slippageCents: slippage,
          includeAnyOther,
          signatureType,
          paperMode,
        }),
      });
    } catch {}
  }, [minStake, maxStake, minMargin, minEdge, minLowScore, maxPicks, slippage, includeAnyOther, signatureType, paperMode]);

  const togglePaperMode = useCallback(async (next: boolean) => {
    setPaperMode(next);
    try {
      await fetch('/api/polymarket-cs/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          minStakePerBet: minStake,
          maxStakePerBet: maxStake,
          minProfitMargin: minMargin,
          minEdgeCents: minEdge,
          minLowScore,
          maxPicks,
          slippageCents: slippage,
          includeAnyOther,
          signatureType,
          paperMode: next,
        }),
      });
      toast.success(next
        ? 'Demo mode ON — picks are tracked, no real USDC is spent'
        : 'Live mode ON — baskets place real USDC on Polymarket');
    } catch {
      toast.error('Could not save mode');
    }
  }, [minStake, maxStake, minMargin, minEdge, minLowScore, maxPicks, slippage, includeAnyOther, signatureType]);

  const fetchMarkets = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        minMargin: String(minMargin),
        maxPicks: String(maxPicks),
        includeAnyOther: String(includeAnyOther),
      });
      const res = await fetch(`/api/polymarket-cs/markets?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch Polymarket exact-score markets');
      const data = await res.json();
      setAnalyses(data.analyses ?? []);
      setSummary(data.summary ?? null);
      setLeagues(data.summary?.leagues ?? []);
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to fetch markets');
    } finally {
      setLoading(false);
    }
  }, [minMargin, maxPicks, includeAnyOther]);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/polymarket-cs/orders');
      if (!res.ok) return;
      const data = await res.json();
      setOrders(data.orders ?? []);
      setStats(data.stats ?? null);
    } catch {}
  }, []);

  const handleSettle = useCallback(async () => {
    setSettling(true);
    try {
      const res = await fetch('/api/polymarket-cs/settle', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Settle failed');
      const s = data.settled ?? 0;
      const p = data.pending ?? 0;
      toast.success(s > 0
        ? `Settled ${s} basket${s === 1 ? '' : 's'}${p ? ` • ${p} still pending result` : ''}`
        : `No baskets ready to settle yet${p ? ` • ${p} awaiting match results` : ''}`);
      fetchOrders();
    } catch (err: any) {
      toast.error(err?.message ?? 'Settle failed');
    } finally {
      setSettling(false);
    }
  }, [fetchOrders]);

  const handleResearch = useCallback(async (slug: string) => {
    setResearching(slug);
    try {
      const res = await fetch('/api/polymarket-cs/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, maxPicks, includeAnyOther, minEdge, minLowScore }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Research failed');
      if (data.analysis) {
        setAnalyses(prev => prev.map(a => a.match.slug === slug ? data.analysis : a));
      }
      if (data.research) {
        setResearchMap(prev => ({ ...prev, [slug]: data.research }));
        toast.success(`Research complete: model xG ${data.research.teamAExpectedGoals}-${data.research.teamBExpectedGoals}`);
      } else {
        toast.success('Research complete');
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Research failed');
    } finally {
      setResearching(null);
    }
  }, [maxPicks, includeAnyOther, minEdge, minLowScore]);

  const handlePlaceBet = useCallback(async (analysis: CSAnalysis, basket: Basket) => {
    const key = analysis.match.slug;
    setPlacingBet(key);
    try {
      const research = researchMap[analysis.match.slug];
      const payloadBase = {
        eventSlug: analysis.match.slug,
        eventId: analysis.match.eventId,
        league: analysis.match.league,
        matchTitle: analysis.match.matchTitle,
        teamA: analysis.match.teamA,
        teamB: analysis.match.teamB,
        matchDate: analysis.match.matchDate,
        negRisk: analysis.match.negRisk,
        researchNote: research
          ? `Model xG ${research.teamAExpectedGoals}-${research.teamBExpectedGoals} (${research.method}). ${research.analysis}`
          : null,
        scorelines: basket.scorelines.map(s => ({
          tokenId: s.yesTokenId, label: s.label, priceCents: s.ask,
          tickSize: s.tickSize, minOrderSize: s.minOrderSize,
          modelProb: s.modelProb,
        })),
        combinedCost: basket.combinedCost,
        dutchMargin: basket.dutchMargin,
        totalStake: stake,
      };

      // Step 1: preview (no orders posted).
      const prevRes = await fetch('/api/polymarket-cs/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payloadBase, preview: true }),
      });
      const prev = await prevRes.json();
      if (!prevRes.ok) throw new Error(prev.error ?? 'Preview failed');

      const confirmMsg = paperMode
        ? `Track DEMO basket on ${analysis.match.matchTitle}?\n\n` +
          `${basket.numPicks} scorelines • ${prev.contracts} contracts/leg\n` +
          `Simulated cost: ${prev.totalCost} USDC\n` +
          `Payout if any covered score hits: ${prev.expectedPayout} USDC\n` +
          `Guaranteed profit if hit: ${prev.profitIfWin} USDC\n\n` +
          `This is a paper trade — NO real USDC is spent. Continue?`
        : `Place REAL-money basket on ${analysis.match.matchTitle}?\n\n` +
          `${basket.numPicks} scorelines • ${prev.contracts} contracts/leg\n` +
          `Total cost: ${prev.totalCost} USDC\n` +
          `Payout if any covered score hits: ${prev.expectedPayout} USDC\n` +
          `Guaranteed profit if hit: ${prev.profitIfWin} USDC\n` +
          `Wallet: ${prev.walletAddress}\n\n` +
          `This spends real USDC on Polymarket. Continue?`;
      if (!window.confirm(confirmMsg)) {
        setPlacingBet(null);
        return;
      }

      // Step 2: place for real.
      const res = await fetch('/api/polymarket-cs/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadBase),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to place bet');
      if (data.success) {
        toast.success(data.paper
          ? `Demo pick tracked on ${analysis.match.matchTitle} — no real bet placed`
          : `Basket placed on ${analysis.match.matchTitle}: ${data.order?.status}`);
        fetchOrders();
        fetchBalance();
      } else {
        toast.error(`Order failed: ${data.order?.errors?.join(', ') ?? 'Unknown error'}`);
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to place bet');
    } finally {
      setPlacingBet(null);
    }
  }, [stake, fetchOrders, fetchBalance, researchMap, paperMode]);

  useEffect(() => {
    fetchMarkets();
    fetchOrders();
    fetchBalance();
  }, [fetchMarkets, fetchOrders, fetchBalance]);

  const filteredAnalyses = (() => {
    let list = leagueFilter === 'all'
      ? [...analyses]
      : analyses.filter(a => a.match.league === leagueFilter);
    const dateKey = (a: CSAnalysis) => a.match.startDate || a.match.matchDate || '';
    if (sortBy === 'date-asc') {
      list.sort((x, y) => dateKey(x).localeCompare(dateKey(y)));
    } else if (sortBy === 'date-desc') {
      list.sort((x, y) => dateKey(y).localeCompare(dateKey(x)));
    } else {
      list.sort((x, y) => (y.bestMargin ?? -999) - (x.bestMargin ?? -999));
    }
    return list;
  })();

  // Model calibration: over settled baskets whose legs carry a stored model
  // probability, compare the model's predicted hit rate (sum of covered-leg
  // probabilities) with the actual win rate. Legacy baskets without modelProb
  // are skipped so the readout only reflects model-scored picks.
  const calibration = (() => {
    const rows = orders
      .filter(o => o.settledResult === 'won' || o.settledResult === 'lost')
      .map(o => {
        let legs: any[] = [];
        try { legs = JSON.parse(o.scorelines ?? '[]'); } catch {}
        const probs = legs
          .map(l => (typeof l?.modelProb === 'number' ? l.modelProb : null))
          .filter((p): p is number => p !== null && p > 0);
        if (probs.length === 0) return null;
        const predicted = Math.min(1, probs.reduce((s, p) => s + p, 0));
        return { predicted, won: o.settledResult === 'won' ? 1 : 0 };
      })
      .filter((x): x is { predicted: number; won: number } => x !== null);
    if (rows.length === 0) return null;
    const n = rows.length;
    const avgPredicted = rows.reduce((s, x) => s + x.predicted, 0) / n;
    const actual = rows.reduce((s, x) => s + x.won, 0) / n;
    return { n, avgPredicted, actual, gap: actual - avgPredicted };
  })();

  return (
    <FadeIn>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Trophy className="w-6 h-6 text-indigo-400" />
              Polymarket Correct-Score Dutch
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Cover a basket of the most likely exact scores on Polymarket soccer markets — profit if any one hits
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={showSettings ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowSettings(s => !s)}
              className={showSettings ? 'bg-indigo-600 hover:bg-indigo-700' : ''}
            >
              <SettingsIcon className="w-4 h-4 mr-1" /> Settings
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={fetchMarkets}
              disabled={loading}
              className="bg-indigo-600 hover:bg-indigo-700"
            >
              {loading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
              Refresh Markets
            </Button>
          </div>
        </div>

        {/* Wallet / Live warning banner */}
        <Card className="bg-indigo-500/5 border-indigo-500/20">
          <CardContent className="p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="flex items-center gap-2 text-sm">
              <Wallet className="w-4 h-4 text-indigo-400" />
              {credsConfigured ? (
                <span className="text-muted-foreground">
                  Wallet <span className="font-mono text-foreground">{walletAddress ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}` : '—'}</span>
                  {usdcBalance != null && (
                    <> • USDC <span className="font-mono text-emerald-400">${usdcBalance.toFixed(2)}</span></>
                  )}
                </span>
              ) : (
                <span className="text-amber-400">Polymarket wallet not configured</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {paperMode ? (
                <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/30 text-[10px]">
                  <ShieldCheck className="w-3 h-3 mr-1" /> DEMO — no real money
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/30 text-[10px]">
                  <AlertTriangle className="w-3 h-3 mr-1" /> LIVE — real USDC
                </Badge>
              )}
              <Button variant="outline" size="sm" className="h-7" onClick={fetchBalance}>
                <RefreshCw className="w-3 h-3 mr-1" /> Balance
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Calibration Feedback Loop */}
        <CalibrationPanel />

        {/* Settings Panel */}
        {showSettings && (
          <Card className="bg-card/50 border-indigo-500/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Sliders className="w-4 h-4 text-indigo-400" /> Polymarket Correct-Score Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Demo / Live paper-trading toggle */}
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-start gap-2">
                    <ShieldCheck className="w-4 h-4 text-amber-400 mt-0.5" />
                    <div>
                      <div className="text-sm font-medium flex items-center gap-2">
                        Trading Mode
                        <Badge variant="outline" className={paperMode
                          ? 'bg-amber-500/10 text-amber-400 border-amber-500/30 text-[10px]'
                          : 'bg-red-500/10 text-red-400 border-red-500/30 text-[10px]'}>
                          {paperMode ? 'DEMO' : 'LIVE'}
                        </Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5 max-w-md">
                        {paperMode
                          ? 'Demo mode tracks your baskets as paper trades and settles them against real results — no USDC is ever spent.'
                          : 'Live mode places real USDC baskets on Polymarket.'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant={paperMode ? 'default' : 'outline'}
                      className={paperMode ? 'bg-amber-600 hover:bg-amber-700 h-8' : 'h-8'}
                      onClick={() => togglePaperMode(true)}
                    >
                      Demo
                    </Button>
                    <Button
                      size="sm"
                      variant={!paperMode ? 'default' : 'outline'}
                      className={!paperMode ? 'bg-indigo-600 hover:bg-indigo-700 h-8' : 'h-8'}
                      onClick={() => togglePaperMode(false)}
                    >
                      Live
                    </Button>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Test Bet Amount ($ per basket)</Label>
                  <Input
                    type="number" min={1} step={0.5} value={stake}
                    onChange={(e) => setStake(Math.max(0.5, parseFloat(e.target.value) || 0))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">Start small — Polymarket min 5 contracts/leg.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Max Bet Amount ($)</Label>
                  <Input
                    type="number" min={1} step={0.5} value={maxStake}
                    onChange={(e) => setMaxStake(Math.max(1, parseFloat(e.target.value) || 0))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">Hard cap per basket.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Min Dutch Margin (%)</Label>
                  <Input
                    type="number" min={0} step={0.5} value={minMargin}
                    onChange={(e) => setMinMargin(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">Browse filter: hide baskets below this raw margin.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Min Edge / EV (¢ per unit)</Label>
                  <Input
                    type="number" min={0} step={0.5} value={minEdge}
                    onChange={(e) => setMinEdge(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">After Research, only recommend a basket whose model expected value clears this edge. Guards against paying the market vig.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Min Low-Scoring Score (0 = off)</Label>
                  <Input
                    type="number" min={0} max={100} step={5} value={minLowScore}
                    onChange={(e) => setMinLowScore(Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">Only recommend when the low-scoring consensus (0-100) is at least this high. High-scoring games are the biggest historical loss driver.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Max Picks (basket size)</Label>
                  <Input
                    type="number" min={2} max={16} step={1} value={maxPicks}
                    onChange={(e) => setMaxPicks(Math.min(16, Math.max(2, parseInt(e.target.value, 10) || 6)))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">Sweet spot is usually 5-6 scorelines.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Slippage Buffer (¢)</Label>
                  <Input
                    type="number" min={0} max={10} step={1} value={slippage}
                    onChange={(e) => setSlippage(Math.min(10, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">Bid higher per leg to improve fills.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Fund Location (signature type)</Label>
                  <Select value={String(signatureType)} onValueChange={(v) => setSignatureType(parseInt(v, 10))}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">EOA wallet (default)</SelectItem>
                      <SelectItem value="1">Email / Magic proxy</SelectItem>
                      <SelectItem value="2">Gnosis Safe proxy</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">Where the USDC lives on Polymarket.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Odds Display Format</Label>
                  <Select value={oddsFormat} onValueChange={(v) => handleOddsFormatChange(v as OddsFormat)}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ODDS_FORMAT_LABELS) as OddsFormat[]).map(fmt => (
                        <SelectItem key={fmt} value={fmt}>{ODDS_FORMAT_LABELS[fmt]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">Syncs with your global settings.</p>
                </div>
                <div className="space-y-1.5 flex flex-col justify-end">
                  <div className="flex items-center justify-between rounded-lg border border-border/50 px-3 h-9">
                    <Label className="text-xs text-muted-foreground">Include "Any Other Score"</Label>
                    <Switch checked={includeAnyOther} onCheckedChange={setIncludeAnyOther} />
                  </div>
                  <p className="text-[10px] text-muted-foreground">Add the catch-all leg to baskets.</p>
                </div>
              </div>
              <div className="flex items-center justify-end pt-1">
                <Button
                  size="sm"
                  className="bg-indigo-600 hover:bg-indigo-700"
                  onClick={() => { saveConfig(); fetchMarkets(); toast.success('Settings applied'); }}
                  disabled={loading}
                >
                  {loading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
                  Apply & Rescan
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Summary Cards */}
        {(summary || stats) && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Matches</div>
              <div className="text-xl font-bold font-mono">{summary?.totalMatches ?? 0}</div>
            </CardContent></Card>
            <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Viable</div>
              <div className="text-xl font-bold font-mono text-emerald-400">{summary?.viableCount ?? 0}</div>
            </CardContent></Card>
            <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Best Margin</div>
              <div className="text-xl font-bold font-mono text-indigo-400">{(summary?.bestMargin ?? 0).toFixed(1)}%</div>
            </CardContent></Card>
            <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Avg Margin</div>
              <div className="text-xl font-bold font-mono">{(summary?.avgMargin ?? 0).toFixed(1)}%</div>
            </CardContent></Card>
            <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Baskets Placed</div>
              <div className="text-xl font-bold font-mono">{stats?.filledCount ?? 0}</div>
            </CardContent></Card>
            <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Win Rate</div>
              <div className="text-xl font-bold font-mono text-emerald-400">{stats?.winRate ?? 0}%</div>
            </CardContent></Card>
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-2 border-b border-border/50 pb-2">
          <Button
            variant={tab === 'opportunities' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTab('opportunities')}
            className={tab === 'opportunities' ? 'bg-indigo-600 hover:bg-indigo-700' : ''}
          >
            <Target className="w-4 h-4 mr-1" /> Opportunities ({filteredAnalyses.length})
          </Button>
          <Button
            variant={tab === 'orders' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTab('orders')}
            className={tab === 'orders' ? 'bg-indigo-600 hover:bg-indigo-700' : ''}
          >
            <BarChart3 className="w-4 h-4 mr-1" /> Basket History ({orders.length})
          </Button>
          {tab === 'opportunities' && (
            <div className="ml-auto flex items-center gap-2">
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                <SelectTrigger className="w-[150px] h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="margin">Best margin</SelectItem>
                  <SelectItem value="date-asc">Soonest kickoff</SelectItem>
                  <SelectItem value="date-desc">Latest kickoff</SelectItem>
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
          {tab === 'orders' && orders.length > 0 && (
            <div className="ml-auto">
              <Button variant="outline" size="sm" className="h-8" onClick={handleSettle} disabled={settling}>
                {settling ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1" />}
                Check Settlements
              </Button>
            </div>
          )}
        </div>

        {/* Opportunities */}
        {tab === 'opportunities' && (
          <>
            {loading && analyses.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
                <span className="ml-3 text-muted-foreground">Scanning Polymarket exact-score markets...</span>
              </div>
            ) : filteredAnalyses.length === 0 ? (
              <Card className="bg-card/50 border-border/50">
                <CardContent className="p-8 text-center text-muted-foreground">
                  No soccer exact-score matches with open markets found right now. Polymarket lists these per match — check back closer to kickoff.
                </CardContent>
              </Card>
            ) : (
              <Stagger className="grid gap-4">
                {filteredAnalyses.map((a) => (
                  <StaggerItem key={a.match.slug}>
                    <MatchCard
                      analysis={a}
                      oddsFormat={oddsFormat}
                      onPlaceBet={(basket) => handlePlaceBet(a, basket)}
                      placing={placingBet === a.match.slug}
                      stake={stake}
                      onResearch={() => handleResearch(a.match.slug)}
                      researching={researching === a.match.slug}
                      research={researchMap[a.match.slug]}
                      paperMode={paperMode}
                      existingOrder={orders.find(o => o.eventSlug === a.match.slug && o.status !== 'failed' && o.isPaper === paperMode)}
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
                  No baskets placed yet. Find opportunities above and place your first basket.
                </CardContent>
              </Card>
            ) : (
              <>
                {stats && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
                      <div className="text-xs text-muted-foreground">Total Wagered</div>
                      <div className="text-lg font-bold font-mono">${((stats?.totalWagered ?? 0) / 100).toFixed(2)}</div>
                    </CardContent></Card>
                    <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
                      <div className="text-xs text-muted-foreground">Total Payouts</div>
                      <div className="text-lg font-bold font-mono text-emerald-400">${((stats?.totalPayouts ?? 0) / 100).toFixed(2)}</div>
                    </CardContent></Card>
                    <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
                      <div className="text-xs text-muted-foreground">Net P&L</div>
                      <div className={`text-lg font-bold font-mono ${(stats?.totalPL ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {(stats?.totalPL ?? 0) >= 0 ? '+' : ''}${((stats?.totalPL ?? 0) / 100).toFixed(2)}
                      </div>
                    </CardContent></Card>
                    <Card className="bg-card/50 border-border/50"><CardContent className="p-3">
                      <div className="text-xs text-muted-foreground">ROI</div>
                      <div className={`text-lg font-bold font-mono ${(stats?.roi ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {(stats?.roi ?? 0) >= 0 ? '+' : ''}{(stats?.roi ?? 0).toFixed(1)}%
                      </div>
                    </CardContent></Card>
                  </div>
                )}
                {calibration && (
                  <Card className="bg-card/50 border-indigo-500/20">
                    <CardContent className="p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <BarChart3 className="w-4 h-4 text-indigo-400" />
                        <span className="text-sm font-semibold">Model Calibration</span>
                        <span className="text-[10px] text-muted-foreground">({calibration.n} model-scored settled basket{calibration.n === 1 ? '' : 's'})</span>
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <div className="text-[10px] text-muted-foreground">Predicted hit rate</div>
                          <div className="text-lg font-bold font-mono text-blue-400">{(calibration.avgPredicted * 100).toFixed(1)}%</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-muted-foreground">Actual hit rate</div>
                          <div className="text-lg font-bold font-mono text-emerald-400">{(calibration.actual * 100).toFixed(1)}%</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-muted-foreground">Calibration gap</div>
                          <div className={`text-lg font-bold font-mono ${Math.abs(calibration.gap) <= 0.05 ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {calibration.gap >= 0 ? '+' : ''}{(calibration.gap * 100).toFixed(1)}pt
                          </div>
                        </div>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-2">
                        A small gap means the model is well-calibrated. A large negative gap means the model is over-confident (actual hits trail predictions) — tighten the edge/low-scoring gates.
                      </p>
                    </CardContent>
                  </Card>
                )}
                <Stagger className="space-y-3">
                  {orders.map(order => (
                    <StaggerItem key={order.id}>
                      <OrderCard order={order} />
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

function kickoffInfo(match: CSMatch): { label: string; started: boolean } {
  const raw = match.endDate || match.matchDate;
  if (!raw) return { label: '', started: false };
  const ko = new Date(raw);
  if (isNaN(ko.getTime())) return { label: '', started: false };
  const now = new Date();
  const diffMs = ko.getTime() - now.getTime();
  if (diffMs <= 0) return { label: 'In play / kicked off', started: true };
  const mins = Math.round(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  let label: string;
  if (days >= 2) label = `Kickoff in ${days} days`;
  else if (days === 1) label = 'Kickoff tomorrow';
  else if (hours >= 1) label = `Kickoff in ${hours}h`;
  else label = `Kickoff in ${mins}m`;
  return { label, started: false };
}

/**
 * Rebuild a Dutch basket client-side from the full scoreline list, excluding a
 * set of tokens the user removed. Targets `targetPicks` legs, ranking by model
 * probability (if research supplied) else market ask. Removing a leg frees
 * budget so the next-best eligible scoreline is pulled in as a replacement.
 */
function rebuildBasket(all: Scoreline[], excluded: Set<string>, targetPicks: number): Basket | null {
  const eligible = all.filter(s => !excluded.has(s.yesTokenId) && s.ask > 0 && s.ask < 100);
  const ranked = [...eligible].sort(
    (a, b) => (b.modelProb ?? b.impliedProb) - (a.modelProb ?? a.impliedProb)
  );
  const usingModel = ranked.some(s => typeof s.modelProb === 'number');
  const totalAsk = all.reduce((s, x) => s + x.ask, 0) || 1;
  const probOf = (s: Scoreline) => (usingModel ? (s.modelProb ?? 0) : s.ask / totalAsk);

  const picked: Scoreline[] = [];
  let cumCost = 0;
  let cumCoverage = 0;
  for (const s of ranked) {
    if (picked.length >= targetPicks) break;
    if (cumCost + s.ask >= 100) continue; // would break guaranteed profit; try next
    cumCost += s.ask;
    cumCoverage += probOf(s);
    picked.push(s);
  }
  if (picked.length < 2) return null;

  const dutchProfit = 100 - cumCost;
  const dutchMargin = cumCost > 0 ? (dutchProfit / cumCost) * 100 : 0;
  const coverage = Math.min(cumCoverage, 1);
  const expectedValue = coverage * 100 - cumCost;
  return {
    numPicks: picked.length,
    scorelines: picked,
    combinedCost: cumCost,
    dutchProfit,
    dutchMargin: Math.round(dutchMargin * 100) / 100,
    coverage: Math.round(coverage * 1000) / 1000,
    expectedValue: Math.round(expectedValue * 100) / 100,
    viable: cumCost < 100,
  };
}

function MatchCard({
  analysis, oddsFormat, onPlaceBet, placing, stake, existingOrder, onResearch, researching, research, paperMode,
}: {
  analysis: CSAnalysis;
  oddsFormat: OddsFormat;
  onPlaceBet: (basket: Basket) => void;
  placing: boolean;
  stake: number;
  existingOrder?: CSOrder;
  onResearch: () => void;
  researching: boolean;
  research?: ResearchInfo;
  paperMode: boolean;
}) {
  const { match, baskets, recommended, rating } = analysis;
  // Default the basket size to the model-recommended one, else the 5-pick
  // basket (historical sweet spot) when present, else the largest available.
  const defaultPicks =
    recommended?.numPicks ??
    baskets.find(b => b.numPicks === 5)?.numPicks ??
    baskets[baskets.length - 1]?.numPicks ??
    baskets[0]?.numPicks ?? 2;
  const [selectedPicks, setSelectedPicks] = useState<number>(defaultPicks);
  // Scorelines the user has manually removed from this basket (by YES token id).
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelectedPicks(defaultPicks);
    setExcluded(new Set());
  }, [defaultPicks]);

  const baseBasket = baskets.find(b => b.numPicks === selectedPicks) ?? recommended ?? baskets[baskets.length - 1] ?? null;
  // When the user has removed scorelines, rebuild the basket from the full
  // scoreline pool (excluding removed ones), keeping the same target size so a
  // higher-value replacement can be pulled in.
  const basket = excluded.size > 0 && baseBasket
    ? rebuildBasket(match.scorelines, excluded, baseBasket.numPicks)
    : baseBasket;
  const excludedList = match.scorelines.filter(s => excluded.has(s.yesTokenId));
  const toggleExclude = (tokenId: string) =>
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(tokenId)) next.delete(tokenId); else next.add(tokenId);
      return next;
    });
  const alreadyBet = !!existingOrder;
  const fmt = (cents: number) => formatOdds(cents, oddsFormat);

  const ko = kickoffInfo(match);

  if (!basket) {
    return (
      <Card className="bg-card/50 border-border/50">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-indigo-500/30 text-indigo-400">{match.league}</Badge>
            <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{match.matchDate}</span>
            {ko.label && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-500/30 text-amber-400 flex items-center gap-1">
                <CalendarClock className="w-3 h-3" />{ko.label}
              </Badge>
            )}
          </div>
          <h3 className="font-semibold text-base">{match.teamA} <span className="text-muted-foreground">vs</span> {match.teamB}</h3>
          <p className="text-xs text-muted-foreground mt-2">
            {excluded.size > 0
              ? 'Too many scorelines removed to form a profitable basket.'
              : 'No profitable Dutch basket available (market overround too high).'}
          </p>
          {excluded.size > 0 && (
            <Button variant="outline" size="sm" className="mt-2" onClick={() => setExcluded(new Set())}>
              <RefreshCw className="w-3 h-3 mr-1" /> Reset removed scorelines
            </Button>
          )}
          <a
            href={`https://polymarket.com/event/${match.slug}`}
            target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 mt-2"
          >
            <ExternalLink className="w-3 h-3" />View scores page on Polymarket
          </a>
        </CardContent>
      </Card>
    );
  }

  const minOrderSize = Math.max(5, ...basket.scorelines.map(s => s.minOrderSize || 5));
  const contracts = basket.combinedCost > 0
    ? Math.max(minOrderSize, Math.floor((stake * 100) / basket.combinedCost))
    : 0;
  const totalCost = (contracts * basket.combinedCost) / 100;
  const payoutIfHit = contracts;

  return (
    <Card className="bg-card/50 border-border/50 hover:border-indigo-500/30 transition-all">
      <CardContent className="p-4">
        <div className="flex flex-col lg:flex-row lg:items-start gap-4">
          {/* Left: match + basket */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-indigo-500/30 text-indigo-400">{match.league}</Badge>
              <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{match.matchDate}</span>
              {ko.label && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-500/30 text-amber-400 flex items-center gap-1">
                  <CalendarClock className="w-3 h-3" />{ko.label}
                </Badge>
              )}
              <Badge variant="outline" className={getRatingBg(rating)}>{rating}</Badge>
              {research && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-indigo-500/40 text-indigo-300 flex items-center gap-1">
                  <Sparkles className="w-3 h-3" />Model xG {research.teamAExpectedGoals}-{research.teamBExpectedGoals}
                </Badge>
              )}
              {research?.lowScoring?.dataAvailable && (
                <Badge variant="outline" className={`text-[10px] px-1.5 py-0 flex items-center gap-1 ${
                  research.lowScoring.rating === 'strong' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                  research.lowScoring.rating === 'moderate' ? 'bg-blue-500/10 text-blue-400 border-blue-500/30' :
                  research.lowScoring.rating === 'unlikely' ? 'bg-red-500/10 text-red-400 border-red-500/30' :
                  'bg-zinc-500/10 text-zinc-400 border-zinc-500/30'
                }`}>
                  <Shield className="w-3 h-3" /> U2.5 {research.lowScoring.score}%
                </Badge>
              )}
            </div>

            <h3 className="font-semibold text-base truncate">
              {match.teamA} <span className="text-muted-foreground">vs</span> {match.teamB}
            </h3>
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <p className="text-[11px] text-muted-foreground">
                {match.scorelines.length} scorelines priced • market overround {match.overround}¢
              </p>
              <a
                href={`https://polymarket.com/event/${match.slug}`}
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300"
              >
                <ExternalLink className="w-3 h-3" />View on Polymarket
              </a>
            </div>

            {research && (
              <div className="mb-3 rounded-lg border-l-2 border-indigo-500/40 bg-indigo-500/5 pl-3 pr-2 py-2 space-y-1">
                <p className="text-[11px] text-muted-foreground leading-relaxed">{research.analysis}</p>
                {research.teamAForm && research.teamBForm && (
                  <p className="text-[10px] text-muted-foreground">
                    <span className="text-indigo-300">Form:</span> {match.teamA} {research.teamAForm} • {match.teamB} {research.teamBForm}
                  </p>
                )}
                {research.headToHead && (
                  <p className="text-[10px] text-muted-foreground"><span className="text-indigo-300">H2H:</span> {research.headToHead}</p>
                )}
                {research.expertConsensus && (
                  <p className="text-[10px] text-muted-foreground"><span className="text-indigo-300">Consensus:</span> {research.expertConsensus}</p>
                )}
                {research.likelyScores?.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {research.likelyScores.slice(0, 5).map((s, i) => (
                      <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                        {s.label} {(s.prob * 100).toFixed(0)}%
                      </span>
                    ))}
                  </div>
                )}
                {research.lowScoring?.dataAvailable && (
                  <div className="mt-2 rounded-lg bg-muted/20 border border-border/40 p-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <Shield className={`w-4 h-4 ${
                        research.lowScoring.rating === 'strong' ? 'text-emerald-400' :
                        research.lowScoring.rating === 'moderate' ? 'text-blue-400' :
                        research.lowScoring.rating === 'unlikely' ? 'text-red-400' : 'text-zinc-400'
                      }`} />
                      <span className="text-[11px] font-medium">
                        Low-Scoring Consensus: <span className={`font-bold ${
                          research.lowScoring.rating === 'strong' ? 'text-emerald-400' :
                          research.lowScoring.rating === 'moderate' ? 'text-blue-400' :
                          research.lowScoring.rating === 'unlikely' ? 'text-red-400' : 'text-zinc-400'
                        }`}>{research.lowScoring.score}/100 ({research.lowScoring.rating})</span>
                      </span>
                      <span className="text-[10px] text-muted-foreground ml-auto">
                        Est. total: {research.lowScoring.expectedTotalGoals} goals
                      </span>
                    </div>
                    {research.lowScoring.signals.length > 0 && (
                      <div className="space-y-0.5">
                        {research.lowScoring.signals.map((sig, i) => (
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

            {/* Basket size selector */}
            <div className="flex items-center gap-2 mb-3">
              <Layers className="w-4 h-4 text-indigo-400" />
              <span className="text-xs text-muted-foreground">Basket size</span>
              <div className="flex flex-wrap gap-1">
                {baskets.map(b => (
                  <button
                    key={b.numPicks}
                    onClick={() => setSelectedPicks(b.numPicks)}
                    className={`px-2 py-0.5 rounded text-xs font-mono border transition-colors ${
                      b.numPicks === selectedPicks
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-muted/40 text-muted-foreground border-border/50 hover:border-indigo-500/40'
                    }`}
                  >
                    {b.numPicks}
                  </button>
                ))}
              </div>
            </div>

            {/* Covered scorelines — click ✕ to remove a scoreline from the basket */}
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-muted-foreground">Covered scorelines — remove any you think won&apos;t happen</span>
              {excluded.size > 0 && (
                <button
                  onClick={() => setExcluded(new Set())}
                  className="text-[10px] text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-0.5"
                >
                  <RefreshCw className="w-3 h-3" /> Reset
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {basket.scorelines.map(s => (
                <div key={s.yesTokenId} className="group flex items-center justify-between px-2 py-1 rounded bg-muted/30 border border-border/40 hover:border-indigo-500/40">
                  <span className="text-xs truncate">{s.label}</span>
                  <div className="flex items-center gap-1 ml-1 shrink-0">
                    <span className="text-xs font-mono text-indigo-300">{fmt(s.ask)}</span>
                    <button
                      onClick={() => toggleExclude(s.yesTokenId)}
                      title="Remove this scoreline"
                      className="text-muted-foreground hover:text-red-400 transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {excludedList.length > 0 && (
              <div className="mt-2">
                <span className="text-[10px] text-muted-foreground">Removed (click to add back):</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {excludedList.map(s => (
                    <button
                      key={s.yesTokenId}
                      onClick={() => toggleExclude(s.yesTokenId)}
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border/40 bg-muted/20 text-muted-foreground line-through hover:text-indigo-300 hover:border-indigo-500/40"
                    >
                      <Plus className="w-3 h-3" />{s.label} {fmt(s.ask)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right: economics + actions */}
          <div className="lg:w-64 shrink-0 space-y-2">
            {/* Headline: model edge / expected value (the real profitability signal) */}
            <div className={`rounded-lg p-3 border ${basket.expectedValue >= 0 ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
              <div className="text-[10px] text-muted-foreground flex items-center gap-1"><TrendingUp className="w-3 h-3" />Model Edge / Expected Value</div>
              <div className={`text-2xl font-bold font-mono leading-tight ${basket.expectedValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {basket.expectedValue >= 0 ? '+' : ''}{basket.expectedValue.toFixed(1)}¢
                <span className="text-xs font-semibold ml-2">
                  ({basket.combinedCost > 0 ? ((basket.expectedValue / basket.combinedCost) * 100).toFixed(1) : '0.0'}% edge)
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {research
                  ? 'Model win probability priced against the market. Positive = profitable long-run.'
                  : 'Pre-research this is market-implied. Run Research for a true model edge.'}
              </p>
            </div>

            {/* Gate reason: why no basket is auto-recommended yet */}
            {!recommended && analysis.gateReason && (
              <div className="rounded-lg p-2 border bg-amber-500/10 border-amber-500/30 text-[11px] text-amber-300 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{analysis.gateReason}</span>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-muted/30 p-2">
                <div className="text-[10px] text-muted-foreground flex items-center gap-1"><DollarSign className="w-3 h-3" />Cost</div>
                <div className="text-sm font-bold font-mono">{basket.combinedCost}¢</div>
              </div>
              <div className="rounded-lg bg-muted/30 p-2">
                <div className="text-[10px] text-muted-foreground flex items-center gap-1"><ShieldCheck className="w-3 h-3" />Cover</div>
                <div className="text-sm font-bold font-mono text-blue-400">{(basket.coverage * 100).toFixed(0)}%</div>
              </div>
              <div className="rounded-lg bg-muted/30 p-2">
                <div className="text-[10px] text-muted-foreground flex items-center gap-1"><Percent className="w-3 h-3" />Margin</div>
                <div className="text-sm font-bold font-mono text-muted-foreground">{basket.dutchMargin.toFixed(1)}%</div>
              </div>
            </div>

            <div className="rounded-lg bg-muted/20 p-2 text-[11px] text-muted-foreground">
              Stake ${stake.toFixed(2)} → <span className="text-foreground font-mono">{contracts}</span> contracts/leg •
              cost <span className="text-foreground font-mono">${totalCost.toFixed(2)}</span> •
              payout if hit <span className="text-emerald-400 font-mono">${payoutIfHit.toFixed(2)}</span>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm" variant="outline"
                className="flex-1 border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/10 hover:text-indigo-200"
                onClick={onResearch}
                disabled={researching}
              >
                {researching ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />}
                {research ? 'Re-run' : 'Research'}
              </Button>
              <Button
                size="sm" className={`flex-1 ${paperMode ? 'bg-amber-600 hover:bg-amber-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
                onClick={() => onPlaceBet(basket)}
                disabled={placing || alreadyBet || !basket.viable}
              >
                {placing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Target className="w-4 h-4 mr-1" />}
                {alreadyBet ? 'Placed' : paperMode ? 'Track (Demo)' : 'Place'}
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground text-center">
              Research analyzes team form, H2H &amp; expert scoreline calls, then re-ranks picks by true probability.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function OrderCard({ order }: { order: CSOrder }) {
  let legs: any[] = [];
  try { legs = JSON.parse(order.scorelines ?? '[]'); } catch {}
  const settled = order.settledResult === 'won' || order.settledResult === 'lost';
  const won = order.settledResult === 'won';

  return (
    <Card className="bg-card/50 border-border/50">
      <CardContent className="p-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-indigo-500/30 text-indigo-400">{order.league}</Badge>
              <span className="text-xs text-muted-foreground">{order.matchDate}</span>
              {order.isPaper ? (
                <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/30 text-[10px]">DEMO</Badge>
              ) : (
                <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/30 text-[10px]">LIVE</Badge>
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
            <div className="text-[11px] text-muted-foreground mt-1">
              {order.numPicks} scorelines • {order.contracts} contracts/leg • margin {order.dutchMargin.toFixed(1)}%
              {won && order.winningScore && <span className="text-emerald-400"> • Hit: {order.winningScore}</span>}
              {settled && order.finalScore && (
                <span className={won ? 'text-emerald-400' : 'text-red-400'}> • Final: {order.finalScore}</span>
              )}
            </div>
            {order.errorMessage && (
              <div className="text-[11px] text-red-400 mt-1">{order.errorMessage}</div>
            )}
            <div className="flex flex-wrap gap-1 mt-2">
              {legs.map((l, i) => (
                <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded border ${
                  order.finalScore && l.label === order.finalScore
                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                    : 'bg-muted/30 text-muted-foreground border-border/40'
                }`}>{l.label}{l.status && l.status !== 'live' ? ` (${l.status})` : ''}</span>
              ))}
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

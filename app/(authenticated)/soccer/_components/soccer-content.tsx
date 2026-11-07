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
import { formatOdds, type OddsFormat, ODDS_FORMAT_LABELS } from '@/lib/odds-format';
import {
  Trophy,
  Loader2,
  RefreshCw,
  Play,
  DollarSign,
  TrendingUp,
  TrendingDown,
  Target,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Percent,
  ArrowUpRight,
  ArrowDownRight,
  BarChart3,
  Minus,
  Settings as SettingsIcon,
  Sliders,
} from 'lucide-react';

interface SoccerMatch {
  eventTicker: string;
  seriesTicker: string;
  league: string;
  matchTitle: string;
  subTitle: string;
  teamA: string;
  teamB: string;
  teamATicker: string;
  teamBTicker: string;
  drawTicker: string;
  teamAAsk: number;
  teamBAsk: number;
  drawAsk: number;
  teamABid: number;
  teamBBid: number;
  drawBid: number;
  teamALast: number;
  teamBLast: number;
  drawLast: number;
  expirationTime: string;
  matchDate: string;
}

interface StakeCalc {
  favWinContracts: number;
  drawContracts: number;
  favWinBidPrice: number;
  drawBidPrice: number;
  totalCostCents: number;
  expectedPayoutCents: number;
  profitIfWinCents: number;
}

interface SoccerAnalysis {
  match: SoccerMatch;
  favorite: 'teamA' | 'teamB';
  favoriteName: string;
  underdogName: string;
  favWinAsk: number;
  drawAsk: number;
  combinedCost: number;
  dutchProfit: number;
  dutchMargin: number;
  underdogWinAsk: number;
  reverseCombinedCost: number;
  reverseDutchMargin: number;
  isViable: boolean;
  rating: string;
  impliedFavWinProb: number;
  impliedDrawProb: number;
  impliedUnderdogProb: number;
  overround: number;
  stakeCalc: StakeCalc;
}

interface SoccerOrder {
  id: string;
  league: string;
  eventTicker: string;
  matchTitle: string;
  teamA: string;
  teamB: string;
  matchDate: string;
  favorite: string;
  favWinPrice: number;
  drawPrice: number;
  combinedCost: number;
  dutchMargin: number;
  favWinContracts: number;
  drawContracts: number;
  totalStake: number;
  totalCost: number;
  expectedPayout: number;
  environment: string;
  status: string;
  errorMessage: string | null;
  settledResult: string | null;
  settledPayout: number | null;
  matchResult: string | null;
  netProfit: number | null;
  createdAt: string;
}

function getRatingColor(rating: string) {
  switch (rating) {
    case 'excellent': return 'text-emerald-400';
    case 'good': return 'text-blue-400';
    case 'marginal': return 'text-amber-400';
    default: return 'text-zinc-500';
  }
}

function getRatingBg(rating: string) {
  switch (rating) {
    case 'excellent': return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    case 'good': return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    case 'marginal': return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    default: return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
  }
}

function formatMatchResult(result: string | null): string {
  if (!result) return '—';
  switch (result) {
    case 'team_a_win': return 'Home Win';
    case 'team_b_win': return 'Away Win';
    case 'draw': return 'Draw';
    default: return result;
  }
}

export function SoccerContent() {
  const [analyses, setAnalyses] = useState<SoccerAnalysis[]>([]);
  const [orders, setOrders] = useState<SoccerOrder[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [settling, setSettling] = useState(false);
  const [placingBet, setPlacingBet] = useState<string | null>(null);
  const [leagueFilter, setLeagueFilter] = useState('all');
  const [tab, setTab] = useState<'opportunities' | 'orders'>('opportunities');
  const [leagues, setLeagues] = useState<string[]>([]);

  // Odds display format (mirrors the global Settings preference)
  const [oddsFormat, setOddsFormat] = useState<OddsFormat>('shares');

  // Betting settings (mirror the temperature auto-bet config style)
  const [showSettings, setShowSettings] = useState(false);
  const [stake, setStake] = useState(10);
  const [minMargin, setMinMargin] = useState(0);
  const [slippage, setSlippage] = useState(2);
  const [environment, setEnvironment] = useState<'demo' | 'production'>('demo');

  // Load persisted soccer settings + odds format preference once on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('soccerSettings');
      if (saved) {
        const s = JSON.parse(saved);
        if (typeof s.stake === 'number') setStake(s.stake);
        if (typeof s.minMargin === 'number') setMinMargin(s.minMargin);
        if (typeof s.slippage === 'number') setSlippage(s.slippage);
      }
    } catch { /* ignore */ }
    // Pull the user's odds display format from global preferences
    fetch('/api/preferences')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.oddsFormat) setOddsFormat(d.oddsFormat as OddsFormat); })
      .catch(() => { /* ignore */ });
    // Pull the environment used for placing bets (controlled in Auto-Bet settings)
    fetch('/api/auto-bet/config')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.config?.environment) setEnvironment(d.config.environment); })
      .catch(() => { /* ignore */ });
  }, []);

  const persistSettings = useCallback((next: { stake: number; minMargin: number; slippage: number }) => {
    try { localStorage.setItem('soccerSettings', JSON.stringify(next)); } catch { /* ignore */ }
  }, []);

  const handleOddsFormatChange = useCallback(async (fmt: OddsFormat) => {
    setOddsFormat(fmt);
    try {
      await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oddsFormat: fmt }),
      });
    } catch { /* ignore */ }
  }, []);

  const fetchMarkets = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        stake: String(stake),
        slippage: String(slippage),
        minMargin: String(minMargin),
      });
      const res = await fetch(`/api/soccer/markets?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch soccer markets');
      const data = await res.json();
      setAnalyses(data.analyses ?? []);
      setSummary(data.summary ?? null);
      setLeagues(data.summary?.leagues ?? []);
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to fetch markets');
    } finally {
      setLoading(false);
    }
  }, [stake, slippage, minMargin]);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/soccer/orders');
      if (!res.ok) return;
      const data = await res.json();
      setOrders(data.orders ?? []);
      setStats(data.stats ?? null);
    } catch { /* ignore */ }
  }, []);

  const handleSettle = useCallback(async () => {
    setSettling(true);
    try {
      const res = await fetch('/api/soccer/settle', { method: 'POST' });
      const data = await res.json();
      if (data.settled > 0) {
        toast.success(`Settled ${data.settled} soccer bet(s)`);
        fetchOrders();
      } else {
        toast.info('No soccer bets to settle yet');
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Settlement failed');
    } finally {
      setSettling(false);
    }
  }, [fetchOrders]);

  const handlePlaceBet = useCallback(async (analysis: SoccerAnalysis) => {
    const matchKey = analysis.match.eventTicker;
    setPlacingBet(matchKey);
    try {
      const favTicker = analysis.favorite === 'teamA'
        ? analysis.match.teamATicker
        : analysis.match.teamBTicker;

      const res = await fetch('/api/soccer/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventTicker: analysis.match.eventTicker,
          seriesTicker: analysis.match.seriesTicker,
          league: analysis.match.league,
          matchTitle: analysis.match.matchTitle,
          teamA: analysis.match.teamA,
          teamB: analysis.match.teamB,
          matchDate: analysis.match.matchDate,
          favorite: analysis.favorite,
          favWinTicker: favTicker,
          favWinPrice: analysis.favWinAsk,
          drawTicker: analysis.match.drawTicker,
          drawPrice: analysis.drawAsk,
          combinedCost: analysis.combinedCost,
          dutchMargin: analysis.dutchMargin,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to place bet');

      if (data.success) {
        toast.success(`Bet placed on ${analysis.match.matchTitle}: ${data.order?.status}`);
        fetchOrders();
      } else {
        toast.error(`Order failed: ${data.order?.errors?.join(', ') ?? 'Unknown error'}`);
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to place bet');
    } finally {
      setPlacingBet(null);
    }
  }, [fetchOrders]);

  useEffect(() => {
    fetchMarkets();
    fetchOrders();
  }, [fetchMarkets, fetchOrders]);

  const filteredAnalyses = leagueFilter === 'all'
    ? analyses
    : analyses.filter(a => a.match.league === leagueFilter);

  return (
    <FadeIn>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Trophy className="w-6 h-6 text-green-400" />
              Soccer Dutch Betting
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              2-way Dutch: Favorite Win + Draw — profit if either outcome hits
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={showSettings ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowSettings(s => !s)}
              className={showSettings ? 'bg-green-600 hover:bg-green-700' : ''}
            >
              <SettingsIcon className="w-4 h-4 mr-1" /> Settings
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSettle}
              disabled={settling}
            >
              {settling ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-1" />}
              Check Settlements
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={fetchMarkets}
              disabled={loading}
              className="bg-green-600 hover:bg-green-700"
            >
              {loading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
              Refresh Markets
            </Button>
          </div>
        </div>

        {/* Settings Panel */}
        {showSettings && (
          <Card className="bg-card/50 border-green-500/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Sliders className="w-4 h-4 text-green-400" /> Soccer Betting Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Bet Amount */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Bet Amount ($ per match)</Label>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={stake}
                    onChange={(e) => setStake(Math.max(1, parseFloat(e.target.value) || 0))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">Total staked across both legs.</p>
                </div>
                {/* Min Margin */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Min Dutch Margin (%)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={0.5}
                    value={minMargin}
                    onChange={(e) => setMinMargin(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">Hide opportunities below this margin.</p>
                </div>
                {/* Slippage */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Slippage Buffer (¢)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    step={1}
                    value={slippage}
                    onChange={(e) => setSlippage(Math.min(10, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                    className="h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">Bid higher per contract to improve fills.</p>
                </div>
                {/* Odds Format */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Odds Display Format</Label>
                  <Select value={oddsFormat} onValueChange={(v) => handleOddsFormatChange(v as OddsFormat)}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ODDS_FORMAT_LABELS) as OddsFormat[]).map(fmt => (
                        <SelectItem key={fmt} value={fmt}>{ODDS_FORMAT_LABELS[fmt]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">Syncs with your global settings.</p>
                </div>
              </div>
              <div className="flex items-center justify-between flex-wrap gap-3 pt-1">
                <div className="text-xs text-muted-foreground">
                  Bets are placed in{' '}
                  <span className={environment === 'production' ? 'text-red-400 font-semibold' : 'text-amber-400 font-semibold'}>
                    {environment === 'production' ? 'LIVE (real money)' : 'DEMO'}
                  </span>{' '}
                  mode — change this in the Auto-Bet settings.
                </div>
                <Button
                  size="sm"
                  className="bg-green-600 hover:bg-green-700"
                  onClick={() => {
                    persistSettings({ stake, minMargin, slippage });
                    fetchMarkets();
                    toast.success('Settings applied');
                  }}
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
            <Card className="bg-card/50 border-border/50">
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">Matches</div>
                <div className="text-xl font-bold font-mono">{summary?.totalMatches ?? 0}</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border-border/50">
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">Viable</div>
                <div className="text-xl font-bold font-mono text-emerald-400">{summary?.viableCount ?? 0}</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border-border/50">
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">Best Margin</div>
                <div className="text-xl font-bold font-mono text-green-400">{(summary?.bestMargin ?? 0).toFixed(1)}%</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border-border/50">
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">Avg Margin</div>
                <div className="text-xl font-bold font-mono">{(summary?.avgMargin ?? 0).toFixed(1)}%</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border-border/50">
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">Bets Placed</div>
                <div className="text-xl font-bold font-mono">{stats?.filledCount ?? 0}</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border-border/50">
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">Soccer P&L</div>
                <div className={`text-xl font-bold font-mono ${(stats?.totalPL ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {(stats?.totalPL ?? 0) >= 0 ? '+' : ''}{((stats?.totalPL ?? 0) / 100).toFixed(2)}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Tab Switcher */}
        <div className="flex items-center gap-2 border-b border-border/50 pb-2">
          <Button
            variant={tab === 'opportunities' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTab('opportunities')}
            className={tab === 'opportunities' ? 'bg-green-600 hover:bg-green-700' : ''}
          >
            <Target className="w-4 h-4 mr-1" /> Opportunities ({filteredAnalyses.length})
          </Button>
          <Button
            variant={tab === 'orders' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTab('orders')}
            className={tab === 'orders' ? 'bg-green-600 hover:bg-green-700' : ''}
          >
            <BarChart3 className="w-4 h-4 mr-1" /> Bet History ({orders.length})
          </Button>
          {tab === 'opportunities' && leagues.length > 1 && (
            <div className="ml-auto">
              <Select value={leagueFilter} onValueChange={setLeagueFilter}>
                <SelectTrigger className="w-[200px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Leagues</SelectItem>
                  {leagues.map(l => (
                    <SelectItem key={l} value={l}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* Content */}
        {tab === 'opportunities' && (
          <>
            {loading && analyses.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-green-400" />
                <span className="ml-3 text-muted-foreground">Scanning soccer markets...</span>
              </div>
            ) : filteredAnalyses.length === 0 ? (
              <Card className="bg-card/50 border-border/50">
                <CardContent className="p-8 text-center text-muted-foreground">
                  No soccer matches with open markets found. Check back when matches are scheduled.
                </CardContent>
              </Card>
            ) : (
              <Stagger className="grid gap-4">
                {filteredAnalyses.map((a) => (
                  <StaggerItem key={a.match.eventTicker}>
                    <MatchCard
                      analysis={a}
                      oddsFormat={oddsFormat}
                      onPlaceBet={() => handlePlaceBet(a)}
                      placing={placingBet === a.match.eventTicker}
                      existingOrder={orders.find(o => o.eventTicker === a.match.eventTicker)}
                    />
                  </StaggerItem>
                ))}
              </Stagger>
            )}
          </>
        )}

        {tab === 'orders' && (
          <div className="space-y-3">
            {orders.length === 0 ? (
              <Card className="bg-card/50 border-border/50">
                <CardContent className="p-8 text-center text-muted-foreground">
                  No soccer bets placed yet. Find opportunities above and place your first bet.
                </CardContent>
              </Card>
            ) : (
              <Stagger className="space-y-3">
                {orders.map(order => (
                  <StaggerItem key={order.id}>
                    <OrderCard order={order} />
                  </StaggerItem>
                ))}
              </Stagger>
            )}
          </div>
        )}
      </div>
    </FadeIn>
  );
}

function MatchCard({
  analysis,
  oddsFormat,
  onPlaceBet,
  placing,
  existingOrder,
}: {
  analysis: SoccerAnalysis;
  oddsFormat: OddsFormat;
  onPlaceBet: () => void;
  placing: boolean;
  existingOrder?: SoccerOrder;
}) {
  const { match, favorite, favoriteName, underdogName, favWinAsk, drawAsk, combinedCost, dutchProfit, dutchMargin, rating, underdogWinAsk, overround, stakeCalc, impliedFavWinProb, impliedDrawProb, impliedUnderdogProb } = analysis;

  const alreadyBet = !!existingOrder;
  const fmt = (cents: number) => formatOdds(cents, oddsFormat);

  return (
    <Card className="bg-card/50 border-border/50 hover:border-green-500/30 transition-all">
      <CardContent className="p-4">
        <div className="flex flex-col lg:flex-row lg:items-center gap-4">
          {/* Match Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-green-500/30 text-green-400">
                {match.league}
              </Badge>
              <span className="text-xs text-muted-foreground">{match.matchDate}</span>
              <Badge variant="outline" className={getRatingBg(rating)}>
                {rating}
              </Badge>
            </div>

            <h3 className="font-semibold text-base truncate">
              {match.teamA} <span className="text-muted-foreground">vs</span> {match.teamB}
            </h3>

            {/* 3-Way Prices */}
            <div className="flex items-center gap-4 mt-2 text-xs">
              <div className={`flex items-center gap-1 ${favorite === 'teamA' ? 'text-green-400 font-semibold' : 'text-zinc-400'}`}>
                <span>{match.teamA}:</span>
                <span className="font-mono">{fmt(match.teamAAsk || match.teamALast)}</span>
                {favorite === 'teamA' && <Trophy className="w-3 h-3" />}
              </div>
              <div className="flex items-center gap-1 text-amber-400">
                <span>Draw:</span>
                <span className="font-mono">{fmt(match.drawAsk || match.drawLast)}</span>
              </div>
              <div className={`flex items-center gap-1 ${favorite === 'teamB' ? 'text-green-400 font-semibold' : 'text-zinc-400'}`}>
                <span>{match.teamB}:</span>
                <span className="font-mono">{fmt(match.teamBAsk || match.teamBLast)}</span>
                {favorite === 'teamB' && <Trophy className="w-3 h-3" />}
              </div>
            </div>
          </div>

          {/* Dutch Bet Analysis */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 lg:gap-6">
            {/* Strategy Breakdown */}
            <div className="text-xs space-y-1">
              <div className="text-muted-foreground font-medium">Dutch Strategy: {favoriteName} Win + Draw</div>
              <div className="flex items-center gap-3">
                <span className="text-green-400 font-mono">{fmt(favWinAsk)}</span>
                <span className="text-muted-foreground">+</span>
                <span className="text-amber-400 font-mono">{fmt(drawAsk)}</span>
                <span className="text-muted-foreground">=</span>
                <span className="font-mono font-bold">{combinedCost}¢</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`font-mono font-bold ${dutchProfit > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {dutchProfit > 0 ? '+' : ''}{dutchProfit}¢
                </span>
                <span className="text-muted-foreground">per contract pair (1 Win + 1 Draw)</span>
              </div>
            </div>

            {/* Margin */}
            <div className="flex flex-col items-center gap-1 min-w-[90px]">
              <div className={`text-2xl font-bold font-mono ${getRatingColor(rating)}`}>
                {dutchMargin.toFixed(1)}%
              </div>
              <div className="text-[10px] text-muted-foreground">DUTCH MARGIN</div>
            </div>

            {/* This Bet — concrete dollars for the configured stake */}
            {stakeCalc.favWinContracts > 0 && (
              <div className="rounded-md border border-border/50 bg-background/40 px-3 py-2 text-[11px] space-y-0.5 min-w-[170px]">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">This Bet</div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Contracts</span>
                  <span className="font-mono">{stakeCalc.favWinContracts} Win + {stakeCalc.drawContracts} Draw</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Cost</span>
                  <span className="font-mono">${(stakeCalc.totalCostCents / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Payout if hit</span>
                  <span className="font-mono">${(stakeCalc.expectedPayoutCents / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between gap-3 border-t border-border/40 pt-0.5 mt-0.5">
                  <span className="text-muted-foreground">Profit</span>
                  <span className="font-mono font-bold text-emerald-400">+${(stakeCalc.profitIfWinCents / 100).toFixed(2)}</span>
                </div>
              </div>
            )}

            {/* Action */}
            <div className="flex flex-col items-center gap-1">
              {alreadyBet ? (
                <Badge variant="outline" className="bg-blue-500/15 text-blue-400 border-blue-500/30">
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Bet Placed
                </Badge>
              ) : (
                <Button
                  size="sm"
                  onClick={onPlaceBet}
                  disabled={placing || !analysis.isViable}
                  className="bg-green-600 hover:bg-green-700 text-white"
                >
                  {placing ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 mr-1" />
                  )}
                  Place Dutch Bet
                </Button>
              )}
              <div className="text-[10px] text-muted-foreground">
                Risk: {underdogName} wins ({fmt(underdogWinAsk)})
              </div>
            </div>
          </div>
        </div>

        {/* Implied Probabilities Bar */}
        <div className="mt-3 pt-3 border-t border-border/30">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
            <span>Implied Probabilities:</span>
            <span className={favorite === 'teamA' ? 'text-green-400' : 'text-zinc-400'}>
              {match.teamA} {(impliedFavWinProb * 100).toFixed(0)}%
            </span>
            <span>|</span>
            <span className="text-amber-400">Draw {(impliedDrawProb * 100).toFixed(0)}%</span>
            <span>|</span>
            <span className={favorite === 'teamB' ? 'text-green-400' : 'text-zinc-400'}>
              {match.teamB} {(impliedUnderdogProb * 100).toFixed(0)}%
            </span>
            <span className="ml-2 text-zinc-600">
              Overround: {overround > 0 ? '+' : ''}{overround}¢
            </span>
          </div>
          <div className="flex h-2 rounded-full overflow-hidden bg-zinc-800">
            <div
              className={`${favorite === 'teamA' ? 'bg-green-500' : 'bg-zinc-500'} transition-all`}
              style={{ width: `${(match.teamAAsk || match.teamALast)}%` }}
            />
            <div
              className="bg-amber-500 transition-all"
              style={{ width: `${(match.drawAsk || match.drawLast)}%` }}
            />
            <div
              className={`${favorite === 'teamB' ? 'bg-green-500' : 'bg-zinc-500'} transition-all`}
              style={{ width: `${(match.teamBAsk || match.teamBLast)}%` }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function OrderCard({ order }: { order: SoccerOrder }) {
  const isWon = order.settledResult === 'won';
  const isLost = order.settledResult === 'lost';
  const isPending = !isWon && !isLost;

  return (
    <Card className={`bg-card/50 border-border/50 ${
      isWon ? 'border-emerald-500/30' : isLost ? 'border-red-500/30' : ''
    }`}>
      <CardContent className="p-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          {/* Match info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-green-500/30 text-green-400">
                {order.league}
              </Badge>
              <span className="text-xs text-muted-foreground">{order.matchDate}</span>
              {isWon && <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">WON</Badge>}
              {isLost && <Badge className="bg-red-500/15 text-red-400 border-red-500/30 text-[10px]">LOST</Badge>}
              {isPending && <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-[10px]">PENDING</Badge>}
            </div>
            <div className="font-semibold text-sm">{order.matchTitle}</div>
            <div className="text-xs text-muted-foreground">
              Strategy: <span className="text-green-400">{order.favorite} Win</span> + <span className="text-amber-400">Draw</span>
              {' '} | {order.favWinContracts} contracts
            </div>
            {order.matchResult && (
              <div className="text-xs mt-0.5">
                Result: <span className="font-medium">{formatMatchResult(order.matchResult)}</span>
              </div>
            )}
          </div>

          {/* Financials */}
          <div className="flex items-center gap-4 text-xs">
            <div className="text-center">
              <div className="text-muted-foreground">Cost</div>
              <div className="font-mono font-bold">${((order.totalCost ?? 0) / 100).toFixed(2)}</div>
            </div>
            <div className="text-center">
              <div className="text-muted-foreground">Margin</div>
              <div className="font-mono font-bold text-green-400">{(order.dutchMargin ?? 0).toFixed(1)}%</div>
            </div>
            {order.settledPayout != null && (
              <div className="text-center">
                <div className="text-muted-foreground">Payout</div>
                <div className="font-mono font-bold">${((order.settledPayout ?? 0) / 100).toFixed(2)}</div>
              </div>
            )}
            <div className="text-center">
              <div className="text-muted-foreground">P&L</div>
              <div className={`font-mono font-bold ${
                (order.netProfit ?? 0) > 0 ? 'text-emerald-400' : (order.netProfit ?? 0) < 0 ? 'text-red-400' : 'text-zinc-400'
              }`}>
                {isPending ? '—' : `${(order.netProfit ?? 0) >= 0 ? '+' : ''}$${((order.netProfit ?? 0) / 100).toFixed(2)}`}
              </div>
            </div>
            <div className="text-center">
              <div className="text-muted-foreground">Status</div>
              <div className={`font-medium ${
                order.status === 'filled' ? 'text-emerald-400' : order.status === 'partial' ? 'text-amber-400' : order.status === 'failed' ? 'text-red-400' : 'text-zinc-400'
              }`}>
                {order.status}
              </div>
            </div>
          </div>
        </div>
        {order.errorMessage && (
          <div className="mt-2 text-xs text-red-400 bg-red-500/10 rounded px-2 py-1">
            {order.errorMessage}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

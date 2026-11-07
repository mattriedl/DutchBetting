'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { FadeIn, Stagger, StaggerItem } from '@/components/animations';
import {
  Bot,
  Zap,
  ShieldCheck,
  DollarSign,
  TrendingUp,
  TrendingDown,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Play,
  Settings2,
  BarChart3,
  Target,
  Percent,
  Trophy,
  Flame,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from 'lucide-react';

interface AutoBetConfigData {
  enabled: boolean;
  mode: string;
  minProfitMargin: number;
  minRating: string;
  maxStakePerBet: number;
  maxDailySpend: number;
  slippageCents: number;
  environment: string;
}

interface BinDetail {
  ticker: string;
  range: string;
  price: number;
  count: number;
  stake: number;
  orderId?: string;
  fillStatus?: string;
  errorMessage?: string;
}

interface AutoBetOrderData {
  id: string;
  city: string;
  state: string;
  marketType: string;
  eventTicker: string;
  forecastDate: string;
  nwsForecast: number;
  profitMargin: number;
  rating: string;
  totalStake: number;
  totalCost: number;
  expectedPayout: number;
  environment: string;
  status: string;
  errorMessage: string | null;
  bins: string;
  settledResult: string | null;
  settledPayout: number | null;
  actualTemp: number | null;
  tempSource: string | null;
  winningBin: string | null;
  netProfit: number | null;
  createdAt: string;
}

interface CityStat {
  city: string;
  wagered: number;
  pnl: number;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
  roi: number;
}

interface Stats {
  total: number;
  filled: number;
  won: number;
  lost: number;
  settled: number;
  pendingSettlement: number;
  totalWagered: number;
  totalPayouts: number;
  totalPnL: number;
  avgCostPerBet: number;
  winRate: number;
  roi: number;
  bestBet: { city: string; profit: number } | null;
  worstBet: { city: string; profit: number } | null;
  currentStreak: number;
  currentStreakType: 'win' | 'loss' | null;
  longestWinStreak: number;
  longestLossStreak: number;
  cityStats: CityStat[];
}

interface Analysis {
  city: string;
  state?: string;
  marketType: string;
  eventTicker: string;
  forecastTargetDate?: string;
  nwsForecast: number;
  profitMargin: number;
  rating: string;
  isViable: boolean;
  guaranteedReturn: number;
  totalStake: number;
  positions: {
    ticker: string;
    range: string;
    odds: number;
    stake: number;
    payout: number;
  }[];
}

const RATING_COLORS: Record<string, string> = {
  excellent: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  good: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  marginal: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  none: 'text-red-400 bg-red-500/10 border-red-500/30',
};

const RATING_ORDER: Record<string, number> = {
  excellent: 0,
  good: 1,
  marginal: 2,
  none: 3,
};

function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return dollars >= 0 ? `$${dollars.toFixed(2)}` : `-$${Math.abs(dollars).toFixed(2)}`;
}

function PnLBadge({ value, isCents = false }: { value: number; isCents?: boolean }) {
  const dollars = isCents ? value / 100 : value;
  const isPositive = dollars > 0;
  const isZero = dollars === 0;
  return (
    <span className={`font-mono font-bold text-sm ${
      isPositive ? 'text-emerald-400' : isZero ? 'text-muted-foreground' : 'text-red-400'
    }`}>
      {isPositive ? '+' : ''}{isCents ? formatDollars(value) : `$${dollars.toFixed(2)}`}
    </span>
  );
}

export function AutoBetContent() {
  const [config, setConfig] = useState<AutoBetConfigData>({
    enabled: false,
    mode: 'one-click',
    minProfitMargin: 5.0,
    minRating: 'good',
    maxStakePerBet: 10.0,
    maxDailySpend: 100.0,
    slippageCents: 2,
    environment: 'demo',
  });
  const [orders, setOrders] = useState<AutoBetOrderData[]>([]);
  const [opportunities, setOpportunities] = useState<Analysis[]>([]);
  const [dailySpent, setDailySpent] = useState(0);
  const [stats, setStats] = useState<Stats>({
    total: 0, filled: 0, won: 0, lost: 0, settled: 0, pendingSettlement: 0,
    totalWagered: 0, totalPayouts: 0, totalPnL: 0, avgCostPerBet: 0,
    winRate: 0, roi: 0,
    bestBet: null, worstBet: null,
    currentStreak: 0, currentStreakType: null,
    longestWinStreak: 0, longestLossStreak: 0,
    cityStats: [],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settling, setSettling] = useState(false);
  const [placingBets, setPlacingBets] = useState<Record<string, boolean>>({});
  const [refreshingOpps, setRefreshingOpps] = useState(false);
  const [skippedStale, setSkippedStale] = useState(0);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/auto-bet/config');
      const data = await res.json();
      if (data?.config) setConfig(data.config);
    } catch {}
  }, []);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/auto-bet/orders?limit=100');
      const data = await res.json();
      if (data?.orders) setOrders(data.orders);
      if (data?.dailySpent != null) setDailySpent(data.dailySpent);
      if (data?.stats) setStats(data.stats);
    } catch {}
  }, []);

  const fetchOpportunities = useCallback(async () => {
    try {
      const res = await fetch(`/api/analysis?stake=${config.maxStakePerBet}`);
      const data = await res.json();
      const rawAnalyses = (data?.analyses ?? []) as any[];
      // Flatten: the API nests dutch bet data under .dutchBet
      const analyses: Analysis[] = rawAnalyses.map((a: any) => {
        const db = a?.dutchBet ?? {};
        return {
          city: a.city ?? '',
          state: a.state ?? '',
          marketType: a.marketType ?? '',
          eventTicker: a.eventTicker ?? '',
          forecastTargetDate: a.forecastTargetDate ?? '',
          nwsForecast: a.nwsForecast ?? 0,
          profitMargin: db.profitMargin ?? 0,
          rating: db.rating ?? 'none',
          isViable: db.isViable ?? false,
          guaranteedReturn: db.guaranteedReturn ?? 0,
          totalStake: db.totalStake ?? 0,
          positions: (db.positions ?? []).map((p: any) => ({
            ticker: p.ticker ?? '',
            range: p.range ?? '',
            odds: p.odds ?? 0,
            stake: p.stake ?? 0,
            payout: p.payout ?? 0,
          })),
        };
      });
      const filtered = analyses.filter((a: Analysis) => {
        if (!a.isViable || a.profitMargin <= 0) return false;
        if (a.profitMargin < config.minProfitMargin) return false;
        if (RATING_ORDER[a.rating] > RATING_ORDER[config.minRating]) return false;
        return true;
      });
      setOpportunities(filtered.sort((a, b) => b.profitMargin - a.profitMargin));
      setSkippedStale(data?.skippedStale ?? 0);
    } catch {}
  }, [config.minProfitMargin, config.minRating, config.maxStakePerBet]);

  useEffect(() => {
    Promise.all([fetchConfig(), fetchOrders()]).then(() => setLoading(false));
  }, [fetchConfig, fetchOrders]);

  useEffect(() => {
    if (!loading) fetchOpportunities();
  }, [loading, fetchOpportunities]);

  const saveConfig = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/auto-bet/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        toast.success('Auto-bet settings saved');
        fetchOpportunities();
      } else {
        toast.error('Failed to save settings');
      }
    } catch { toast.error('Failed to save settings'); }
    setSaving(false);
  };

  const settleOrders = async () => {
    setSettling(true);
    try {
      const res = await fetch('/api/auto-bet/settle', { method: 'POST' });
      const data = await res.json();
      if (data?.success) {
        toast.success(`Settlement check complete: ${data.resolved} orders resolved`);
        fetchOrders();
      } else {
        toast.error(data?.error ?? 'Settlement check failed');
      }
    } catch { toast.error('Settlement check failed'); }
    setSettling(false);
  };

  const placeBet = async (analysis: Analysis) => {
    const key = `${analysis.city}-${analysis.eventTicker}`;
    setPlacingBets(prev => ({ ...prev, [key]: true }));
    try {
      const res = await fetch('/api/auto-bet/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city: analysis.city,
          state: analysis.state ?? '',
          marketType: analysis.marketType,
          eventTicker: analysis.eventTicker,
          forecastDate: analysis.forecastTargetDate ?? '',
          nwsForecast: analysis.nwsForecast,
          profitMargin: analysis.profitMargin,
          rating: analysis.rating,
          positions: analysis.positions,
          totalStake: analysis.totalStake,
          guaranteedReturn: analysis.guaranteedReturn,
        }),
      });
      const data = await res.json();
      if (data?.success) {
        toast.success(`Bet placed on ${analysis.city} — ${data.order?.status}`);
        fetchOrders();
      } else {
        toast.error(data?.error ?? 'Failed to place bet');
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to place bet');
    }
    setPlacingBets(prev => ({ ...prev, [key]: false }));
  };

  const handleRefreshOpps = async () => {
    setRefreshingOpps(true);
    try {
      await fetch('/api/refresh', { method: 'POST' });
      await Promise.all([fetchOpportunities(), fetchOrders()]);
      toast.success('Data refreshed — opportunities & settlements updated');
    } catch { toast.error('Refresh failed'); }
    setRefreshingOpps(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-display font-bold flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
                <Bot className="w-5 h-5 text-white" />
              </div>
              Auto-Bet
            </h2>
            <p className="text-sm text-muted-foreground mt-1">Automated Dutch bet placement with full P&L tracking</p>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className={config.environment === 'production' ? 'border-red-500/50 text-red-400' : 'border-emerald-500/50 text-emerald-400'}>
              {config.environment === 'production' ? '🔴 LIVE' : '🟢 DEMO'}
            </Badge>
            <Badge variant="outline" className="font-mono">
              Today: ${dailySpent.toFixed(2)} / ${config.maxDailySpend.toFixed(2)}
            </Badge>
          </div>
        </div>
      </FadeIn>

      {/* === PERFORMANCE DASHBOARD === */}
      <FadeIn delay={0.05}>
        <Card className="border-amber-500/20 bg-gradient-to-br from-card to-card/80">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Trophy className="w-5 h-5 text-amber-400" />
              Performance Dashboard
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Top-level financial KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              <div className="p-3 rounded-lg bg-muted/20 border border-border/30">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Total Wagered</p>
                <p className="text-xl font-bold font-mono mt-1">${stats.totalWagered.toFixed(2)}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/20 border border-border/30">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Total Payouts</p>
                <p className="text-xl font-bold font-mono mt-1 text-emerald-400">${stats.totalPayouts.toFixed(2)}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/20 border border-border/30">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Net P&L</p>
                <p className={`text-xl font-bold font-mono mt-1 ${stats.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {stats.totalPnL >= 0 ? '+' : ''}${stats.totalPnL.toFixed(2)}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-muted/20 border border-border/30">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">ROI</p>
                <div className="flex items-center gap-1 mt-1">
                  {stats.roi > 0 ? <ArrowUpRight className="w-4 h-4 text-emerald-400" /> :
                   stats.roi < 0 ? <ArrowDownRight className="w-4 h-4 text-red-400" /> :
                   <Minus className="w-4 h-4 text-muted-foreground" />}
                  <p className={`text-xl font-bold font-mono ${stats.roi >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {stats.roi >= 0 ? '+' : ''}{stats.roi.toFixed(1)}%
                  </p>
                </div>
              </div>
              <div className="p-3 rounded-lg bg-muted/20 border border-border/30">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Win Rate</p>
                <div className="flex items-center gap-1 mt-1">
                  <Target className="w-4 h-4 text-blue-400" />
                  <p className="text-xl font-bold font-mono">{stats.winRate.toFixed(1)}%</p>
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {stats.won}W / {stats.lost}L of {stats.settled} settled
                </p>
              </div>
              <div className="p-3 rounded-lg bg-muted/20 border border-border/30">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Avg Bet Cost</p>
                <p className="text-xl font-bold font-mono mt-1">${stats.avgCostPerBet.toFixed(2)}</p>
              </div>
            </div>

            {/* Second row: Counts + Streaks */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              <div className="p-3 rounded-lg bg-muted/10 border border-border/20">
                <p className="text-[10px] text-muted-foreground">Total Orders</p>
                <p className="text-lg font-bold font-mono">{stats.total}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/10 border border-border/20">
                <p className="text-[10px] text-muted-foreground">Filled</p>
                <p className="text-lg font-bold font-mono">{stats.filled}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/10 border border-border/20">
                <p className="text-[10px] text-muted-foreground">Pending Settlement</p>
                <p className="text-lg font-bold font-mono text-amber-400">{stats.pendingSettlement}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/10 border border-border/20">
                <p className="text-[10px] text-muted-foreground">Current Streak</p>
                <div className="flex items-center gap-1">
                  {stats.currentStreakType === 'win' ? <Flame className="w-4 h-4 text-emerald-400" /> :
                   stats.currentStreakType === 'loss' ? <TrendingDown className="w-4 h-4 text-red-400" /> : null}
                  <p className={`text-lg font-bold font-mono ${
                    stats.currentStreakType === 'win' ? 'text-emerald-400' :
                    stats.currentStreakType === 'loss' ? 'text-red-400' : ''
                  }`}>
                    {stats.currentStreak > 0 ? `${stats.currentStreak}${stats.currentStreakType === 'win' ? 'W' : 'L'}` : '—'}
                  </p>
                </div>
              </div>
              <div className="p-3 rounded-lg bg-muted/10 border border-border/20">
                <p className="text-[10px] text-muted-foreground">Best Win Streak</p>
                <p className="text-lg font-bold font-mono text-emerald-400">{stats.longestWinStreak || '—'}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/10 border border-border/20">
                <p className="text-[10px] text-muted-foreground">Worst Loss Streak</p>
                <p className="text-lg font-bold font-mono text-red-400">{stats.longestLossStreak || '—'}</p>
              </div>
            </div>

            {/* Best / Worst Bets */}
            {(stats.bestBet || stats.worstBet) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {stats.bestBet && (
                  <div className="p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                      <TrendingUp className="w-4 h-4 text-emerald-400" />
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground">Best Single Bet</p>
                      <p className="text-sm font-medium">{stats.bestBet.city} — <span className="text-emerald-400 font-mono font-bold">+${stats.bestBet.profit.toFixed(2)}</span></p>
                    </div>
                  </div>
                )}
                {stats.worstBet && (
                  <div className="p-3 rounded-lg bg-red-500/5 border border-red-500/20 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center">
                      <TrendingDown className="w-4 h-4 text-red-400" />
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground">Worst Single Bet</p>
                      <p className="text-sm font-medium">{stats.worstBet.city} — <span className="text-red-400 font-mono font-bold">${stats.worstBet.profit.toFixed(2)}</span></p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Per-City Breakdown */}
            {stats.cityStats.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Per-City Performance</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[10px] text-muted-foreground uppercase tracking-wider border-b border-border/30">
                        <th className="text-left py-2 pr-3">City</th>
                        <th className="text-right py-2 px-2">W/L</th>
                        <th className="text-right py-2 px-2">Win%</th>
                        <th className="text-right py-2 px-2">Wagered</th>
                        <th className="text-right py-2 px-2">P&L</th>
                        <th className="text-right py-2 pl-2">ROI</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.cityStats.map((cs) => (
                        <tr key={cs.city} className="border-b border-border/10 hover:bg-muted/10">
                          <td className="py-1.5 pr-3 font-medium">{cs.city}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-xs">
                            <span className="text-emerald-400">{cs.wins}</span>
                            <span className="text-muted-foreground">/</span>
                            <span className="text-red-400">{cs.losses}</span>
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono text-xs">{cs.winRate}%</td>
                          <td className="py-1.5 px-2 text-right font-mono text-xs">${cs.wagered.toFixed(2)}</td>
                          <td className={`py-1.5 px-2 text-right font-mono text-xs font-bold ${cs.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {cs.pnl >= 0 ? '+' : ''}${cs.pnl.toFixed(2)}
                          </td>
                          <td className={`py-1.5 pl-2 text-right font-mono text-xs ${cs.roi >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {cs.roi >= 0 ? '+' : ''}{cs.roi}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </FadeIn>

      {/* Configuration */}
      <FadeIn delay={0.1}>
        <Card className="border-amber-500/20">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Settings2 className="w-5 h-5 text-amber-400" />
              Auto-Bet Configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label className="text-sm">Betting Mode</Label>
                <Select value={config.mode} onValueChange={(v) => setConfig(prev => ({ ...prev, mode: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="one-click">One-Click (manual approval)</SelectItem>
                    <SelectItem value="full-auto">Full-Auto (on refresh)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">
                  {config.mode === 'full-auto' ? 'Bets placed automatically when you refresh data' : 'Review and click to place each bet'}
                </p>
              </div>
              <div className="space-y-2">
                <Label className="text-sm">Min Profit Margin (%)</Label>
                <Input
                  type="number" step="0.5" min="0"
                  value={config.minProfitMargin}
                  onChange={(e) => setConfig(prev => ({ ...prev, minProfitMargin: parseFloat(e.target.value) || 0 }))}
                />
                <p className="text-[10px] text-muted-foreground">Only bet when margin ≥ this %</p>
              </div>
              <div className="space-y-2">
                <Label className="text-sm">Min Rating</Label>
                <Select value={config.minRating} onValueChange={(v) => setConfig(prev => ({ ...prev, minRating: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="excellent">Excellent only</SelectItem>
                    <SelectItem value="good">Good or better</SelectItem>
                    <SelectItem value="marginal">Marginal or better</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-sm">Max Stake Per Bet ($)</Label>
                <Input
                  type="number" step="1" min="1"
                  value={config.maxStakePerBet}
                  onChange={(e) => setConfig(prev => ({ ...prev, maxStakePerBet: parseFloat(e.target.value) || 10 }))}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-sm">Max Daily Spend ($)</Label>
                <Input
                  type="number" step="10" min="1"
                  value={config.maxDailySpend}
                  onChange={(e) => setConfig(prev => ({ ...prev, maxDailySpend: parseFloat(e.target.value) || 100 }))}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-sm">Slippage Buffer (¢)</Label>
                <Input
                  type="number" step="1" min="0" max="10"
                  value={config.slippageCents}
                  onChange={(e) => setConfig(prev => ({ ...prev, slippageCents: parseInt(e.target.value) || 0 }))}
                />
                <p className="text-[10px] text-muted-foreground">Added to each bin&apos;s bid price to improve fill rate. 0 = exact price, 2-3¢ recommended.</p>
              </div>
              <div className="space-y-2">
                <Label className="text-sm">Environment</Label>
                <Select value={config.environment} onValueChange={(v) => setConfig(prev => ({ ...prev, environment: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="demo">Demo (paper trading)</SelectItem>
                    <SelectItem value="production">Production (real money)</SelectItem>
                  </SelectContent>
                </Select>
                {config.environment === 'production' && (
                  <p className="text-[10px] text-red-400 font-medium">⚠️ Real money will be used</p>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between pt-2 border-t border-border/50">
              <div className="flex items-center gap-3">
                <Switch
                  checked={config.enabled}
                  onCheckedChange={(checked) => setConfig(prev => ({ ...prev, enabled: checked }))}
                />
                <Label className="text-sm font-medium">
                  {config.enabled ? 'Auto-bet enabled' : 'Auto-bet disabled'}
                </Label>
              </div>
              <Button onClick={saveConfig} disabled={saving} size="sm">
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
                Save Settings
              </Button>
            </div>
          </CardContent>
        </Card>
      </FadeIn>

      {/* Qualifying Opportunities */}
      <FadeIn delay={0.15}>
        <Card className="border-emerald-500/20">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Zap className="w-5 h-5 text-emerald-400" />
                Qualifying Opportunities
                {opportunities.length > 0 && (
                  <Badge variant="secondary" className="ml-2">{opportunities.length}</Badge>
                )}
                {skippedStale > 0 && (
                  <Badge variant="outline" className="ml-2 text-[10px] border-amber-500/30 text-amber-400">
                    ⏰ {skippedStale} stale filtered
                  </Badge>
                )}
              </CardTitle>
              <Button variant="outline" size="sm" onClick={handleRefreshOpps} disabled={refreshingOpps}>
                <RefreshCw className={`w-4 h-4 mr-2 ${refreshingOpps ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {opportunities.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No opportunities meeting your criteria right now.</p>
                <p className="text-xs mt-1">Try lowering min margin or refreshing data.</p>
                {skippedStale > 0 && (
                  <p className="text-xs mt-2 text-amber-400">
                    ⏰ {skippedStale} market group{skippedStale > 1 ? 's' : ''} filtered out (temperature extreme already occurred today)
                  </p>
                )}
              </div>
            ) : (
              <Stagger className="space-y-3">
                {opportunities.map((opp) => {
                  const key = `${opp.city}-${opp.eventTicker}`;
                  const isPlacing = placingBets[key];
                  return (
                    <StaggerItem key={key}>
                      <div className="p-4 rounded-lg bg-muted/20 hover:bg-muted/30 transition-colors border border-border/30">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="flex-1 min-w-[200px]">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium">{opp.city}{opp.state ? `, ${opp.state}` : ''}</p>
                              <Badge variant="outline" className={`text-[10px] ${opp.marketType === 'high' ? 'border-orange-500/30 text-orange-400' : 'border-cyan-500/30 text-cyan-400'}`}>
                                {opp.marketType?.toUpperCase()}
                              </Badge>
                              <Badge variant="outline" className="text-[10px] border-blue-500/30 text-blue-400">
                                {opp.forecastTargetDate
                                  ? new Date(opp.forecastTargetDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                                  : 'N/A'}
                              </Badge>
                              <Badge variant="outline" className={`text-[10px] ${RATING_COLORS[opp.rating] ?? ''}`}>
                                {opp.rating?.toUpperCase()}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground font-mono">
                              <span>NWS: {opp.nwsForecast}°F</span>
                              <span>Margin: <span className="text-emerald-400 font-bold">{opp.profitMargin.toFixed(2)}%</span></span>
                              <span>Return: ${opp.guaranteedReturn.toFixed(2)}</span>
                              <span>Stake: ${opp.totalStake.toFixed(2)}</span>
                            </div>
                            <div className="flex flex-wrap gap-2 mt-2">
                              {(opp.positions ?? []).map((pos, i) => (
                                <span key={i} className="text-[10px] font-mono px-2 py-0.5 rounded bg-background/50 border border-border/30">
                                  {pos.range} @ {pos.odds}¢ → ${pos.stake.toFixed(2)} (pays ${pos.payout.toFixed(2)})
                                </span>
                              ))}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            onClick={() => placeBet(opp)}
                            disabled={isPlacing || !config.enabled}
                            className="bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white"
                          >
                            {isPlacing ? (
                              <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Placing...</>
                            ) : (
                              <><Play className="w-4 h-4 mr-2" /> Place Bet</>  
                            )}
                          </Button>
                        </div>
                      </div>
                    </StaggerItem>
                  );
                })}
              </Stagger>
            )}
          </CardContent>
        </Card>
      </FadeIn>

      {/* Order History with P&L */}
      <FadeIn delay={0.2}>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className="w-5 h-5 text-muted-foreground" />
                Order History
                {stats.pendingSettlement > 0 && (
                  <Badge variant="outline" className="ml-2 border-amber-500/30 text-amber-400 text-[10px]">
                    {stats.pendingSettlement} awaiting settlement
                  </Badge>
                )}
              </CardTitle>
              <Button variant="outline" size="sm" onClick={settleOrders} disabled={settling}>
                {settling ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                Check Settlements
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {orders.length === 0 ? (
              <p className="text-center py-6 text-sm text-muted-foreground">No orders placed yet.</p>
            ) : (
              <div className="space-y-2">
                {orders.map((order) => {
                  let bins: BinDetail[] = [];
                  try { bins = JSON.parse(order.bins); } catch {}
                  const isSettled = order.settledResult === 'won' || order.settledResult === 'lost';
                  const isWon = order.settledResult === 'won';
                  const costDollars = (order.totalCost ?? 0) / 100;
                  const payoutDollars = isSettled ? (order.settledPayout ?? 0) / 100 : null;
                  const profitDollars = isSettled ? (order.netProfit ?? 0) / 100 : null;

                  return (
                    <div key={order.id} className={`p-3 rounded-lg transition-colors border ${
                      isSettled && isWon ? 'bg-emerald-500/5 border-emerald-500/20 hover:bg-emerald-500/10' :
                      isSettled && !isWon ? 'bg-red-500/5 border-red-500/20 hover:bg-red-500/10' :
                      'bg-muted/20 border-border/30 hover:bg-muted/30'
                    }`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                            isWon ? 'bg-emerald-500/15' :
                            isSettled ? 'bg-red-500/15' :
                            order.status === 'filled' ? 'bg-blue-500/10' :
                            order.status === 'partial' ? 'bg-amber-500/10' :
                            order.status === 'failed' ? 'bg-red-500/10' :
                            'bg-blue-500/10'
                          }`}>
                            {isWon ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> :
                             isSettled ? <XCircle className="w-4 h-4 text-red-400" /> :
                             order.status === 'filled' ? <Clock className="w-4 h-4 text-blue-400" /> :
                             order.status === 'failed' ? <XCircle className="w-4 h-4 text-red-400" /> :
                             order.status === 'partial' ? <AlertTriangle className="w-4 h-4 text-amber-400" /> :
                             <Clock className="w-4 h-4 text-blue-400" />}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium">{order.city}{order.state ? `, ${order.state}` : ''}</p>
                              <Badge variant="outline" className={`text-[8px] ${order.marketType === 'high' ? 'border-orange-500/30 text-orange-400' : 'border-cyan-500/30 text-cyan-400'}`}>
                                {order.marketType?.toUpperCase()}
                              </Badge>
                              <Badge variant="outline" className={`text-[8px] ${order.environment === 'production' ? 'border-red-500/30 text-red-400' : 'border-emerald-500/30 text-emerald-400'}`}>
                                {order.environment?.toUpperCase()}
                              </Badge>
                              {isSettled && (
                                <Badge variant="outline" className={`text-[8px] font-bold ${isWon ? 'border-emerald-500/50 text-emerald-400 bg-emerald-500/10' : 'border-red-500/50 text-red-400 bg-red-500/10'}`}>
                                  {isWon ? '✓ WON' : '✗ LOST'}
                                </Badge>
                              )}
                            </div>
                            <p className="text-[10px] text-muted-foreground font-mono mt-0.5">
                              {order.forecastDate
                                ? (() => {
                                    const ds = typeof order.forecastDate === 'string' && order.forecastDate.length >= 10 ? order.forecastDate.slice(0, 10) : '';
                                    if (!ds) return order.forecastDate;
                                    return new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                                  })()
                                : 'N/A'} · NWS: {order.nwsForecast}°F · Margin: {order.profitMargin.toFixed(2)}%
                              {order.actualTemp != null && <> · Actual: {order.actualTemp}°F{order.tempSource && <span className={`ml-1 text-[9px] px-1 py-0 rounded ${order.tempSource === 'NWS-CF6' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>{order.tempSource === 'NWS-CF6' ? 'NWS' : 'EST'}</span>}</>}
                              {order.winningBin && <> · Winner: {order.winningBin}</>}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <span className="text-[10px] text-muted-foreground">Cost</span>
                            <p className="text-sm font-mono font-bold">${costDollars.toFixed(2)}</p>
                          </div>
                          {isSettled && payoutDollars != null ? (
                            <>
                              <div className="text-right">
                                <span className="text-[10px] text-muted-foreground">Payout</span>
                                <p className={`text-sm font-mono font-bold ${isWon ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                                  ${payoutDollars.toFixed(2)}
                                </p>
                              </div>
                              <div className="text-right min-w-[70px]">
                                <span className="text-[10px] text-muted-foreground">P&L</span>
                                <p className={`text-sm font-mono font-bold ${(profitDollars ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {(profitDollars ?? 0) >= 0 ? '+' : ''}${(profitDollars ?? 0).toFixed(2)}
                                </p>
                              </div>
                            </>
                          ) : (
                            <div className="text-right">
                              <span className="text-[10px] text-muted-foreground">Expected</span>
                              <p className="text-sm font-mono font-bold text-blue-400">${order.expectedPayout.toFixed(2)}</p>
                            </div>
                          )}
                          <div className="text-right min-w-[60px]">
                            <span className="text-[10px] text-muted-foreground">Status</span>
                            <p className={`text-xs font-mono font-bold ${
                              order.status === 'filled' ? 'text-blue-400' :
                              order.status === 'failed' ? 'text-red-400' :
                              order.status === 'partial' ? 'text-amber-400' :
                              'text-muted-foreground'
                            }`}>
                              {order.status.toUpperCase()}
                            </p>
                          </div>
                        </div>
                      </div>
                      {/* Bin details with per-bin odds info */}
                      {bins.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-2 ml-11">
                          {bins.map((bin, i) => {
                            const isWinningBin = isSettled && order.winningBin && bin.range === order.winningBin;
                            return (
                              <span key={i} className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                                isWinningBin ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 font-bold' :
                                bin.fillStatus === 'failed' ? 'bg-red-500/5 border-red-500/20 text-red-400' :
                                bin.orderId ? 'bg-muted/30 border-border/30' :
                                'bg-muted/20 border-border/20 text-muted-foreground'
                              }`}>
                                {bin.range} @ {bin.price}¢ × {bin.count}
                                {isWinningBin && <> 🏆</>}
                                {bin.orderId && !isWinningBin && <> ✓</>}
                                {bin.fillStatus === 'failed' && <> ✗</>}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {order.errorMessage && (
                        <p className="text-[10px] text-red-400 mt-1 ml-11 font-mono">{order.errorMessage}</p>
                      )}
                      <p className="text-[10px] text-muted-foreground mt-1 ml-11">
                        {order.createdAt ? new Date(order.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : ''}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </FadeIn>
    </div>
  );
}

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatOdds, type OddsFormat } from '@/lib/odds-format';
import {
  Target,
  TrendingUp,
  DollarSign,
  Thermometer,
  RefreshCw,
  ArrowUpRight,
  ArrowDownRight,
  Clock,
  MapPin,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Filter,
  Copy,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import { FadeIn, Stagger, StaggerItem, HoverLift } from '@/components/ui/animate';
import Link from 'next/link';

interface Position {
  ticker: string;
  range: string;
  odds: number;
  stake: number;
  payout: number;
}

interface DutchBet {
  positions: Position[];
  totalStake: number;
  guaranteedReturn: number;
  profitMargin: number;
  isViable: boolean;
  rating: string;
  binCount?: number;
  forecastOffset?: number;
  isEdgeCase?: boolean;
  edgeCaseReason?: string;
}

interface Analysis {
  city: string;
  state: string;
  marketType: string;
  nwsForecast: number;
  forecastConfidence: string;
  forecastRetrievedAt: string;
  forecastTargetDate: string;
  eventTicker: string;
  expirationTime: string;
  allMarkets: any[];
  dutchBet: DutchBet;
}

export function DashboardContent() {
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);
  const [stake, setStake] = useState(10);
  const [filter, setFilter] = useState('all');
  const [sortBy, setSortBy] = useState('profit');
  const [marketTypeFilter, setMarketTypeFilter] = useState('all');
  const [oddsFormat, setOddsFormat] = useState<OddsFormat>('shares');

  // Load user's odds format preference
  useEffect(() => {
    fetch('/api/preferences')
      .then((r) => r?.json?.())
      .then((data) => {
        if (data?.oddsFormat) setOddsFormat(data.oddsFormat as OddsFormat);
      })
      .catch(() => {});
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/analysis?stake=${stake}`);
      const data = await res?.json?.();
      setAnalyses(data?.analyses ?? []);
      setSummary(data?.summary ?? null);
    } catch (error: any) {
      console.error('Fetch error:', error);
      toast.error('Failed to load analysis data');
    } finally {
      setLoading(false);
    }
  }, [stake]);

  const handleRefreshLive = useCallback(async () => {
    setRefreshing(true);
    setRefreshStatus('Pulling live data from Kalshi & NWS... (this takes ~30s to respect rate limits)');
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      const data = await res?.json?.();
      if (data?.success) {
        setRefreshStatus(data?.message ?? 'Refresh complete');
        toast.success(data?.message ?? 'Live data refreshed successfully');
        // Re-fetch analysis with new data
        await fetchData();
      } else {
        setRefreshStatus(null);
        toast.error(data?.error ?? 'Refresh failed');
      }
    } catch (error: any) {
      console.error('Refresh error:', error);
      setRefreshStatus(null);
      toast.error('Failed to pull live data');
    } finally {
      setRefreshing(false);
    }
  }, [fetchData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filteredAnalyses = (analyses ?? []).filter((a: Analysis) => {
    // Market type filter
    if (marketTypeFilter !== 'all' && a?.marketType !== marketTypeFilter) return false;
    // Rating filter — edge cases are excluded from viable/good/excellent
    if (filter === 'viable') return a?.dutchBet?.isViable && !a?.dutchBet?.isEdgeCase;
    if (filter === 'excellent') return a?.dutchBet?.rating === 'excellent' && !a?.dutchBet?.isEdgeCase;
    if (filter === 'good') return (a?.dutchBet?.rating === 'good' || a?.dutchBet?.rating === 'excellent') && !a?.dutchBet?.isEdgeCase;
    return true;
  });

  const sortedAnalyses = [...(filteredAnalyses ?? [])].sort((a: Analysis, b: Analysis) => {
    if (sortBy === 'profit') return (b?.dutchBet?.profitMargin ?? 0) - (a?.dutchBet?.profitMargin ?? 0);
    if (sortBy === 'city') return (a?.city ?? '').localeCompare(b?.city ?? '');
    if (sortBy === 'expiration') return new Date(a?.expirationTime ?? 0).getTime() - new Date(b?.expirationTime ?? 0).getTime();
    return 0;
  });

  const getRatingColor = (rating: string) => {
    if (rating === 'excellent') return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    if (rating === 'good') return 'text-blue-400 bg-blue-500/10 border-blue-500/20';
    if (rating === 'marginal') return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20';
    return 'text-slate-400 bg-slate-500/10 border-slate-500/20';
  };

  const getRatingIcon = (rating: string) => {
    if (rating === 'excellent' || rating === 'good') return <CheckCircle2 className="w-3.5 h-3.5" />;
    if (rating === 'marginal') return <AlertTriangle className="w-3.5 h-3.5" />;
    return <XCircle className="w-3.5 h-3.5" />;
  };

  const copyBetDetails = (a: Analysis) => {
    const details = (a?.dutchBet?.positions ?? []).map((p: Position, i: number) =>
      `Position ${i + 1}: ${p?.range ?? ''} | Stake: $${p?.stake?.toFixed?.(2) ?? '0.00'} | Odds: ${formatOdds(p?.odds ?? 0, oddsFormat)}`
    ).join('\n');
    const typeLabel = a?.marketType === 'low' ? 'Daily Low' : 'Daily High';
    const text = `${a?.city ?? ''}, ${a?.state ?? ''} (${typeLabel}) - NWS: ${a?.nwsForecast ?? 0}°F\n${details}\nTotal: $${a?.dutchBet?.totalStake ?? 0} | Return: $${a?.dutchBet?.guaranteedReturn?.toFixed?.(2) ?? '0.00'} (${a?.dutchBet?.profitMargin?.toFixed?.(2) ?? '0.00'}%)`;
    navigator?.clipboard?.writeText?.(text)?.then?.(() => toast.success('Bet details copied!'))?.catch?.(() => toast.error('Copy failed'));
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i: number) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i: number) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <FadeIn>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-display font-bold tracking-tight">Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">Real-time Dutch betting analysis for Kalshi climate markets</p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={handleRefreshLive} variant="default" size="sm" className="gap-2" disabled={refreshing}>
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Pulling...' : 'Pull Live Data'}
            </Button>
            <Button onClick={fetchData} variant="outline" size="sm" className="gap-2">
              <RefreshCw className="w-3.5 h-3.5" />
              Recalculate
            </Button>
          </div>
        </div>
      </FadeIn>

      {/* Refresh Status Banner */}
      {refreshStatus && (
        <FadeIn>
          <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-sm text-blue-400 flex items-center gap-2">
            {refreshing && <RefreshCw className="w-4 h-4 animate-spin" />}
            {!refreshing && <CheckCircle2 className="w-4 h-4" />}
            {refreshStatus}
          </div>
        </FadeIn>
      )}

      {/* Empty State */}
      {!loading && analyses.length === 0 && (
        <FadeIn>
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardContent className="p-8 text-center">
              <Thermometer className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-display font-semibold mb-2">No Market Data Yet</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Click <strong>"Pull Live Data"</strong> to fetch the latest Kalshi climate markets and NWS forecasts.
                Make sure you have configured your Kalshi API credentials in Settings first.
              </p>
              <Button onClick={handleRefreshLive} disabled={refreshing} className="gap-2">
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing ? 'Pulling Data...' : 'Pull Live Data Now'}
              </Button>
            </CardContent>
          </Card>
        </FadeIn>
      )}

      {/* Summary Cards */}
      <Stagger staggerDelay={0.1}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StaggerItem>
            <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Cities Tracked</p>
                    <p className="text-3xl font-bold font-mono mt-1">{summary?.totalCities ?? 0}</p>
                  </div>
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <MapPin className="w-5 h-5 text-blue-400" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </StaggerItem>
          <StaggerItem>
            <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Viable Opportunities</p>
                    <p className="text-3xl font-bold font-mono mt-1 text-emerald-400">{summary?.viableOpportunities ?? 0}</p>
                  </div>
                  <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                    <Target className="w-5 h-5 text-emerald-400" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </StaggerItem>
          <StaggerItem>
            <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Best Margin</p>
                    <p className={`text-3xl font-bold font-mono mt-1 ${(summary?.bestProfitMargin ?? 0) > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {(summary?.bestProfitMargin ?? 0) > 0 ? '+' : ''}{summary?.bestProfitMargin?.toFixed?.(2) ?? '0.00'}%
                    </p>
                  </div>
                  <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center">
                    <TrendingUp className="w-5 h-5 text-purple-400" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </StaggerItem>
          <StaggerItem>
            <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Avg Margin</p>
                    <p className={`text-3xl font-bold font-mono mt-1 ${(summary?.avgProfitMargin ?? 0) > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {(summary?.avgProfitMargin ?? 0) > 0 ? '+' : ''}{summary?.avgProfitMargin?.toFixed?.(2) ?? '0.00'}%
                    </p>
                  </div>
                  <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
                    <DollarSign className="w-5 h-5 text-amber-400" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </StaggerItem>
        </div>
      </Stagger>

      {/* Controls */}
      <FadeIn delay={0.2}>
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-muted-foreground" />
                <Select value={filter} onValueChange={setFilter}>
                  <SelectTrigger className="w-[160px] h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Markets</SelectItem>
                    <SelectItem value="viable">Viable Only</SelectItem>
                    <SelectItem value="good">Good & Better</SelectItem>
                    <SelectItem value="excellent">Excellent Only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Type:</span>
                <Select value={marketTypeFilter} onValueChange={setMarketTypeFilter}>
                  <SelectTrigger className="w-[130px] h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Temps</SelectItem>
                    <SelectItem value="high">Daily High</SelectItem>
                    <SelectItem value="low">Daily Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Sort:</span>
                <Select value={sortBy} onValueChange={setSortBy}>
                  <SelectTrigger className="w-[140px] h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="profit">Profit Margin</SelectItem>
                    <SelectItem value="city">City Name</SelectItem>
                    <SelectItem value="expiration">Expiration</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-muted-foreground" />
                <Input
                  type="number"
                  value={stake}
                  onChange={(e: any) => setStake(parseFloat(e?.target?.value ?? '10') || 10)}
                  className="w-24 h-9 text-sm"
                  min={1}
                  max={10000}
                />
                <span className="text-xs text-muted-foreground">stake</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </FadeIn>

      {/* City Cards */}
      {(sortedAnalyses?.length ?? 0) === 0 ? (
        <Card className="border-border/50 bg-card/50">
          <CardContent className="p-12 text-center">
            <Target className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium text-muted-foreground">No markets match your filters</p>
            <p className="text-sm text-muted-foreground/70 mt-1">Try adjusting your filter criteria</p>
          </CardContent>
        </Card>
      ) : (
        <Stagger staggerDelay={0.08}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {(sortedAnalyses ?? []).map((a: Analysis) => (
              <StaggerItem key={a?.city ?? Math.random()}>
                <HoverLift>
                  <Card className={`border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden ${
                    a?.dutchBet?.isEdgeCase ? 'ring-1 ring-amber-500/30 opacity-60'
                    : a?.dutchBet?.isViable ? 'ring-1 ring-emerald-500/20' : ''
                  }`}>
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500/20 to-emerald-500/20 flex items-center justify-center">
                            <Thermometer className="w-5 h-5 text-blue-400" />
                          </div>
                          <div>
                            <CardTitle className="text-lg font-display">{a?.city ?? 'Unknown'}, {a?.state ?? ''}</CardTitle>
                            <div className="flex items-center gap-2 mt-0.5">
                              <Badge variant="outline" className={`text-[9px] font-mono uppercase px-1.5 py-0 ${a?.marketType === 'low' ? 'border-cyan-500/30 text-cyan-400' : 'border-orange-500/30 text-orange-400'}`}>
                                {a?.marketType === 'low' ? '▼ Low' : '▲ High'}
                              </Badge>
                              <Clock className="w-3 h-3 text-muted-foreground" />
                              <span className="text-[10px] font-mono text-muted-foreground">
                                {a?.forecastTargetDate
                                  ? new Date(a.forecastTargetDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                                  : a?.expirationTime
                                    ? new Date(a.expirationTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                                    : 'N/A'}
                              </span>
                            </div>
                          </div>
                        </div>
                        <Badge className={`${getRatingColor(a?.dutchBet?.rating ?? 'none')} gap-1 text-[10px] uppercase font-mono`}>
                          {getRatingIcon(a?.dutchBet?.rating ?? 'none')}
                          {a?.dutchBet?.rating ?? 'none'}
                        </Badge>
                      </div>
                      {/* Edge case warning */}
                      {a?.dutchBet?.isEdgeCase && (
                        <div className="mt-2 p-2 rounded-md bg-amber-500/10 border border-amber-500/20 flex items-start gap-2">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                          <div>
                            <p className="text-[10px] font-semibold text-amber-400 uppercase">Unreliable — Do Not Bet</p>
                            <p className="text-[10px] text-amber-400/80">{a?.dutchBet?.edgeCaseReason}</p>
                          </div>
                        </div>
                      )}
                    </CardHeader>

                    <CardContent className="space-y-4">
                      {/* NWS Forecast */}
                      <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
                        <div className="flex items-center gap-2">
                          <Thermometer className="w-4 h-4 text-orange-400" />
                          <span className="text-sm font-medium">NWS Forecast</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-2xl font-bold font-mono">{a?.nwsForecast ?? 0}°F</span>
                          <Badge variant="outline" className="text-[9px] font-mono uppercase">
                            {a?.forecastConfidence ?? 'normal'}
                          </Badge>
                        </div>
                      </div>

                      {/* Positions */}
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Dutch Bet Positions</p>
                        {(a?.dutchBet?.positions ?? []).map((p: Position, i: number) => (
                          <div key={i} className="flex items-center justify-between p-2.5 rounded-lg bg-muted/20 hover:bg-muted/30 transition-colors">
                            <div className="flex items-center gap-2">
                              <div className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold font-mono ${
                                i === 1 ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-500/20 text-slate-400'
                              }`}>
                                {i + 1}
                              </div>
                              <div>
                                <span className="text-sm font-medium">{p?.range ?? ''}</span>
                                <p className="text-[10px] font-mono text-muted-foreground">{p?.ticker ?? ''}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-4">
                              <div className="text-right">
                                <span className="text-[10px] text-muted-foreground">Odds</span>
                                <p className="text-sm font-mono font-bold">{formatOdds(p?.odds ?? 0, oddsFormat)}</p>
                              </div>
                              <div className="text-right">
                                <span className="text-[10px] text-muted-foreground">Stake</span>
                                <p className="text-sm font-mono font-bold text-blue-400">${p?.stake?.toFixed?.(2) ?? '0.00'}</p>
                              </div>
                              <div className="text-right">
                                <span className="text-[10px] text-muted-foreground">Payout</span>
                                <p className="text-sm font-mono font-bold text-emerald-400">${p?.payout?.toFixed?.(2) ?? '0.00'}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Summary */}
                      <div className="flex items-center justify-between pt-3 border-t border-border/50">
                        <div className="flex items-center gap-4">
                          <div>
                            <span className="text-[10px] text-muted-foreground uppercase">Total</span>
                            <p className="text-sm font-mono font-bold">${a?.dutchBet?.totalStake?.toFixed?.(2) ?? '0.00'}</p>
                          </div>
                          <div>
                            <span className="text-[10px] text-muted-foreground uppercase">Return</span>
                            <p className={`text-sm font-mono font-bold ${(a?.dutchBet?.guaranteedReturn ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {(a?.dutchBet?.guaranteedReturn ?? 0) >= 0 ? '+' : ''}${a?.dutchBet?.guaranteedReturn?.toFixed?.(2) ?? '0.00'}
                            </p>
                          </div>
                          <div>
                            <span className="text-[10px] text-muted-foreground uppercase">Margin</span>
                            <p className={`text-sm font-mono font-bold flex items-center gap-1 ${(a?.dutchBet?.profitMargin ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {(a?.dutchBet?.profitMargin ?? 0) >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                              {a?.dutchBet?.profitMargin?.toFixed?.(2) ?? '0.00'}%
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="icon-sm" onClick={() => copyBetDetails(a)} title="Copy">
                            <Copy className="w-3.5 h-3.5" />
                          </Button>
                          <Link href={`/markets/${encodeURIComponent(a?.city ?? '')}`}>
                            <Button variant="ghost" size="icon-sm" title="Details">
                              <ExternalLink className="w-3.5 h-3.5" />
                            </Button>
                          </Link>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </HoverLift>
              </StaggerItem>
            ))}
          </div>
        </Stagger>
      )}
    </div>
  );
}
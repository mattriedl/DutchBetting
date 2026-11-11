'use client';

import { AutoRunStatus } from '@/components/auto-run-status';
import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { FadeIn, Stagger, StaggerItem } from '@/components/animations';
import {
  BadgeDollarSign,
  Loader2,
  Download,
  CheckCircle2,
  XCircle,
  Clock,
  Gauge,
  TrendingUp,
  TrendingDown,
  Wallet,
  Target,
  MinusCircle,
} from 'lucide-react';

interface ValuePick {
  id: string;
  league: string;
  matchKey: string;
  matchTitle: string;
  teamA: string;
  teamB: string;
  matchDate: string | null;
  market: string;
  selection: string;
  side: string;
  line: number | null;
  model: string;
  modelProb: number;
  odds: number;
  impliedProb: number;
  edge: number;
  evPerDollar: number;
  kalshiPrice: number | null;
  polyPrice: number | null;
  stakeCents: number;
  payoutIfWinCents: number;
  status: string;
  result: string | null;
  finalScore: string | null;
  finalDetail: string | null;
  netProfitCents: number | null;
  settledAt: string | null;
  createdAt: string;
}

interface GroupStat {
  key: string;
  settled: number;
  won: number;
  winRate: number | null;
  stakedCents: number;
  netProfitCents: number;
  roi: number | null;
}

interface ValueStats {
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
  expectedEvCents: number;
  byMarket: GroupStat[];
  byModel: GroupStat[];
}

const MARKET_LABEL: Record<string, string> = {
  ft_ou: 'Full-time O/U',
  ht_ou: '1st-half O/U',
  '2h_ou': '2nd-half O/U',
  btts: 'Both teams to score',
  ht_btts: '1st-half BTTS',
  '2h_btts': '2nd-half BTTS',
  corners_ou: 'Corners O/U',
  result: 'Match result (1X2)',
  double_chance: 'Double chance',
  dnb: 'Draw no bet',
  win_to_nil: 'Win to nil',
  clean_sheet: 'Clean sheet',
};

const MODEL_LABEL: Record<string, string> = {
  poisson_xg: 'Poisson xG',
  poisson_corners: 'Poisson corners',
};

function pct(x: number | null | undefined, digits = 1): string {
  if (x == null) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

function money(cents: number | null | undefined): string {
  if (cents == null) return '—';
  const v = cents / 100;
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function moneyPlain(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

export function ValueTrackerContent() {
  const [picks, setPicks] = useState<ValuePick[]>([]);
  const [stats, setStats] = useState<ValueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [settling, setSettling] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [marketFilter, setMarketFilter] = useState('all');
  const [modelFilter, setModelFilter] = useState('all');

  const load = useCallback(async (status: string, market: string, model: string) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (status !== 'all') qs.set('status', status);
      if (market !== 'all') qs.set('market', market);
      if (model !== 'all') qs.set('model', model);
      const res = await fetch(`/api/value-tracker/stats?${qs.toString()}`, { cache: 'no-store' });
      if (res.status === 401) {
        toast.error('Your session has expired — please sign in again.');
        window.location.href = `/login?callbackUrl=${encodeURIComponent('/value-tracker')}`;
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Failed to load');
      setPicks(data.picks ?? []);
      setStats(data.stats ?? null);
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to load value picks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(statusFilter, marketFilter, modelFilter);
  }, [load, statusFilter, marketFilter, modelFilter]);

  const run = async () => {
    setRunning(true);
    toast.info('Scanning every tradeable fixture for +EV value picks...');
    try {
      const res = await fetch('/api/value-tracker/run', { method: 'POST' });
      if (res.status === 401) {
        toast.error('Your session has expired — please sign in again.');
        window.location.href = `/login?callbackUrl=${encodeURIComponent('/value-tracker')}`;
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Run failed');
      const s = data.summary;
      if (s.needsKey) {
        toast.error('FootyStats API key missing — cannot scan fixtures.');
      } else {
        toast.success(
          `${s.matchesScanned} matches scanned · ${s.qualifying} value selections found · ${s.added} new picks, ${s.updated} refreshed.`,
        );
      }
      await load(statusFilter, marketFilter, modelFilter);
    } catch (err: any) {
      toast.error(err?.message ?? 'Run failed');
    } finally {
      setRunning(false);
    }
  };

  const settle = async () => {
    setSettling(true);
    try {
      const res = await fetch('/api/value-tracker/settle', { method: 'POST' });
      if (res.status === 401) {
        toast.error('Your session has expired — please sign in again.');
        window.location.href = `/login?callbackUrl=${encodeURIComponent('/value-tracker')}`;
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Settle failed');
      const s = data.summary;
      toast.success(
        `Graded ${s.settled} of ${s.checked} picks (${s.won} won, ${s.lost} lost, ${s.void} void${s.abandoned ? `, ${s.abandoned} abandoned` : ''}, ${s.stillOpen} still awaiting result).`,
      );
      await load(statusFilter, marketFilter, modelFilter);
    } catch (err: any) {
      toast.error(err?.message ?? 'Settle failed');
    } finally {
      setSettling(false);
    }
  };

  const netPositive = (stats?.netProfitCents ?? 0) >= 0;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center shadow-lg shadow-teal-500/20">
              <BadgeDollarSign className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold tracking-tight">Value Tracker</h1>
              <p className="text-sm text-muted-foreground max-w-2xl">
                For every upcoming match in your FootyStats leagues we price each tradeable market against its bookmaker odds —
                using a Poisson model built from pre-match expected goals (xG) and expected corner counts, then
                <span className="text-foreground font-medium"> calibrated by shrinking toward the de-vigged market price</span>
                to remove the model's overconfidence. We record a flat $10 demo wager only where a pick clears
                <span className="text-foreground font-medium"> +8% calibrated EV, 50% probability and odds between 1.35 and 3.3</span>
                (low-value markets like double chance are excluded). Every pick is graded against the real result. Paper only —
                nothing here places a real order.
              </p>
              <AutoRunStatus runJob="value-run" settleJob="value-settle" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={run} disabled={running} className="gap-2">
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {running ? 'Scanning...' : 'Find value picks'}
            </Button>
            <Button onClick={settle} disabled={settling} variant="outline" className="gap-2">
              {settling ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Grade finished
            </Button>
          </div>
        </div>
      </FadeIn>

      {/* Headline stat cards */}
      <FadeIn>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Wallet className="w-3.5 h-3.5" /> Net profit
              </div>
              <p className={`text-2xl font-bold font-mono ${netPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                {money(stats?.netProfitCents)}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                ROI {stats?.roi != null ? `${(stats.roi * 100).toFixed(1)}%` : '—'} on {moneyPlain(stats?.stakedCents)} staked
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Target className="w-3.5 h-3.5" /> Win rate
              </div>
              <p className="text-2xl font-bold font-mono">{pct(stats?.winRate)}</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {stats?.won ?? 0}W · {stats?.lost ?? 0}L{(stats?.voided ?? 0) > 0 ? ` · ${stats?.voided}V` : ''} of {stats?.settled ?? 0} graded
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Clock className="w-3.5 h-3.5" /> Open picks
              </div>
              <p className="text-2xl font-bold font-mono">{stats?.open ?? 0}</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {moneyPlain(stats?.openStakeCents)} at risk · {money(stats?.expectedEvCents)} expected
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Gauge className="w-3.5 h-3.5" /> Calibration
              </div>
              <p className="text-2xl font-bold font-mono">{stats?.brier != null ? stats.brier.toFixed(4) : '—'}</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Brier · avg model prob {pct(stats?.meanModelProb)}
              </p>
            </CardContent>
          </Card>
        </div>
      </FadeIn>

      {/* Breakdown by market + model */}
      <FadeIn>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Performance by market</CardTitle>
            </CardHeader>
            <CardContent>
              {!stats || stats.byMarket.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4">No graded picks yet.</p>
              ) : (
                <div className="space-y-2">
                  {stats.byMarket.map(g => (
                    <div key={g.key} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                      <span className="text-sm font-medium">{MARKET_LABEL[g.key] ?? g.key}</span>
                      <div className="flex flex-wrap items-center gap-4 text-xs font-mono">
                        <span className="text-muted-foreground">{g.won}/{g.settled} · {pct(g.winRate)}</span>
                        <span className={g.netProfitCents >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{money(g.netProfitCents)}</span>
                        <span className={g.roi != null && g.roi >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                          {g.roi != null ? `${(g.roi * 100).toFixed(0)}% ROI` : '—'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Performance by model</CardTitle>
            </CardHeader>
            <CardContent>
              {!stats || stats.byModel.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4">No graded picks yet.</p>
              ) : (
                <div className="space-y-2">
                  {stats.byModel.map(g => (
                    <div key={g.key} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                      <span className="text-sm font-medium">{MODEL_LABEL[g.key] ?? g.key}</span>
                      <div className="flex flex-wrap items-center gap-4 text-xs font-mono">
                        <span className="text-muted-foreground">{g.won}/{g.settled} · {pct(g.winRate)}</span>
                        <span className={g.netProfitCents >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{money(g.netProfitCents)}</span>
                        <span className={g.roi != null && g.roi >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                          {g.roi != null ? `${(g.roi * 100).toFixed(0)}% ROI` : '—'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </FadeIn>

      {/* Picks list */}
      <FadeIn>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 pb-3 flex-wrap">
            <CardTitle className="text-sm">Demo picks</CardTitle>
            <div className="flex gap-2 flex-wrap">
              <Select value={marketFilter} onValueChange={setMarketFilter}>
                <SelectTrigger className="w-[170px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All markets</SelectItem>
                  {Object.entries(MARKET_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={modelFilter} onValueChange={setModelFilter}>
                <SelectTrigger className="w-[150px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All models</SelectItem>
                  {Object.entries(MODEL_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[130px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="settled">Graded</SelectItem>
                  <SelectItem value="void">Void</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading...
              </div>
            ) : picks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-12 text-center">
                No value picks yet — hit <span className="font-medium text-foreground">Find value picks</span> to scan today&apos;s fixtures.
              </p>
            ) : (
              <Stagger className="space-y-2">
                {picks.map(p => {
                  const settled = p.status === 'settled' || p.status === 'void';
                  const won = p.result === 'won';
                  const voided = p.result === 'void' || p.status === 'void';
                  return (
                    <StaggerItem key={p.id}>
                      <div
                        className={`rounded-lg border p-3 ${
                          settled
                            ? voided
                              ? 'border-border bg-muted/30'
                              : won
                                ? 'border-emerald-500/30 bg-emerald-500/5'
                                : 'border-rose-500/30 bg-rose-500/5'
                            : 'border-border'
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              {settled ? (
                                voided ? (
                                  <MinusCircle className="w-4 h-4 text-muted-foreground shrink-0" />
                                ) : won ? (
                                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                                ) : (
                                  <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                                )
                              ) : (
                                <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
                              )}
                              <span className="text-sm font-medium">{p.matchTitle}</span>
                              <Badge variant="outline" className="border-teal-500/40 text-teal-300 text-[10px]">
                                {MARKET_LABEL[p.market] ?? p.market}
                              </Badge>
                              <Badge variant="outline" className="border-cyan-500/40 text-cyan-300 text-[10px]">
                                {MODEL_LABEL[p.model] ?? p.model}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              <span className="text-foreground font-medium">{p.selection}</span>
                              {' @ '}<span className="font-mono text-foreground">{p.odds.toFixed(2)}</span>
                              {' · model '}<span className="font-mono">{pct(p.modelProb, 0)}</span>
                              {' vs implied '}<span className="font-mono">{pct(p.impliedProb, 0)}</span>
                              {p.matchDate ? ` · ${p.matchDate.slice(0, 10)}` : ''}
                            </p>
                            <div className="flex flex-wrap items-center gap-2 mt-1">
                              <Badge variant="outline" className="border-emerald-500/40 text-emerald-300 text-[10px]">
                                +{(p.evPerDollar * 100).toFixed(1)}% EV
                              </Badge>
                              {p.kalshiPrice != null && (
                                <span className="text-[10px] text-violet-300 font-mono">Kalshi {p.kalshiPrice}¢</span>
                              )}
                              {p.polyPrice != null && (
                                <span className="text-[10px] text-indigo-300 font-mono">Poly {p.polyPrice}¢</span>
                              )}
                              {settled && p.finalScore && (
                                <span className="text-[10px] text-muted-foreground font-mono">
                                  FT {p.finalScore}{p.finalDetail ? ` (${p.finalDetail})` : ''}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="text-xs font-mono text-right shrink-0">
                            {settled ? (
                              <>
                                <p
                                  className={
                                    voided
                                      ? 'text-muted-foreground font-semibold flex items-center gap-1 justify-end'
                                      : won
                                        ? 'text-emerald-400 font-semibold flex items-center gap-1 justify-end'
                                        : 'text-rose-400 font-semibold flex items-center gap-1 justify-end'
                                  }
                                >
                                  {voided ? 'void' : won ? <><TrendingUp className="w-3 h-3" /> won</> : <><TrendingDown className="w-3 h-3" /> lost</>}
                                </p>
                                <p className={p.netProfitCents != null && p.netProfitCents >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                  {money(p.netProfitCents)}
                                </p>
                              </>
                            ) : (
                              <>
                                <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">
                                  ${(p.stakeCents / 100).toFixed(0)} staked
                                </Badge>
                                <p className="text-muted-foreground mt-1">win {moneyPlain(p.payoutIfWinCents)}</p>
                              </>
                            )}
                          </div>
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
    </div>
  );
}

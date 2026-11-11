'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { FadeIn, Stagger, StaggerItem } from '@/components/animations';
import {
  BrainCircuit,
  Loader2,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  TrendingUp,
  TrendingDown,
  Target,
  Gauge,
  DollarSign,
} from 'lucide-react';

interface ShadowPick {
  id: string;
  runId: string;
  app: string;
  source: string;
  league: string;
  matchTitle: string;
  matchDate: string | null;
  marketType: string;
  line: number | null;
  side: string;
  pickLabel: string;
  entryPrice: number;
  rawModelProb: number | null;
  modelProb: number;
  edgeCents: number;
  evPerContract: number;
  expectedTotalGoals: number | null;
  rating: string;
  contracts: number;
  stakeCents: number;
  payoutIfWinCents: number;
  researchNote: string | null;
  status: string;
  settledResult: string | null;
  finalScore: string | null;
  finalGoals: number | null;
  netProfitCents: number | null;
  createdAt: string;
}

interface ShadowStats {
  open: number;
  settled: number;
  won: number;
  lost: number;
  winRate: number | null;
  stakedCents: number;
  netProfitCents: number;
  roi: number | null;
  brier: number | null;
  meanStatedProb: number | null;
  expectedEvCents: number;
  byApp: {
    app: string;
    settled: number;
    won: number;
    winRate: number | null;
    stakedCents: number;
    netProfitCents: number;
    roi: number | null;
  }[];
}

const APP_LABEL: Record<string, string> = {
  goals: 'Kalshi Goals',
  polymarket_goals: 'Polymarket Goals',
};

function money(cents: number | null | undefined): string {
  const c = cents ?? 0;
  return `${c < 0 ? '-' : ''}$${Math.abs(c / 100).toFixed(2)}`;
}

function pct(x: number | null | undefined, digits = 1): string {
  if (x == null) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

export function AiTrackerContent() {
  const [picks, setPicks] = useState<ShadowPick[]>([]);
  const [stats, setStats] = useState<ShadowStats | null>(null);
  const [config, setConfig] = useState<{
    stakeDollars: number; minEdgeCents: number; minProb: number;
    autoRun?: string | null;
    lastRun?: { at: string; automated: boolean; matchesScanned: number; researched: number; picksRecorded: number; skippedNoEdge: number; errors: number } | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [settling, setSettling] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (status: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/shadow?status=${status}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Failed to load');
      setPicks(data.picks ?? []);
      setStats(data.stats ?? null);
      setConfig(data.config ?? null);
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to load AI tracker');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(statusFilter);
  }, [load, statusFilter]);

  const runAnalysis = async () => {
    setRunning(true);
    toast.info('Running autonomous analysis — this takes a couple of minutes.');
    try {
      const res = await fetch('/api/shadow/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 8 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Run failed');
      const s = data.summary;
      toast.success(
        `Scanned ${s.matchesScanned} matches, researched ${s.researched} — ${s.picksRecorded} new picks, ${s.skippedNoEdge} skipped for no edge.`,
      );
      await load(statusFilter);
    } catch (err: any) {
      toast.error(err?.message ?? 'Run failed');
    } finally {
      setRunning(false);
    }
  };

  const settle = async () => {
    setSettling(true);
    try {
      const res = await fetch('/api/shadow/settle', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Settle failed');
      const s = data.summary;
      toast.success(`Graded ${s.settled} of ${s.checked} finished picks (${s.won} won, ${s.unresolved} still unresolved).`);
      await load(statusFilter);
    } catch (err: any) {
      toast.error(err?.message ?? 'Settle failed');
    } finally {
      setSettling(false);
    }
  };

  const roiPositive = (stats?.roi ?? 0) >= 0;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <BrainCircuit className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold tracking-tight">AI Tracker</h1>
              <p className="text-sm text-muted-foreground max-w-2xl">
                The analysis engine picks its own best positive-EV bet on every tradeable match, with nobody in the loop, and
                logs it in demo mode at a flat {config ? `$${config.stakeDollars}` : '$10'} stake. No orders are ever sent —
                this is a clean, selection-bias-free record of whether the AI&apos;s best reads actually win.
              </p>
              {(config?.autoRun || config?.lastRun) && (
                <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {config?.autoRun && (
                    <Badge variant="outline" className="font-mono text-[10px]">Auto-runs {config.autoRun}</Badge>
                  )}
                  {config?.lastRun ? (
                    <span>
                      Last {config.lastRun.automated ? 'scheduled' : 'manual'} run{' '}
                      {new Date(config.lastRun.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      {' '}— researched {config.lastRun.researched}, new picks {config.lastRun.picksRecorded}, no edge {config.lastRun.skippedNoEdge}
                      {config.lastRun.errors > 0 ? `, errors ${config.lastRun.errors}` : ''}
                    </span>
                  ) : (
                    <span>No run yet since the last restart.</span>
                  )}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={runAnalysis} disabled={running} className="gap-2">
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {running ? 'Analyzing…' : 'Run analysis'}
            </Button>
            <Button onClick={settle} disabled={settling} variant="outline" className="gap-2">
              {settling ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Grade finished
            </Button>
          </div>
        </div>
      </FadeIn>

      {stats && (
        <FadeIn>
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <Card>
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  <Clock className="w-3.5 h-3.5" /> Open
                </div>
                <p className="text-2xl font-bold font-mono">{stats.open}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  <Target className="w-3.5 h-3.5" /> Graded
                </div>
                <p className="text-2xl font-bold font-mono">{stats.settled}</p>
                <p className="text-[11px] text-muted-foreground">
                  {stats.won}W / {stats.lost}L
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  <Gauge className="w-3.5 h-3.5" /> Win rate
                </div>
                <p className="text-2xl font-bold font-mono">{pct(stats.winRate)}</p>
                {stats.meanStatedProb != null && (
                  <p className="text-[11px] text-muted-foreground">model said {pct(stats.meanStatedProb)}</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  <DollarSign className="w-3.5 h-3.5" /> Net P&amp;L
                </div>
                <p className={`text-2xl font-bold font-mono ${roiPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {money(stats.netProfitCents)}
                </p>
                <p className="text-[11px] text-muted-foreground">on {money(stats.stakedCents)} staked</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  {roiPositive ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />} ROI
                </div>
                <p className={`text-2xl font-bold font-mono ${roiPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {pct(stats.roi, 2)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  <Gauge className="w-3.5 h-3.5" /> Brier
                </div>
                <p className="text-2xl font-bold font-mono">{stats.brier != null ? stats.brier.toFixed(4) : '—'}</p>
                <p className="text-[11px] text-muted-foreground">lower is sharper</p>
              </CardContent>
            </Card>
          </div>
        </FadeIn>
      )}

      {stats && stats.byApp.length > 0 && (
        <FadeIn>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Results by market</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {stats.byApp.map(a => (
                <div key={a.app} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                  <span className="text-sm font-medium">{APP_LABEL[a.app] ?? a.app}</span>
                  <div className="flex flex-wrap items-center gap-4 text-xs font-mono">
                    <span className="text-muted-foreground">{a.settled} graded</span>
                    <span>{pct(a.winRate)} win</span>
                    <span className={(a.netProfitCents ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {money(a.netProfitCents)}
                    </span>
                    <span className={(a.roi ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{pct(a.roi, 2)} ROI</span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </FadeIn>
      )}

      <FadeIn>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 pb-3">
            <CardTitle className="text-sm">Shadow picks</CardTitle>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[150px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All picks</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="settled">Graded</SelectItem>
              </SelectContent>
            </Select>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : picks.length === 0 ? (
              <div className="py-12 text-center space-y-2">
                <p className="text-sm text-muted-foreground">No shadow picks yet.</p>
                <p className="text-xs text-muted-foreground">
                  {config?.autoRun ? `It runs on its own ${config.autoRun}, or hit ` : 'Hit '}<span className="font-medium text-foreground">Run analysis</span> — the engine will scan every tradeable
                  match, research it, and record the single best positive-EV bet it finds on each one.
                </p>
              </div>
            ) : (
              <Stagger className="space-y-2">
                {picks.map(p => {
                  const won = p.settledResult === 'won';
                  const isSettled = p.status === 'settled';
                  return (
                    <StaggerItem key={p.id}>
                      <div
                        className={`rounded-lg border p-3 transition-colors cursor-pointer hover:bg-muted/40 ${
                          isSettled
                            ? won
                              ? 'border-emerald-500/30 bg-emerald-500/5'
                              : 'border-rose-500/30 bg-rose-500/5'
                            : 'border-border'
                        }`}
                        onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              {isSettled ? (
                                won ? (
                                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                                ) : (
                                  <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                                )
                              ) : (
                                <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
                              )}
                              <span className="text-sm font-medium">{p.matchTitle}</span>
                              <Badge
                                variant="outline"
                                className={
                                  p.source === 'polymarket'
                                    ? 'border-indigo-500/40 text-indigo-300 text-[10px]'
                                    : 'border-violet-500/40 text-violet-300 text-[10px]'
                                }
                              >
                                {p.source === 'polymarket' ? 'Polymarket' : 'Kalshi'}
                              </Badge>
                              <span className="text-[11px] text-muted-foreground font-mono">{p.league}</span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              <span className="text-foreground font-medium">{p.pickLabel}</span> @ {p.entryPrice}¢ ·{' '}
                              {p.contracts} contracts · {money(p.stakeCents)} staked
                              {p.matchDate ? ` · ${p.matchDate.slice(0, 10)}` : ''}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
                            <span className="text-cyan-300">{pct(p.modelProb, 0)} model</span>
                            {p.rawModelProb != null && (
                              <span className="text-muted-foreground">(raw {pct(p.rawModelProb, 0)})</span>
                            )}
                            <span className="text-emerald-300">+{p.edgeCents.toFixed(1)}¢ edge</span>
                            {isSettled ? (
                              <span className={won ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                                {money(p.netProfitCents)}
                                {p.finalScore ? ` · ${p.finalScore}` : ''}
                              </span>
                            ) : (
                              <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">
                                open
                              </Badge>
                            )}
                          </div>
                        </div>
                        {expanded === p.id && p.researchNote && (
                          <div className="mt-3 pt-3 border-t border-border/60 space-y-2">
                            {p.expectedTotalGoals != null && (
                              <p className="text-[11px] text-muted-foreground font-mono">
                                expected total goals {p.expectedTotalGoals.toFixed(2)} · EV {p.evPerContract.toFixed(1)}¢ per
                                contract · rating {p.rating}
                              </p>
                            )}
                            <p className="text-xs text-muted-foreground whitespace-pre-line leading-relaxed">
                              {p.researchNote}
                            </p>
                          </div>
                        )}
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

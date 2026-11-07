'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import {
  FlaskConical, Play, RotateCcw, TrendingUp, TrendingDown,
  Target, DollarSign, BarChart3, CheckCircle2, XCircle,
  Loader2, AlertTriangle, Info, ShieldAlert, Zap, Radio, RefreshCw,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  Tooltip, Legend, CartesianGrid,
} from 'recharts';
import { FadeIn, Stagger, StaggerItem } from '@/components/animations';

type Phase = 'idle' | 'collecting' | 'enriching' | 'analyzing' | 'done' | 'error';

interface StrategyStats {
  totalEvents: number;
  wins: number; losses: number; winRate: number;
  avgCostBid: number; avgCostAsk: number;
  avgProfitBid: number; avgProfitAsk: number;
  avgReturnPctBid: number; avgReturnPctAsk: number;
  cumulativePnlBid: number; cumulativePnlAsk: number;
  pnlCurve: { date: string; pnlBid: number; pnlAsk: number; eventNum: number }[];
}

interface CityStats {
  city: string; totalEvents: number; wins: number; winRate: number;
  avgCostBid: number; avgCostAsk: number;
  avgProfitBid: number; avgProfitAsk: number;
  roiBid: number; roiAsk: number;
}

interface SimLevel {
  sigma: number; label: string;
  totalEvents: number; expectedWins: number; expectedLosses: number; winRate: number;
  expectedPnlBid: number; expectedPnlAsk: number;
  pnlCurve: { date: string; pnlBid: number; pnlAsk: number; eventNum: number }[];
  cityResults: {
    city: string; events: number; expectedWins: number; expectedLosses: number;
    winRate: number; pnlBid: number; pnlAsk: number; avgCost: number; breakevenWinRate: number;
  }[];
}

interface BacktestData {
  strategyStats: Record<string, StrategyStats>;
  cityStats: CityStats[];
  totalHistoricalEvents: number;
  enrichedEvents: number;
  realisticSimulation?: Record<string, SimLevel>;
  sampleEvent?: { ticker: string; city: string; bins: any[] };
}

const STRATEGY_LABELS: Record<string, string> = {
  perfect: 'Perfect NWS',
  'nws_off_+1': 'NWS +1 bin (±2°F)',
  'nws_off_-1': 'NWS -1 bin (±2°F)',
  'nws_off_+2': 'NWS +2 bins (±4°F)',
  'nws_off_-2': 'NWS -2 bins (±4°F)',
};

interface TrackerData {
  summary: {
    total: number; settled: number; pending: number;
    wins: number; losses: number; winRate: number;
    totalPnlBid: number; totalPnlAsk: number;
  };
  cityStats: { city: string; total: number; wins: number; losses: number; winRate: number; pnlBid: number }[];
  tracks: {
    id: string; city: string; marketType: string; eventTicker: string; forecastDate: string;
    nwsForecast: number; centerBin: string; selectedBins: any[];
    totalCostBid: number; totalCostAsk: number;
    settled: boolean; winningBin: string | null; won: boolean | null;
    profitBid: number | null; profitAsk: number | null;
    settledAt: string | null; createdAt: string;
  }[];
}

export function BacktestContent() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [data, setData] = useState<BacktestData | null>(null);
  const [tracker, setTracker] = useState<TrackerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingSettlements, setCheckingSettlements] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, detail: '' });
  const [selectedSigma, setSelectedSigma] = useState('sigma_2.5');
  const abortRef = useRef(false);

  useEffect(() => { fetchResults(); fetchTracker(); }, []);

  const fetchTracker = async () => {
    try {
      const res = await fetch('/api/tracker');
      const json = await res.json();
      if (json?.summary) setTracker(json);
    } catch (err) { console.error('Tracker fetch error:', err); }
  };

  const checkSettlements = async () => {
    setCheckingSettlements(true);
    try {
      const res = await fetch('/api/tracker', { method: 'POST' });
      const json = await res.json();
      if (json?.resolved > 0) {
        toast.success(`Resolved ${json.resolved} bet(s)`);
        await fetchTracker();
      } else {
        toast.info('No new settlements found');
      }
    } catch (err: any) { toast.error(`Settlement check failed: ${err?.message}`); }
    finally { setCheckingSettlements(false); }
  };

  const fetchResults = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/backtest');
      const json = await res.json();
      if (json?.strategyStats && Object.keys(json.strategyStats).length > 0) {
        setData(json);
        setPhase('done');
      } else {
        setData(null);
        setPhase('idle');
      }
    } catch (err) {
      console.error('Failed to fetch backtest results:', err);
    } finally {
      setLoading(false);
    }
  };

  const runBacktest = useCallback(async () => {
    abortRef.current = false;
    setData(null);

    // Phase 1: Collect
    setPhase('collecting');
    setProgress({ current: 0, total: 5, detail: 'Collecting settled events from Kalshi...' });
    try {
      const r = await fetch('/api/backtest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'collect', maxEvents: 50 }),
      });
      const d = await r.json();
      if (d?.error) throw new Error(d.error);
      setProgress(p => ({ ...p, current: 1, detail: `${d.totalInDb} events collected. Fetching trade prices...` }));
    } catch (err: any) { setPhase('error'); toast.error(`Collection failed: ${err?.message}`); return; }
    if (abortRef.current) return;

    // Phase 2: Enrich
    setPhase('enriching');
    let enrichDone = false, loops = 0;
    while (!enrichDone && !abortRef.current && loops < 100) {
      try {
        const r = await fetch('/api/backtest', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'enrich', batchSize: 8 }),
        });
        const d = await r.json();
        if (d?.error) throw new Error(d.error);
        const processed = d.total - d.remaining;
        setProgress({ current: processed, total: d.total, detail: `Fetching trade prices: ${processed}/${d.total} events` });
        enrichDone = d.done;
        loops++;
      } catch (err: any) {
        if (err?.message?.includes?.('429')) {
          setProgress(p => ({ ...p, detail: 'Rate limited, waiting 5s...' }));
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        setPhase('error'); toast.error(`Enrichment failed: ${err?.message}`); return;
      }
    }
    if (abortRef.current) return;

    // Phase 3: Analyze
    setPhase('analyzing');
    setProgress(p => ({ ...p, detail: 'Running strategy analysis...' }));
    try {
      const r = await fetch('/api/backtest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze' }),
      });
      const d = await r.json();
      if (d?.error) throw new Error(d.error);
      toast.success(`Analyzed ${d.totalEvents} events`);
    } catch (err: any) { setPhase('error'); toast.error(`Analysis failed: ${err?.message}`); return; }

    setPhase('done');
    await fetchResults();
  }, []);

  const handleReset = async () => {
    if (!confirm('Clear all data and re-run from scratch?')) return;
    await fetch('/api/backtest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset' }) });
    setData(null); setPhase('idle'); toast.success('Reset complete');
  };

  const sim = data?.realisticSimulation;
  const activeSim = sim?.[selectedSigma] as SimLevel | undefined;
  const perfect = data?.strategyStats?.perfect;

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Historical Backtester</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-32" />)}
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <FadeIn>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <FlaskConical className="h-6 w-6 text-purple-500" />
              Historical Backtester
            </h2>
            <p className="text-muted-foreground mt-1">
              {data ? `${data.totalHistoricalEvents} settled events analyzed with real trade prices & NWS accuracy modeling` : 'Test your Dutch betting strategy against historical Kalshi data'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {phase === 'done' && data && (
              <Button variant="outline" size="sm" onClick={handleReset}>
                <RotateCcw className="h-4 w-4 mr-1" /> Reset
              </Button>
            )}
            <Button onClick={runBacktest}
              disabled={phase === 'collecting' || phase === 'enriching' || phase === 'analyzing'}
              className="bg-purple-600 hover:bg-purple-700">
              {phase === 'collecting' || phase === 'enriching' || phase === 'analyzing'
                ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Running...</>
                : <><Play className="h-4 w-4 mr-1" /> Run Backtest</>}
            </Button>
          </div>
        </div>
      </FadeIn>

      {/* Progress */}
      {(phase === 'collecting' || phase === 'enriching' || phase === 'analyzing') && (
        <Card className="border-purple-500/30 bg-purple-500/5">
          <CardContent className="pt-6">
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin text-purple-500" />
                <div className="flex-1">
                  <div className="flex justify-between mb-1">
                    <span className="font-medium text-sm">
                      {phase === 'collecting' && 'Phase 1/3: Collecting Events'}
                      {phase === 'enriching' && 'Phase 2/3: Fetching Real Trade Prices'}
                      {phase === 'analyzing' && 'Phase 3/3: Running Analysis'}
                    </span>
                    {progress.total > 0 && <span className="text-xs text-muted-foreground">{progress.current}/{progress.total}</span>}
                  </div>
                  {progress.total > 0 && (
                    <div className="w-full bg-muted rounded-full h-2">
                      <div className="bg-purple-500 h-2 rounded-full transition-all duration-500"
                        style={{ width: `${Math.min(100, (progress.current / progress.total) * 100)}%` }} />
                    </div>
                  )}
                </div>
              </div>
              <p className="text-sm text-muted-foreground">{progress.detail}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {phase === 'error' && (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-red-500">
              <AlertTriangle className="h-5 w-5" />
              <span>Backtest encountered an error. Try running again.</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ===== LIVE FORWARD TRACKER ===== */}
      <FadeIn>
        <Card className="border-2 border-emerald-500/40 bg-gradient-to-br from-emerald-500/5 to-teal-500/5">
          <CardHeader>
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <Radio className="h-5 w-5 text-emerald-500" />
                  Live Forward Tracker
                </CardTitle>
                <CardDescription className="text-base mt-1">
                  Real picks recorded every time you refresh Dashboard data — tracked against actual Kalshi settlements
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={checkSettlements}
                disabled={checkingSettlements || !tracker || tracker.summary.pending === 0}
                className="border-emerald-500/30 hover:bg-emerald-500/10"
              >
                {checkingSettlements
                  ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Checking...</>
                  : <><RefreshCw className="h-4 w-4 mr-1" /> Check Settlements</>}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {!tracker || tracker.summary.total === 0 ? (
              <div className="text-center py-8">
                <Radio className="h-10 w-10 mx-auto text-muted-foreground mb-3 opacity-50" />
                <p className="text-muted-foreground mb-2">No bets tracked yet</p>
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  Go to the <strong>Dashboard</strong> and click <strong>Recalculate</strong> to refresh live data.
                  Each refresh automatically records your Dutch bet picks for forward tracking.
                </p>
              </div>
            ) : (
              <>
                {/* Scoreboard */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  <div className="bg-background/60 rounded-lg p-3 text-center border border-border/50">
                    <div className="text-2xl font-bold font-mono">{tracker.summary.total}</div>
                    <div className="text-xs text-muted-foreground">Total Bets</div>
                  </div>
                  <div className="bg-background/60 rounded-lg p-3 text-center border border-border/50">
                    <div className="text-2xl font-bold font-mono text-yellow-500">{tracker.summary.pending}</div>
                    <div className="text-xs text-muted-foreground">Pending</div>
                  </div>
                  <div className="bg-background/60 rounded-lg p-3 text-center border border-border/50">
                    <div className="text-2xl font-bold font-mono text-emerald-500">{tracker.summary.wins}</div>
                    <div className="text-xs text-muted-foreground">Wins</div>
                  </div>
                  <div className="bg-background/60 rounded-lg p-3 text-center border border-border/50">
                    <div className="text-2xl font-bold font-mono text-red-500">{tracker.summary.losses}</div>
                    <div className="text-xs text-muted-foreground">Losses</div>
                  </div>
                  <div className="bg-background/60 rounded-lg p-3 text-center border border-border/50">
                    <div className="text-2xl font-bold font-mono">{tracker.summary.settled > 0 ? `${tracker.summary.winRate}%` : '—'}</div>
                    <div className="text-xs text-muted-foreground">Win Rate</div>
                  </div>
                  <div className="bg-background/60 rounded-lg p-3 text-center border border-border/50">
                    <div className={`text-2xl font-bold font-mono ${
                      tracker.summary.totalPnlBid >= 0 ? 'text-emerald-500' : 'text-red-500'
                    }`}>
                      {tracker.summary.settled > 0
                        ? `${tracker.summary.totalPnlBid >= 0 ? '+' : ''}$${tracker.summary.totalPnlBid.toFixed(2)}`
                        : '—'}
                    </div>
                    <div className="text-xs text-muted-foreground">P&L (Bid)</div>
                  </div>
                </div>

                {/* City Breakdown */}
                {tracker.cityStats.length > 0 && tracker.summary.settled > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-muted-foreground mb-3">Per-City Results</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                      {tracker.cityStats.map(c => (
                        <div key={c.city} className={`flex items-center justify-between p-2.5 rounded-lg border ${
                          c.pnlBid >= 0 ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'
                        }`}>
                          <div>
                            <span className="font-medium text-sm">{c.city}</span>
                            <span className="text-xs text-muted-foreground ml-2">
                              {c.wins}W-{c.losses}L ({c.total} total)
                            </span>
                          </div>
                          <span className={`font-mono text-sm font-semibold ${c.pnlBid >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                            {c.pnlBid >= 0 ? '+' : ''}${c.pnlBid.toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Bet History Table */}
                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground mb-3">
                    Bet History ({tracker.tracks.length})
                  </h4>
                  <div className="overflow-x-auto rounded-lg border border-border/50">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/30 border-b border-border/50">
                          <th className="text-left py-2.5 px-3 font-medium">Date</th>
                          <th className="text-left py-2.5 px-3 font-medium">City</th>
                          <th className="text-center py-2.5 px-3 font-medium">Type</th>
                          <th className="text-right py-2.5 px-3 font-medium">NWS °F</th>
                          <th className="text-left py-2.5 px-3 font-medium">Center Bin</th>
                          <th className="text-right py-2.5 px-3 font-medium">Cost</th>
                          <th className="text-center py-2.5 px-3 font-medium">Result</th>
                          <th className="text-right py-2.5 px-3 font-medium">P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tracker.tracks.slice(0, 50).map(t => (
                          <tr key={t.id} className="border-b border-border/30 hover:bg-muted/20">
                            <td className="py-2 px-3 font-mono text-xs">
                              {new Date(t.forecastDate || t.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
                            </td>
                            <td className="py-2 px-3">{t.city}</td>
                            <td className="py-2 px-3 text-center">
                              <Badge variant="secondary" className={`text-xs ${t.marketType === 'LOW' ? 'bg-blue-500/20 text-blue-400' : 'bg-orange-500/20 text-orange-400'}`}>
                                {t.marketType || 'HIGH'}
                              </Badge>
                            </td>
                            <td className="py-2 px-3 text-right font-mono">{t.nwsForecast}°</td>
                            <td className="py-2 px-3 text-xs">{t.centerBin}</td>
                            <td className="py-2 px-3 text-right font-mono">${t.totalCostBid.toFixed(2)}</td>
                            <td className="py-2 px-3 text-center">
                              {!t.settled ? (
                                <Badge variant="secondary" className="text-xs">Pending</Badge>
                              ) : t.won ? (
                                <Badge className="bg-emerald-600 text-xs">
                                  <CheckCircle2 className="h-3 w-3 mr-1" /> Won
                                </Badge>
                              ) : (
                                <Badge variant="destructive" className="text-xs">
                                  <XCircle className="h-3 w-3 mr-1" /> Lost
                                </Badge>
                              )}
                            </td>
                            <td className={`py-2 px-3 text-right font-mono font-semibold ${
                              !t.settled ? 'text-muted-foreground' :
                              (t.profitBid ?? 0) >= 0 ? 'text-emerald-500' : 'text-red-500'
                            }`}>
                              {!t.settled ? '—' : `${(t.profitBid ?? 0) >= 0 ? '+' : ''}$${(t.profitBid ?? 0).toFixed(2)}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {tracker.tracks.length > 50 && (
                      <div className="text-center py-2 text-xs text-muted-foreground">
                        Showing 50 of {tracker.tracks.length} bets
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </FadeIn>

      {/* ===== RESULTS ===== */}
      {phase === 'done' && data && activeSim && (
        <>
          {/* ===== THE BIG QUESTION: REALISTIC NWS SIMULATION ===== */}
          <FadeIn>
            <Card className="border-2 border-purple-500/40 bg-gradient-to-br from-purple-500/5 to-blue-500/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <Zap className="h-5 w-5 text-yellow-500" />
                  Bottom Line: What Would Actually Happen?
                </CardTitle>
                <CardDescription className="text-base">
                  If you had bet on every event for the last {activeSim.totalEvents > 200 ? '7+' : '6'} months using NWS forecasts to pick your 3 bins
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Sigma selector */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">NWS Accuracy Model:</span>
                  {sim && Object.entries(sim).map(([key, level]) => (
                    <Button key={key} size="sm"
                      variant={selectedSigma === key ? 'default' : 'outline'}
                      onClick={() => setSelectedSigma(key)}
                      className={selectedSigma === key ? 'bg-purple-600' : ''}>
                      σ = {(level as SimLevel).sigma}°F
                      {(level as SimLevel).sigma === 2.5 && ' (typical)'}
                    </Button>
                  ))}
                </div>

                {/* Big summary numbers */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="bg-background/60 rounded-lg p-4 border">
                    <p className="text-sm text-muted-foreground">Expected Wins</p>
                    <p className="text-2xl font-bold font-mono text-emerald-500">
                      ~{Math.round(activeSim.expectedWins)} <span className="text-base text-muted-foreground">/ {activeSim.totalEvents}</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Win rate: {activeSim.winRate}%</p>
                  </div>
                  <div className="bg-background/60 rounded-lg p-4 border">
                    <p className="text-sm text-muted-foreground">Expected Losses</p>
                    <p className="text-2xl font-bold font-mono text-red-500">
                      ~{Math.round(activeSim.expectedLosses)} <span className="text-base text-muted-foreground">/ {activeSim.totalEvents}</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Total wipeouts (lose entire stake)</p>
                  </div>
                  <div className="bg-background/60 rounded-lg p-4 border">
                    <p className="text-sm text-muted-foreground">Expected P&L (Limit Orders)</p>
                    <p className={`text-2xl font-bold font-mono ${activeSim.expectedPnlBid >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {activeSim.expectedPnlBid >= 0 ? '+' : ''}${activeSim.expectedPnlBid.toFixed(2)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">$10/bet × {activeSim.totalEvents} bets</p>
                  </div>
                  <div className="bg-background/60 rounded-lg p-4 border">
                    <p className="text-sm text-muted-foreground">Expected P&L (Market Orders)</p>
                    <p className={`text-2xl font-bold font-mono ${activeSim.expectedPnlAsk >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {activeSim.expectedPnlAsk >= 0 ? '+' : ''}${activeSim.expectedPnlAsk.toFixed(2)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">$10/bet × {activeSim.totalEvents} bets</p>
                  </div>
                </div>

                {/* Verdict */}
                {activeSim.expectedPnlBid < 0 && (
                  <div className="flex items-start gap-3 p-4 rounded-lg bg-red-500/10 border border-red-500/30">
                    <ShieldAlert className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="font-semibold text-red-400">Negative Expected Value</p>
                      <p className="text-sm text-muted-foreground">
                        At σ = {activeSim.sigma}°F NWS accuracy, the 3-bin Dutch bet loses money on average.
                        The NWS would need to be accurate more often than the breakeven win rate for each city (see below).
                        However, <strong>cherry-picking only profitable cities</strong> may still work.
                      </p>
                    </div>
                  </div>
                )}
                {activeSim.expectedPnlBid >= 0 && (
                  <div className="flex items-start gap-3 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                    <CheckCircle2 className="h-5 w-5 text-emerald-500 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="font-semibold text-emerald-400">Positive Expected Value</p>
                      <p className="text-sm text-muted-foreground">
                        At σ = {activeSim.sigma}°F NWS accuracy, the strategy shows a statistical edge with limit orders.
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </FadeIn>

          {/* NWS Sensitivity Table */}
          {sim && (
            <FadeIn>
              <Card>
                <CardHeader>
                  <CardTitle>NWS Accuracy Sensitivity Analysis</CardTitle>
                  <CardDescription>
                    How results change with different NWS forecast accuracy levels.
                    σ = standard deviation of forecast error. Lower σ = more accurate NWS forecasts.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-3 px-2">NWS Accuracy</th>
                          <th className="text-right py-3 px-2">Win Rate</th>
                          <th className="text-right py-3 px-2">Wins</th>
                          <th className="text-right py-3 px-2">Losses</th>
                          <th className="text-right py-3 px-2">P&L (Limit)</th>
                          <th className="text-right py-3 px-2">P&L (Market)</th>
                          <th className="text-left py-3 px-2">Verdict</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(sim).map(([key, level]) => {
                          const l = level as SimLevel;
                          return (
                            <tr key={key} className={`border-b border-border/50 hover:bg-muted/30 ${
                              selectedSigma === key ? 'bg-purple-500/10' : ''
                            }`}>
                              <td className="py-3 px-2">
                                <div className="font-medium">σ = {l.sigma}°F</div>
                                <div className="text-xs text-muted-foreground">
                                  {l.sigma === 2.0 && '(very accurate — calm weather)'}
                                  {l.sigma === 2.5 && '(typical NWS 24h forecast)'}
                                  {l.sigma === 3.0 && '(moderate — variable weather)'}
                                  {l.sigma === 3.5 && '(poor — fronts/storms)'}
                                </div>
                              </td>
                              <td className="text-right py-3 px-2 font-mono font-semibold">{l.winRate}%</td>
                              <td className="text-right py-3 px-2 font-mono text-emerald-500">~{Math.round(l.expectedWins)}</td>
                              <td className="text-right py-3 px-2 font-mono text-red-500">~{Math.round(l.expectedLosses)}</td>
                              <td className={`text-right py-3 px-2 font-mono font-semibold ${l.expectedPnlBid >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                                {l.expectedPnlBid >= 0 ? '+' : ''}${l.expectedPnlBid.toFixed(2)}
                              </td>
                              <td className={`text-right py-3 px-2 font-mono font-semibold ${l.expectedPnlAsk >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                                {l.expectedPnlAsk >= 0 ? '+' : ''}${l.expectedPnlAsk.toFixed(2)}
                              </td>
                              <td className="py-3 px-2">
                                {l.expectedPnlBid >= 0
                                  ? <Badge className="bg-emerald-600">+EV</Badge>
                                  : l.expectedPnlBid > -50
                                  ? <Badge variant="secondary">Marginal</Badge>
                                  : <Badge variant="destructive">−EV</Badge>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </FadeIn>
          )}

          {/* Per-City Realistic Results */}
          {activeSim?.cityResults && (
            <FadeIn>
              <Card>
                <CardHeader>
                  <CardTitle>Per-City Realistic Performance (σ = {activeSim.sigma}°F)</CardTitle>
                  <CardDescription>
                    Expected results for each city. Breakeven = the win rate needed just to not lose money.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {activeSim.cityResults.map((city) => {
                      const profitable = city.pnlBid >= 0;
                      return (
                        <Card key={city.city} className={`${profitable ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
                          <CardContent className="pt-4">
                            <div className="flex items-center justify-between mb-3">
                              <h4 className="font-semibold">{city.city}</h4>
                              <Badge variant={profitable ? 'default' : 'destructive'}
                                className={`font-mono ${profitable ? 'bg-emerald-600' : ''}`}>
                                {profitable ? '+' : ''}${city.pnlBid.toFixed(2)}
                              </Badge>
                            </div>
                            <div className="grid grid-cols-2 gap-y-2 text-sm">
                              <div>
                                <span className="text-muted-foreground">Events:</span>
                                <span className="ml-1 font-mono">{city.events}</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Exp. Wins:</span>
                                <span className="ml-1 font-mono text-emerald-500">~{Math.round(city.expectedWins)}</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Win Rate:</span>
                                <span className="ml-1 font-mono">{city.winRate}%</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Avg Cost:</span>
                                <span className="ml-1 font-mono">${city.avgCost.toFixed(2)}</span>
                              </div>
                              <div className="col-span-2">
                                <span className="text-muted-foreground">Breakeven Win Rate:</span>
                                <span className={`ml-1 font-mono font-semibold ${
                                  city.winRate >= city.breakevenWinRate ? 'text-emerald-500' : 'text-red-500'
                                }`}>
                                  {city.breakevenWinRate}%
                                  {city.winRate >= city.breakevenWinRate ? ' ✓ Clearing it' : ' ✗ Not enough'}
                                </span>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </FadeIn>
          )}

          {/* Expected P&L Curve */}
          {activeSim?.pnlCurve && activeSim.pnlCurve.length > 0 && (
            <FadeIn>
              <Card>
                <CardHeader>
                  <CardTitle>Expected Cumulative P&L Over Time (σ = {activeSim.sigma}°F, $10/bet)</CardTitle>
                  <CardDescription>
                    This shows the expected trajectory — actual results would zigzag around this line due to randomness.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={activeSim.pnlCurve}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                        <XAxis dataKey="eventNum" label={{ value: 'Event #', position: 'insideBottom', offset: -5 }} tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} />
                        <Tooltip
                          formatter={(value: number, name: string) => [
                            `$${value.toFixed(2)}`,
                            name === 'pnlBid' ? 'Expected P&L (Limit)' : 'Expected P&L (Market)'
                          ]}
                          labelFormatter={(l: number) => `Event #${l}`}
                          contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #333' }}
                        />
                        <Legend formatter={(v: string) => v === 'pnlBid' ? 'Limit Orders' : 'Market Orders'} />
                        <Line type="monotone" dataKey="pnlBid" stroke="#10b981" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="pnlAsk" stroke="#ef4444" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </FadeIn>
          )}

          {/* Collapsible: Original Strategy Comparison (the offset-based analysis) */}
          <FadeIn>
            <details className="group">
              <summary className="cursor-pointer list-none">
                <Card className="hover:border-muted-foreground/30 transition-colors">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Info className="h-4 w-4" />
                      Theoretical Strategy Bounds (Perfect NWS vs Fixed Offsets)
                      <span className="text-xs font-normal text-muted-foreground ml-2">Click to expand</span>
                    </CardTitle>
                  </CardHeader>
                </Card>
              </summary>
              <div className="mt-2 space-y-4">
                {/* Strategy table */}
                <Card>
                  <CardContent className="pt-6">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-left py-3 px-2">Strategy</th>
                            <th className="text-right py-3 px-2">Events</th>
                            <th className="text-right py-3 px-2">Win Rate</th>
                            <th className="text-right py-3 px-2">Avg Cost (Bid)</th>
                            <th className="text-right py-3 px-2">ROI (Bid)</th>
                            <th className="text-right py-3 px-2">Cum. P&L (Bid)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(data.strategyStats).map(([key, stats]) => (
                            <tr key={key} className="border-b border-border/50">
                              <td className="py-3 px-2 font-medium">{STRATEGY_LABELS[key] ?? key}</td>
                              <td className="text-right py-3 px-2 font-mono">{stats.totalEvents}</td>
                              <td className="text-right py-3 px-2">
                                <Badge variant={stats.winRate >= 80 ? 'default' : stats.winRate >= 50 ? 'secondary' : 'destructive'} className="font-mono">
                                  {stats.winRate}%
                                </Badge>
                              </td>
                              <td className="text-right py-3 px-2 font-mono">${stats.avgCostBid.toFixed(2)}</td>
                              <td className={`text-right py-3 px-2 font-mono font-semibold ${stats.avgReturnPctBid > 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                                {stats.avgReturnPctBid > 0 ? '+' : ''}{stats.avgReturnPctBid.toFixed(1)}%
                              </td>
                              <td className={`text-right py-3 px-2 font-mono font-semibold ${stats.cumulativePnlBid >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                                {stats.cumulativePnlBid >= 0 ? '+' : ''}${stats.cumulativePnlBid.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>

                {/* Sample bin prices */}
                {data.sampleEvent && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base flex items-center gap-2">
                        <Info className="h-4 w-4" /> Price Source: {data.sampleEvent.ticker} ({data.sampleEvent.city})
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border">
                              <th className="text-left py-2 px-2">Bin</th>
                              <th className="text-left py-2 px-2">Type</th>
                              <th className="text-center py-2 px-2">Winner</th>
                              <th className="text-right py-2 px-2">Trade Price</th>
                              <th className="text-left py-2 px-2">Source</th>
                              <th className="text-right py-2 px-2">Trades</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(data.sampleEvent.bins ?? []).map((bin: any, i: number) => (
                              <tr key={i} className="border-b border-border/50">
                                <td className="py-2 px-2 font-mono">{bin.label}</td>
                                <td className="py-2 px-2">{bin.type}</td>
                                <td className="py-2 px-2 text-center">
                                  {bin.result === 'yes' ? <CheckCircle2 className="h-4 w-4 text-emerald-500 inline" /> : <XCircle className="h-4 w-4 text-red-500/30 inline" />}
                                </td>
                                <td className="py-2 px-2 text-right font-mono font-semibold">${(bin.realPrice ?? 0).toFixed(2)}</td>
                                <td className="py-2 px-2">
                                  <Badge variant={bin.source === 'trades' ? 'default' : 'secondary'} className="text-xs">
                                    {bin.source === 'trades' ? 'Real' : 'Est.'}
                                  </Badge>
                                </td>
                                <td className="py-2 px-2 text-right font-mono">{bin.tradeCount ?? 0}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            </details>
          </FadeIn>

          {/* Methodology */}
          <FadeIn>
            <Card className="bg-muted/10 border-muted">
              <CardContent className="pt-6">
                <h4 className="font-semibold mb-3 flex items-center gap-2">
                  <Info className="h-4 w-4" /> How This Simulation Works
                </h4>
                <div className="text-sm text-muted-foreground space-y-2">
                  <p>
                    <strong>The question:</strong> "If I had used the NWS forecast to pick my 3 bins for every event in the last {activeSim?.totalEvents ?? 255} days, how many times would the actual temperature have landed in my spread?"
                  </p>
                  <p>
                    <strong>The method:</strong> For each historical event, we know which bin the actual temperature landed in (the winning bin).
                    We model the NWS forecast as: <code className="text-purple-400">forecast = actual_temp + error</code>, where error follows a normal distribution with standard deviation σ.
                    NWS published data shows σ ≈ 2.0–3.5°F for 24-hour high temperature forecasts, depending on weather pattern stability.
                  </p>
                  <p>
                    <strong>For each event we calculate:</strong> The probability that the NWS forecast would land in each possible bin,
                    then for each possible forecast bin, we check if the resulting 3-bin Dutch bet would cover the actual winner.
                    We weight the profit/loss by these probabilities to get the expected outcome per event.
                  </p>
                  <p>
                    <strong>Costs:</strong> Based on real median trade prices from Kalshi&apos;s trade history API (not settlement prices).
                    Limit orders priced at 1¢ below market; market orders at 1¢ above.
                  </p>
                  <p>
                    <strong>Key insight:</strong> The breakeven win rate equals the average cost of 3 bins. If the 3 bins cost $0.90 total,
                    you need to win 90% of the time just to break even — and with 2°F bins, NWS needs to be within ±1 bin (±2°F) that often.
                  </p>
                </div>
              </CardContent>
            </Card>
          </FadeIn>
        </>
      )}

      {/* Empty state */}
      {phase === 'idle' && !data && (
        <FadeIn>
          <Card className="border-dashed">
            <CardContent className="pt-12 pb-12 text-center">
              <FlaskConical className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Backtest Results</h3>
              <p className="text-muted-foreground mb-4 max-w-md mx-auto">
                Test your Dutch betting strategy against 250+ settled Kalshi events with real trade prices and NWS accuracy modeling.
              </p>
              <p className="text-xs text-muted-foreground mb-6">Takes 3-8 minutes (API rate limiting)</p>
              <Button onClick={runBacktest} className="bg-purple-600 hover:bg-purple-700">
                <Play className="h-4 w-4 mr-1" /> Run Backtest
              </Button>
            </CardContent>
          </Card>
        </FadeIn>
      )}
    </div>
  );
}

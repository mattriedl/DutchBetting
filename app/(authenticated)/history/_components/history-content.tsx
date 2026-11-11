'use client';

import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  History,
  Target,
  CheckCircle2,
  XCircle,
  Clock,
  BarChart3,
  ThermometerSun,
  ThermometerSnowflake,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { FadeIn, Stagger, StaggerItem } from '@/components/ui/animate';

interface CityStats {
  city: string;
  totalPredictions: number;
  within1Degree: number;
  within2Degrees: number;
  within3Degrees: number;
  dutchBetWins: number;
  avgAbsError: number;
  within1Rate: number;
  within2Rate: number;
  within3Rate: number;
  dutchWinRate: number;
}

interface HistoryEntry {
  id: string;
  city: string;
  state: string;
  marketType: string;
  forecastDate: string;
  nwsForecast: number;
  actualTemp: number | null;
  forecastError: number | null;
  absError: number | null;
  dutchBetResult: string | null;
  centerRange: string | null;
  dutchBetBins: string | null;
  centerOdds: number | null;
  profitMargin: number | null;
  wouldHaveWon: boolean | null;
  tempSource: string | null;
  resolvedAt: string | null;
}

type HistorySortKey = 'forecastDate' | 'city' | 'marketType' | 'nwsForecast' | 'actualTemp' | 'absError' | 'dutchBetResult';

export function HistoryContent() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [cityStats, setCityStats] = useState<CityStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [reResolving, setReResolving] = useState(false);
  const [marketType, setMarketType] = useState('all');
  const [selectedCity, setSelectedCity] = useState('all');

  // Sort state for the City Forecast Accuracy table
  const [cityStatsSort, setCityStatsSort] = useState<{ key: keyof CityStats; dir: 'asc' | 'desc' }>({ key: 'totalPredictions', dir: 'desc' });
  // Sort state for the Recent Predictions list
  const [historySort, setHistorySort] = useState<{ key: HistorySortKey; dir: 'asc' | 'desc' }>({ key: 'forecastDate', dir: 'desc' });

  const toggleCityStatsSort = (key: keyof CityStats) => {
    setCityStatsSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: typeof (cityStats?.[0]?.[key]) === 'string' ? 'asc' : 'desc' }
    );
  };

  const toggleHistorySort = (key: HistorySortKey) => {
    setHistorySort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'city' ? 'asc' : 'desc' }
    );
  };

  useEffect(() => {
    setLoading(true);
    const cityParam = selectedCity !== 'all' ? `&city=${encodeURIComponent(selectedCity)}` : '';
    fetch(`/api/history?marketType=${marketType}${cityParam}&limit=1000`)
      .then((r) => r?.json?.())
      .then((data) => {
        setHistory(data?.history ?? []);
        setCityStats(data?.cityStats ?? []);
      })
      .catch((err) => {
        console.error('History fetch error:', err);
        toast.error('Failed to load prediction history');
      })
      .finally(() => setLoading(false));
  }, [marketType, selectedCity]);

  const handleReResolve = async () => {
    setReResolving(true);
    try {
      const res = await fetch('/api/history/re-resolve', { method: 'POST' });
      const data = await res.json();
      if (data?.success) {
        const settled = data.newlyResolved ?? 0;
        const upgraded = data.updated ?? 0;
        const when = data.nextReadyAt
          ? new Date(data.nextReadyAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
          : null;
        if (settled > 0 || upgraded > 0) {
          toast.success(
            `Settled ${settled} finished forecast${settled === 1 ? '' : 's'}` +
            (upgraded > 0 ? `, upgraded ${upgraded} to official NWS temperatures` : '') +
            (data.pendingRemaining ? `. ${data.pendingRemaining} still waiting on days that haven't finished.` : '.'),
          );
        } else if (data.pendingRemaining > 0) {
          toast.info(
            `Nothing to update yet — ${data.pendingRemaining} forecast${data.pendingRemaining === 1 ? ' is' : 's are'} for days that haven't finished` +
            (when ? `. Next results from about ${when}` : '') + ' (checked automatically).',
          );
        } else {
          toast.success(`All ${data.alreadyCf6 ?? 0} settled forecasts already use official NWS temperatures.`);
        }
        // Reload history
        const cityParam = selectedCity !== 'all' ? `&city=${encodeURIComponent(selectedCity)}` : '';
        const refreshRes = await fetch(`/api/history?marketType=${marketType}${cityParam}&limit=1000`);
        const refreshData = await refreshRes.json();
        setHistory(refreshData?.history ?? []);
        setCityStats(refreshData?.cityStats ?? []);
      } else {
        toast.error(data?.error ?? 'Re-resolve failed');
      }
    } catch (err: any) {
      toast.error('Re-resolve failed: ' + (err?.message ?? 'Unknown error'));
    } finally {
      setReResolving(false);
    }
  };

  const allCities = Array.from(new Set((history ?? []).map((h) => h?.city ?? '').filter(Boolean))).sort();

  const totalResolved = (history ?? []).filter((h) => h?.actualTemp != null).length;
  const totalPending = (history ?? []).filter((h) => h?.actualTemp == null).length;
  const totalWins = (history ?? []).filter((h) => h?.wouldHaveWon === true).length;
  const overallWinRate = totalResolved > 0 ? Math.round((totalWins / totalResolved) * 100) : 0;

  const sortedCityStats = useMemo(() => {
    const arr = [...(cityStats ?? [])];
    const { key, dir } = cityStatsSort;
    const mult = dir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      const av = a?.[key];
      const bv = b?.[key];
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av ?? '').localeCompare(String(bv ?? '')) * mult;
      }
      return (((av as number) ?? 0) - ((bv as number) ?? 0)) * mult;
    });
    return arr;
  }, [cityStats, cityStatsSort]);

  const sortedHistory = useMemo(() => {
    const arr = [...(history ?? [])];
    const { key, dir } = historySort;
    const mult = dir === 'asc' ? 1 : -1;
    const resultRank = (r: string | null) => (r === 'won' ? 3 : r === 'lost' ? 2 : 1);
    arr.sort((a, b) => {
      if (key === 'forecastDate') {
        const at = a?.forecastDate ? new Date(a.forecastDate).getTime() : 0;
        const bt = b?.forecastDate ? new Date(b.forecastDate).getTime() : 0;
        return (at - bt) * mult;
      }
      if (key === 'city' || key === 'marketType') {
        return String(a?.[key] ?? '').localeCompare(String(b?.[key] ?? '')) * mult;
      }
      if (key === 'dutchBetResult') {
        return (resultRank(a?.dutchBetResult ?? null) - resultRank(b?.dutchBetResult ?? null)) * mult;
      }
      // numeric keys: nwsForecast, actualTemp, absError — push nulls to the end
      const av = a?.[key];
      const bv = b?.[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (((av as number) - (bv as number))) * mult;
    });
    return arr;
  }, [history, historySort]);

  const sortIcon = (active: boolean, dir: 'asc' | 'desc') =>
    !active ? <ChevronsUpDown className="w-3 h-3 opacity-40" />
    : dir === 'asc' ? <ArrowUp className="w-3 h-3 text-primary" />
    : <ArrowDown className="w-3 h-3 text-primary" />;

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-display font-bold tracking-tight">Prediction History</h1>
            <p className="text-sm text-muted-foreground mt-1">Track NWS forecast accuracy and Dutch bet performance by city</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleReResolve}
              disabled={reResolving}
              className="h-9 text-xs gap-1.5"
              title="Re-resolve all predictions using official NWS Climatological Report data"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${reResolving ? 'animate-spin' : ''}`} />
              {reResolving ? 'Updating...' : 'Update with NWS Data'}
            </Button>
            <Select value={marketType} onValueChange={setMarketType}>
              <SelectTrigger className="w-[130px] h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="high">Daily High</SelectItem>
                <SelectItem value="low">Daily Low</SelectItem>
              </SelectContent>
            </Select>
            <Select value={selectedCity} onValueChange={setSelectedCity}>
              <SelectTrigger className="w-[160px] h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Cities</SelectItem>
                {allCities.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </FadeIn>

      {/* Summary Stats */}
      <Stagger staggerDelay={0.1}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StaggerItem>
            <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Total Predictions</p>
                    <p className="text-3xl font-display font-bold mt-1">{history?.length ?? 0}</p>
                  </div>
                  <History className="w-8 h-8 text-blue-400/50" />
                </div>
              </CardContent>
            </Card>
          </StaggerItem>
          <StaggerItem>
            <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Resolved</p>
                    <p className="text-3xl font-display font-bold mt-1">{totalResolved}</p>
                    <p className="text-[10px] text-muted-foreground">{totalPending} pending</p>
                  </div>
                  <CheckCircle2 className="w-8 h-8 text-emerald-400/50" />
                </div>
              </CardContent>
            </Card>
          </StaggerItem>
          <StaggerItem>
            <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Dutch Bet Win Rate</p>
                    <p className="text-3xl font-display font-bold mt-1">{overallWinRate}%</p>
                    <p className="text-[10px] text-muted-foreground">{totalWins} of {totalResolved} won</p>
                  </div>
                  <Target className="w-8 h-8 text-amber-400/50" />
                </div>
              </CardContent>
            </Card>
          </StaggerItem>
          <StaggerItem>
            <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Market Type</p>
                    <p className="text-2xl font-display font-bold mt-1 flex items-center gap-2">
                      {marketType === 'all' ? (
                        <><BarChart3 className="w-6 h-6 text-purple-400" /> All</>
                      ) : marketType === 'high' ? (
                        <><ThermometerSun className="w-6 h-6 text-orange-400" /> High</>
                      ) : (
                        <><ThermometerSnowflake className="w-6 h-6 text-cyan-400" /> Low</>
                      )}
                    </p>
                  </div>
                  <BarChart3 className="w-8 h-8 text-purple-400/50" />
                </div>
              </CardContent>
            </Card>
          </StaggerItem>
        </div>
      </Stagger>

      {/* City Accuracy Table */}
      {(cityStats?.length ?? 0) > 0 && (
        <FadeIn delay={0.2}>
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base font-display">City Forecast Accuracy</CardTitle>
              <CardDescription>NWS forecast accuracy and Dutch bet win rates by city</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/50">
                      {([
                        { key: 'city', label: 'City', align: 'left' },
                        { key: 'totalPredictions', label: 'Predictions', align: 'center' },
                        { key: 'avgAbsError', label: 'Avg Error', align: 'center' },
                        { key: 'within1Rate', label: '±1°F', align: 'center' },
                        { key: 'within2Rate', label: '±2°F', align: 'center' },
                        { key: 'within3Rate', label: '±3°F', align: 'center' },
                        { key: 'dutchWinRate', label: 'Dutch Win Rate', align: 'center' },
                      ] as { key: keyof CityStats; label: string; align: 'left' | 'center' }[]).map((col) => (
                        <th key={col.key} className={`py-2 px-3 ${col.align === 'left' ? 'text-left' : 'text-center'}`}>
                          <button
                            type="button"
                            onClick={() => toggleCityStatsSort(col.key)}
                            className={`inline-flex items-center gap-1 text-xs font-medium uppercase transition-colors hover:text-foreground ${col.align === 'left' ? 'justify-start' : 'justify-center'} ${cityStatsSort.key === col.key ? 'text-foreground' : 'text-muted-foreground'}`}
                          >
                            <span>{col.label}</span>
                            {sortIcon(cityStatsSort.key === col.key, cityStatsSort.dir)}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCityStats.map((s: CityStats) => (
                      <tr key={s?.city ?? ''} className="border-b border-border/30 hover:bg-muted/20">
                        <td className="py-2.5 px-3 font-medium">{s?.city ?? ''}</td>
                        <td className="py-2.5 px-3 text-center font-mono">{s?.totalPredictions ?? 0}</td>
                        <td className="py-2.5 px-3 text-center">
                          <span className={`font-mono ${(s?.avgAbsError ?? 99) <= 2 ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {s?.avgAbsError ?? 0}°F
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <Badge variant="outline" className={`font-mono text-[10px] ${(s?.within1Rate ?? 0) >= 50 ? 'border-emerald-500/30 text-emerald-400' : 'border-amber-500/30 text-amber-400'}`}>
                            {s?.within1Rate ?? 0}%
                          </Badge>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <Badge variant="outline" className={`font-mono text-[10px] ${(s?.within2Rate ?? 0) >= 70 ? 'border-emerald-500/30 text-emerald-400' : 'border-amber-500/30 text-amber-400'}`}>
                            {s?.within2Rate ?? 0}%
                          </Badge>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <Badge variant="outline" className={`font-mono text-[10px] ${(s?.within3Rate ?? 0) >= 85 ? 'border-emerald-500/30 text-emerald-400' : 'border-amber-500/30 text-amber-400'}`}>
                            {s?.within3Rate ?? 0}%
                          </Badge>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <Badge className={`font-mono text-[10px] ${
                            (s?.dutchWinRate ?? 0) >= 70 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : (s?.dutchWinRate ?? 0) >= 50 ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                            : 'bg-red-500/10 text-red-400 border-red-500/20'
                          }`}>
                            {s?.dutchWinRate ?? 0}%
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </FadeIn>
      )}

      {/* Recent Predictions */}
      <FadeIn delay={0.3}>
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base font-display">Recent Predictions</CardTitle>
            <CardDescription>Individual prediction entries with forecast vs actual results</CardDescription>
            {(history?.length ?? 0) > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-3">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-1">Sort by</span>
                {([
                  { key: 'forecastDate', label: 'Date' },
                  { key: 'city', label: 'City' },
                  { key: 'marketType', label: 'Type' },
                  { key: 'nwsForecast', label: 'NWS' },
                  { key: 'actualTemp', label: 'Actual' },
                  { key: 'absError', label: 'Error' },
                  { key: 'dutchBetResult', label: 'Result' },
                ] as { key: HistorySortKey; label: string }[]).map((col) => (
                  <button
                    key={col.key}
                    type="button"
                    onClick={() => toggleHistorySort(col.key)}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                      historySort.key === col.key
                        ? 'border-primary/40 bg-primary/10 text-foreground'
                        : 'border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/40'
                    }`}
                  >
                    <span>{col.label}</span>
                    {sortIcon(historySort.key === col.key, historySort.dir)}
                  </button>
                ))}
              </div>
            )}
          </CardHeader>
          <CardContent>
            {(history?.length ?? 0) === 0 ? (
              <div className="text-center py-12">
                <History className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-lg font-medium text-muted-foreground">No prediction history yet</p>
                <p className="text-sm text-muted-foreground/70 mt-1">Predictions will be recorded each time you pull live data from the Dashboard</p>
              </div>
            ) : (
              <div className="space-y-2">
                {sortedHistory.map((entry: HistoryEntry) => (
                  <div key={entry?.id ?? ''} className="flex flex-wrap items-center justify-between p-3 rounded-lg bg-muted/20 hover:bg-muted/30 transition-colors gap-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        entry?.dutchBetResult === 'won' ? 'bg-emerald-500/10'
                        : entry?.dutchBetResult === 'lost' ? 'bg-red-500/10'
                        : 'bg-amber-500/10'
                      }`}>
                        {entry?.dutchBetResult === 'won' ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                         : entry?.dutchBetResult === 'lost' ? <XCircle className="w-4 h-4 text-red-400" />
                         : <Clock className="w-4 h-4 text-amber-400" />}
                      </div>
                      <div>
                        <p className="text-sm font-medium">{entry?.city ?? ''}, {entry?.state ?? ''}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {entry?.forecastDate ? new Date(entry.forecastDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : ''}
                          </span>
                          <Badge variant="outline" className={`text-[8px] font-mono px-1 py-0 ${entry?.marketType === 'low' ? 'border-cyan-500/30 text-cyan-400' : 'border-orange-500/30 text-orange-400'}`}>
                            {entry?.marketType === 'low' ? 'LOW' : 'HIGH'}
                          </Badge>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 flex-wrap">
                      <div className="text-right">
                        <span className="text-[10px] text-muted-foreground">NWS</span>
                        <p className="text-sm font-mono font-bold">{entry?.nwsForecast ?? 0}°F</p>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] text-muted-foreground">Actual</span>
                        <p className="text-sm font-mono font-bold">
                          {entry?.actualTemp != null ? `${entry.actualTemp}°F` : <span className="text-amber-400">Pending</span>}
                        </p>
                        {entry?.tempSource && (
                          <span className={`text-[8px] font-mono px-1 py-0 rounded ${entry.tempSource === 'NWS-CF6' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
                            {entry.tempSource === 'NWS-CF6' ? 'NWS' : 'EST'}
                          </span>
                        )}
                      </div>
                      {entry?.absError != null && (
                        <div className="text-right">
                          <span className="text-[10px] text-muted-foreground">Error</span>
                          <p className={`text-sm font-mono font-bold ${(entry?.absError ?? 99) <= 1 ? 'text-emerald-400' : (entry?.absError ?? 99) <= 2 ? 'text-blue-400' : 'text-red-400'}`}>
                            ±{entry.absError}°F
                          </p>
                        </div>
                      )}
                      <div className="text-right">
                        <span className="text-[10px] text-muted-foreground">Dutch Bet Bins</span>
                        {(() => {
                          // Show all 3 bins from dutchBetBins JSON, or fall back to centerRange
                          let bins: { range: string; ticker?: string }[] = [];
                          if (entry?.dutchBetBins) {
                            try { bins = JSON.parse(entry.dutchBetBins); } catch {}
                          }
                          if (bins.length > 0) {
                            return (
                              <div className="flex flex-col items-end gap-0.5">
                                {bins.map((b, i) => {
                                  // Highlight the winning bin if actual temp is known
                                  let isWinningBin = false;
                                  if (entry?.actualTemp != null) {
                                    const m = b.range.match(/(\d+).*?-.*?(\d+)/);
                                    if (m) {
                                      const lo = parseInt(m[1], 10);
                                      const hi = parseInt(m[2], 10);
                                      isWinningBin = entry.actualTemp >= lo && entry.actualTemp <= hi;
                                    }
                                  }
                                  return (
                                    <span key={i} className={`text-xs font-mono ${isWinningBin ? 'text-emerald-400 font-bold' : ''}`}>
                                      {b.range}
                                    </span>
                                  );
                                })}
                              </div>
                            );
                          }
                          // Fallback: reconstruct 3 bins from centerRange
                          if (entry?.centerRange) {
                            const m = entry.centerRange.match(/(\d+).*?-.*?(\d+)/);
                            if (m) {
                              const cLow = parseInt(m[1], 10);
                              const cHigh = parseInt(m[2], 10);
                              const w = cHigh - cLow;
                              if (w <= 2) {
                                const lowerBin = `${cLow - 2}°F - ${cLow - 1}°F`;
                                const centerBin = entry.centerRange;
                                const upperBin = `${cHigh + 1}°F - ${cHigh + 2}°F`;
                                const allBins = [lowerBin, centerBin, upperBin];
                                return (
                                  <div className="flex flex-col items-end gap-0.5">
                                    {allBins.map((bin, i) => {
                                      let isWinningBin = false;
                                      if (entry?.actualTemp != null) {
                                        const bm = bin.match(/(\d+).*?-.*?(\d+)/);
                                        if (bm) {
                                          isWinningBin = entry.actualTemp >= parseInt(bm[1], 10) && entry.actualTemp <= parseInt(bm[2], 10);
                                        }
                                      }
                                      return (
                                        <span key={i} className={`text-xs font-mono ${isWinningBin ? 'text-emerald-400 font-bold' : ''}`}>
                                          {bin}
                                        </span>
                                      );
                                    })}
                                  </div>
                                );
                              }
                            }
                            return <p className="text-xs font-mono">{entry.centerRange}</p>;
                          }
                          return <p className="text-xs font-mono">—</p>;
                        })()}
                      </div>
                      <div className="text-right min-w-[50px]">
                        <span className="text-[10px] text-muted-foreground">Result</span>
                        <p className="text-sm font-mono font-bold">
                          {entry?.dutchBetResult === 'won' ? <span className="text-emerald-400">WON</span>
                           : entry?.dutchBetResult === 'lost' ? <span className="text-red-400">LOST</span>
                           : <span className="text-amber-400">PENDING</span>}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </FadeIn>
    </div>
  );
}

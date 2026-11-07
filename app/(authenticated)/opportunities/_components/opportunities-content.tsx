'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Target,
  Copy,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Thermometer,
  DollarSign,
  ArrowUpRight,
  ArrowDownRight,
  BookmarkPlus,
  Download,
} from 'lucide-react';
import { toast } from 'sonner';
import { FadeIn, Stagger, StaggerItem } from '@/components/ui/animate';

interface Position {
  ticker: string;
  range: string;
  odds: number;
  stake: number;
  payout: number;
}

interface Analysis {
  city: string;
  state: string;
  nwsForecast: number;
  forecastConfidence: string;
  expirationTime: string;
  dutchBet: {
    positions: Position[];
    totalStake: number;
    guaranteedReturn: number;
    profitMargin: number;
    isViable: boolean;
    rating: string;
  };
}

export function OpportunitiesContent() {
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkedBets, setCheckedBets] = useState<Record<string, boolean>>({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/analysis?stake=10');
      const data = await res?.json?.();
      // Only show truly viable opportunities — exclude edge cases (incomplete bins, far-off-forecast)
      const viable = (data?.analyses ?? []).filter((a: Analysis) => a?.dutchBet?.isViable && !(a?.dutchBet as any)?.isEdgeCase);
      setAnalyses(viable);
    } catch (error: any) {
      console.error('Fetch error:', error);
      toast.error('Failed to load opportunities');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const toggleBet = (key: string) => {
    setCheckedBets((prev: any) => ({ ...(prev ?? {}), [key]: !(prev?.[key]) }));
  };

  const copyAllDetails = () => {
    const text = (analyses ?? []).map((a: Analysis) => {
      const positions = (a?.dutchBet?.positions ?? []).map((p: Position, i: number) =>
        `  P${i + 1}: ${p?.range ?? ''} @ ${p?.odds ?? 0}¢ -> $${p?.stake?.toFixed?.(2) ?? '0.00'}`
      ).join('\n');
      return `${a?.city ?? ''}, ${a?.state ?? ''} (NWS: ${a?.nwsForecast ?? 0}°F) - Margin: ${a?.dutchBet?.profitMargin?.toFixed?.(2) ?? '0.00'}%\n${positions}`;
    }).join('\n\n');
    navigator?.clipboard?.writeText?.(text)?.then?.(() => toast.success('All opportunities copied!'))?.catch?.(() => toast.error('Copy failed'));
  };

  const exportCSV = () => {
    const header = 'City,State,NWS Forecast,P1 Range,P1 Odds,P1 Stake,P2 Range,P2 Odds,P2 Stake,P3 Range,P3 Odds,P3 Stake,Total Stake,Return,Margin';
    const rows = (analyses ?? []).map((a: Analysis) => {
      const p = a?.dutchBet?.positions ?? [];
      return [
        a?.city ?? '', a?.state ?? '', a?.nwsForecast ?? 0,
        p?.[0]?.range ?? '', p?.[0]?.odds ?? 0, p?.[0]?.stake ?? 0,
        p?.[1]?.range ?? '', p?.[1]?.odds ?? 0, p?.[1]?.stake ?? 0,
        p?.[2]?.range ?? '', p?.[2]?.odds ?? 0, p?.[2]?.stake ?? 0,
        a?.dutchBet?.totalStake ?? 0, a?.dutchBet?.guaranteedReturn ?? 0, a?.dutchBet?.profitMargin ?? 0,
      ].join(',');
    });
    const csv = [header, ...(rows ?? [])].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `dutch-betting-opportunities-${new Date().toISOString().split('T')[0]}.csv`;
    link?.click?.();
    URL?.revokeObjectURL?.(url);
    toast.success('CSV exported!');
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        {[1, 2, 3].map((i: number) => <Skeleton key={i} className="h-48 rounded-xl" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-display font-bold tracking-tight">Opportunities</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {(analyses?.length ?? 0)} viable Dutch betting {(analyses?.length ?? 0) === 1 ? 'opportunity' : 'opportunities'} found
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={copyAllDetails} variant="outline" size="sm" className="gap-2">
              <Copy className="w-3.5 h-3.5" /> Copy All
            </Button>
            <Button onClick={exportCSV} variant="outline" size="sm" className="gap-2">
              <Download className="w-3.5 h-3.5" /> Export CSV
            </Button>
            <Button onClick={fetchData} variant="outline" size="sm" className="gap-2">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </Button>
          </div>
        </div>
      </FadeIn>

      {(analyses?.length ?? 0) === 0 ? (
        <Card className="border-border/50 bg-card/50">
          <CardContent className="p-12 text-center">
            <Target className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium text-muted-foreground">No viable opportunities found</p>
            <p className="text-sm text-muted-foreground/70 mt-1">Try refreshing or check back later when odds change</p>
          </CardContent>
        </Card>
      ) : (
        <Stagger staggerDelay={0.1}>
          <div className="space-y-4">
            {(analyses ?? []).map((a: Analysis, idx: number) => (
              <StaggerItem key={a?.city ?? idx}>
                <Card className="border-border/50 bg-card/50 backdrop-blur-sm ring-1 ring-emerald-500/10">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-sm font-bold font-mono text-emerald-400">
                          #{idx + 1}
                        </div>
                        <div>
                          <CardTitle className="font-display text-lg">{a?.city ?? ''}, {a?.state ?? ''}</CardTitle>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Thermometer className="w-3 h-3 text-orange-400" />
                            <span className="text-xs font-mono">NWS: {a?.nwsForecast ?? 0}°F</span>
                            <Badge variant="outline" className="text-[9px] font-mono">{a?.forecastConfidence ?? 'normal'}</Badge>
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-2xl font-bold font-mono ${(a?.dutchBet?.profitMargin ?? 0) > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          +{a?.dutchBet?.profitMargin?.toFixed?.(2) ?? '0.00'}%
                        </p>
                        <p className="text-[10px] text-zinc-400 uppercase">guaranteed margin</p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {/* Bet Placement Checklist */}
                    <div className="space-y-2 mb-4">
                      <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
                        Bet Placement Checklist
                      </p>
                      {(a?.dutchBet?.positions ?? []).map((p: Position, i: number) => {
                        const key = `${a?.city ?? ''}-${i}`;
                        return (
                          <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-muted/20 hover:bg-muted/30 transition-colors">
                            <Checkbox
                              checked={!!checkedBets?.[key]}
                              onCheckedChange={() => toggleBet(key)}
                            />
                            <div className="flex-1 flex items-center justify-between">
                              <div>
                                <span className={`text-sm font-medium ${checkedBets?.[key] ? 'line-through text-muted-foreground' : ''}`}>
                                  {p?.range ?? ''}
                                </span>
                                <p className="text-[10px] font-mono text-zinc-400">{p?.ticker ?? ''}</p>
                              </div>
                              <div className="flex items-center gap-6">
                                <div className="text-center">
                                  <p className="text-[10px] text-zinc-400">YES @ </p>
                                  <p className="text-sm font-mono font-bold">{p?.odds ?? 0}¢</p>
                                </div>
                                <div className="text-center">
                                  <p className="text-[10px] text-zinc-400">Stake</p>
                                  <p className="text-sm font-mono font-bold text-blue-400">${p?.stake?.toFixed?.(2) ?? '0.00'}</p>
                                </div>
                                <div className="text-center">
                                  <p className="text-[10px] text-zinc-400">Payout</p>
                                  <p className="text-sm font-mono font-bold text-emerald-400">${p?.payout?.toFixed?.(2) ?? '0.00'}</p>
                                </div>
                              </div>
                            </div>
                            {checkedBets?.[key] && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                          </div>
                        );
                      })}
                    </div>

                    {/* Summary */}
                    <div className="flex items-center justify-between p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                      <div className="flex items-center gap-6">
                        <div>
                          <p className="text-[10px] text-zinc-400 uppercase">Total Stake</p>
                          <p className="text-lg font-bold font-mono">${a?.dutchBet?.totalStake?.toFixed?.(2) ?? '0.00'}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-zinc-400 uppercase">Guaranteed Return</p>
                          <p className="text-lg font-bold font-mono text-emerald-400">
                            +${a?.dutchBet?.guaranteedReturn?.toFixed?.(2) ?? '0.00'}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const text = (a?.dutchBet?.positions ?? []).map((p: Position, i: number) =>
                            `P${i + 1}: ${p?.range ?? ''} @ ${p?.odds ?? 0}¢ -> $${p?.stake?.toFixed?.(2) ?? '0'}`
                          ).join('\n');
                          navigator?.clipboard?.writeText?.(`${a?.city ?? ''}: ${a?.nwsForecast ?? 0}°F\n${text}`)?.then?.(() => toast.success('Copied!'));
                        }}
                        className="gap-2"
                      >
                        <Copy className="w-3.5 h-3.5" /> Copy Details
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </StaggerItem>
            ))}
          </div>
        </Stagger>
      )}
    </div>
  );
}

'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Thermometer,
  ArrowLeft,
  RefreshCw,
  Copy,
  Target,
  DollarSign,
  TrendingUp,
  ArrowUpRight,
  ArrowDownRight,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { FadeIn } from '@/components/ui/animate';
import Link from 'next/link';
import { OddsChart } from '../../_components/odds-chart';

interface Position {
  ticker: string;
  range: string;
  odds: number;
  stake: number;
  payout: number;
}

export function CityDetailContent({ cityParam }: { cityParam: string }) {
  const cityName = decodeURIComponent(cityParam ?? '');
  const [analysis, setAnalysis] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [stake, setStake] = useState(10);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/analysis?stake=${stake}`);
      const data = await res?.json?.();
      const cityData = (data?.analyses ?? []).find((a: any) => a?.city === cityName);
      setAnalysis(cityData ?? null);
    } catch (error: any) {
      console.error('Fetch error:', error);
      toast.error('Failed to load city data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [cityName, stake]);

  const copyBetDetails = () => {
    if (!analysis) return;
    const positions = (analysis?.dutchBet?.positions ?? []).map((p: Position, i: number) =>
      `Position ${i + 1}: ${p?.range ?? ''} | YES @ ${p?.odds ?? 0}¢ | Stake: $${p?.stake?.toFixed?.(2) ?? '0.00'} | Payout: $${p?.payout?.toFixed?.(2) ?? '0.00'}`
    ).join('\n');
    const text = [
      `=== DUTCH BET: ${analysis?.city ?? ''}, ${analysis?.state ?? ''} ===`,
      `NWS Forecast: ${analysis?.nwsForecast ?? 0}°F`,
      `Confidence: ${analysis?.forecastConfidence ?? 'normal'}`,
      ``,
      `--- POSITIONS ---`,
      positions,
      ``,
      `--- SUMMARY ---`,
      `Total Stake: $${analysis?.dutchBet?.totalStake?.toFixed?.(2) ?? '0.00'}`,
      `Guaranteed Return: $${analysis?.dutchBet?.guaranteedReturn?.toFixed?.(2) ?? '0.00'}`,
      `Profit Margin: ${analysis?.dutchBet?.profitMargin?.toFixed?.(2) ?? '0.00'}%`,
      `Rating: ${analysis?.dutchBet?.rating ?? 'none'}`,
    ].join('\n');
    navigator?.clipboard?.writeText?.(text)?.then?.(() => toast.success('Full details copied!'))?.catch?.(() => toast.error('Copy failed'));
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="space-y-6">
        <Link href="/markets">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="w-4 h-4" /> Back to Markets
          </Button>
        </Link>
        <Card className="border-border/50 bg-card/50">
          <CardContent className="p-12 text-center">
            <AlertTriangle className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium text-muted-foreground">No data found for {cityName}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <FadeIn>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link href="/markets">
              <Button variant="ghost" size="icon-sm">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-display font-bold tracking-tight">
                {analysis?.city ?? ''}, {analysis?.state ?? ''}
              </h1>
              <p className="text-sm text-muted-foreground">Detailed Dutch betting analysis</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-muted-foreground" />
            <Input
              type="number"
              value={stake}
              onChange={(e: any) => setStake(parseFloat(e?.target?.value ?? '10') || 10)}
              className="w-24 h-9 text-sm"
              min={1}
            />
            <span className="text-xs text-muted-foreground">stake</span>
            <Button variant="outline" size="sm" onClick={fetchData} className="gap-2 ml-2">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </Button>
          </div>
        </div>
      </FadeIn>

      {/* Forecast & Rating */}
      <FadeIn delay={0.1}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card className="border-border/50 bg-card/50">
            <CardContent className="p-5">
              <div className="flex items-center gap-3">
                <Thermometer className="w-8 h-8 text-orange-400" />
                <div>
                  <p className="text-xs text-muted-foreground uppercase">NWS Forecast</p>
                  <p className="text-3xl font-bold font-mono">{analysis?.nwsForecast ?? 0}°F</p>
                  <Badge variant="outline" className="text-[9px] font-mono mt-1">{analysis?.forecastConfidence ?? 'normal'}</Badge>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border/50 bg-card/50">
            <CardContent className="p-5">
              <div className="flex items-center gap-3">
                <TrendingUp className="w-8 h-8 text-emerald-400" />
                <div>
                  <p className="text-xs text-muted-foreground uppercase">Profit Margin</p>
                  <p className={`text-3xl font-bold font-mono ${(analysis?.dutchBet?.profitMargin ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {(analysis?.dutchBet?.profitMargin ?? 0) >= 0 ? '+' : ''}{analysis?.dutchBet?.profitMargin?.toFixed?.(2) ?? '0.00'}%
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border/50 bg-card/50">
            <CardContent className="p-5">
              <div className="flex items-center gap-3">
                <Target className="w-8 h-8 text-blue-400" />
                <div>
                  <p className="text-xs text-muted-foreground uppercase">Rating</p>
                  <Badge className={`mt-1 text-sm ${
                    analysis?.dutchBet?.rating === 'excellent' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                    analysis?.dutchBet?.rating === 'good' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' :
                    analysis?.dutchBet?.rating === 'marginal' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' :
                    'bg-slate-500/10 text-slate-400 border-slate-500/20'
                  }`}>
                    {(analysis?.dutchBet?.rating ?? 'none')?.toUpperCase?.()}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </FadeIn>

      {/* Odds Chart */}
      <FadeIn delay={0.2}>
        <Card className="border-border/50 bg-card/50">
          <CardHeader>
            <CardTitle className="text-base font-display">Temperature Range Odds</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <OddsChart
                markets={(analysis?.allMarkets ?? []).map((m: any) => ({
                  tempRangeLow: m?.tempRangeLow ?? 0,
                  tempRangeHigh: m?.tempRangeHigh ?? 0,
                  yesPrice: m?.yesPrice ?? 0,
                  volume: m?.volume ?? 0,
                }))}
                forecast={analysis?.nwsForecast ?? null}
              />
            </div>
          </CardContent>
        </Card>
      </FadeIn>

      {/* Dutch Bet Positions Detail */}
      <FadeIn delay={0.3}>
        <Card className="border-border/50 bg-card/50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-display">Dutch Betting Calculator</CardTitle>
              <Button variant="outline" size="sm" onClick={copyBetDetails} className="gap-2">
                <Copy className="w-3.5 h-3.5" /> Copy All Details
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Temperature Range</TableHead>
                  <TableHead>Market Ticker</TableHead>
                  <TableHead className="text-right">YES Price</TableHead>
                  <TableHead className="text-right">Stake</TableHead>
                  <TableHead className="text-right">Payout</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(analysis?.dutchBet?.positions ?? []).map((p: Position, i: number) => (
                  <TableRow key={i} className={i === 1 ? 'bg-blue-500/5' : ''}>
                    <TableCell>
                      <div className={`w-7 h-7 rounded flex items-center justify-center text-xs font-bold font-mono ${
                        i === 1 ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-500/20 text-slate-400'
                      }`}>
                        {i + 1}
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      {p?.range ?? ''}
                      {i === 1 && <Badge variant="outline" className="ml-2 text-[9px] text-blue-400 border-blue-400/30">CENTER</Badge>}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{p?.ticker ?? ''}</TableCell>
                    <TableCell className="text-right font-mono font-bold">{p?.odds ?? 0}¢</TableCell>
                    <TableCell className="text-right font-mono font-bold text-blue-400">${p?.stake?.toFixed?.(2) ?? '0.00'}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-emerald-400">${p?.payout?.toFixed?.(2) ?? '0.00'}</TableCell>
                  </TableRow>
                ))}
                {/* Total row */}
                <TableRow className="border-t-2">
                  <TableCell colSpan={4} className="font-bold">Total</TableCell>
                  <TableCell className="text-right font-mono font-bold">${analysis?.dutchBet?.totalStake?.toFixed?.(2) ?? '0.00'}</TableCell>
                  <TableCell className="text-right font-mono font-bold text-emerald-400">
                    Min: ${((analysis?.dutchBet?.totalStake ?? 0) + (analysis?.dutchBet?.guaranteedReturn ?? 0))?.toFixed?.(2) ?? '0.00'}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>

            {/* Payout Scenarios */}
            <div className="mt-6 p-4 rounded-lg bg-muted/20">
              <p className="text-sm font-medium mb-3">Payout Scenarios</p>
              <div className="space-y-2">
                {(analysis?.dutchBet?.positions ?? []).map((p: Position, i: number) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">If result is {p?.range ?? ''}:</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-emerald-400">${p?.payout?.toFixed?.(2) ?? '0.00'}</span>
                      <span className="text-muted-foreground font-mono text-xs">
                        ({((((p?.payout ?? 0) - (analysis?.dutchBet?.totalStake ?? 0)) / (analysis?.dutchBet?.totalStake ?? 1)) * 100)?.toFixed?.(1) ?? '0.0'}%)
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </FadeIn>

      {/* All Markets Table */}
      <FadeIn delay={0.4}>
        <Card className="border-border/50 bg-card/50">
          <CardHeader>
            <CardTitle className="text-base font-display">All Available Markets</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Range</TableHead>
                  <TableHead>Ticker</TableHead>
                  <TableHead className="text-right">YES</TableHead>
                  <TableHead className="text-right">NO</TableHead>
                  <TableHead className="text-right">Volume</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(analysis?.allMarkets ?? []).map((m: any, i: number) => {
                  const isInDutch = (analysis?.dutchBet?.positions ?? []).some((p: Position) => p?.ticker === m?.ticker);
                  return (
                    <TableRow key={i} className={isInDutch ? 'bg-blue-500/5' : ''}>
                      <TableCell className="font-mono font-medium">
                        {m?.contractType === 'threshold'
                          ? (m?.strikeDirection === 'below' ? `≤${m?.tempRangeLow ?? 0}°F` : `≥${m?.tempRangeLow ?? 0}°F`)
                          : `${m?.tempRangeLow ?? 0}° - ${m?.tempRangeHigh ?? 0}°F`}
                        {m?.contractType === 'threshold' && <Badge variant="outline" className="ml-2 text-[9px] text-yellow-500 border-yellow-500/30">TAIL</Badge>}
                        {isInDutch && <Badge variant="outline" className="ml-2 text-[9px] text-blue-400">DUTCH</Badge>}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{m?.ticker ?? ''}</TableCell>
                      <TableCell className="text-right font-mono font-bold text-emerald-400">{m?.yesPrice ?? 0}¢</TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">{m?.noPrice ?? 0}¢</TableCell>
                      <TableCell className="text-right font-mono">{m?.volume ?? 0}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </FadeIn>
    </div>
  );
}

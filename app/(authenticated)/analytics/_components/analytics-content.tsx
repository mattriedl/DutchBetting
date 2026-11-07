'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { LineChart, BarChart3, Target, TrendingUp, MapPin, RefreshCw, PieChart } from 'lucide-react';
import { toast } from 'sonner';
import { FadeIn, Stagger, StaggerItem } from '@/components/ui/animate';
import { MarginDistributionChart } from './margin-distribution-chart';
import { CityOpportunitiesChart } from './city-opportunities-chart';

interface Analysis {
  city: string;
  state: string;
  nwsForecast: number;
  dutchBet: {
    profitMargin: number;
    isViable: boolean;
    rating: string;
    totalStake: number;
    guaranteedReturn: number;
  };
}

export function AnalyticsContent() {
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/analysis?stake=10');
      const data = await res?.json?.();
      setAnalyses(data?.analyses ?? []);
    } catch (error: any) {
      console.error('Fetch error:', error);
      toast.error('Failed to load analytics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i: number) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const viable = (analyses ?? []).filter((a: Analysis) => a?.dutchBet?.isViable && !(a?.dutchBet as any)?.isEdgeCase);
  const avgMargin = (analyses?.length ?? 0) > 0
    ? (analyses ?? []).reduce((sum: number, a: Analysis) => sum + (a?.dutchBet?.profitMargin ?? 0), 0) / analyses.length
    : 0;
  const bestCity = analyses?.length > 0 ? analyses.reduce((best: Analysis, a: Analysis) =>
    (a?.dutchBet?.profitMargin ?? 0) > (best?.dutchBet?.profitMargin ?? 0) ? a : best
  ) : null;
  const totalPotentialReturn = viable.reduce((sum: number, a: Analysis) => sum + (a?.dutchBet?.guaranteedReturn ?? 0), 0);

  const ratingCounts = { excellent: 0, good: 0, marginal: 0, none: 0 };
  (analyses ?? []).forEach((a: Analysis) => {
    const r = (a?.dutchBet?.rating ?? 'none') as keyof typeof ratingCounts;
    if (ratingCounts[r] !== undefined) ratingCounts[r]++;
  });

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-display font-bold tracking-tight">Analytics</h1>
            <p className="text-sm text-muted-foreground mt-1">Summary statistics and charts for Dutch betting analysis</p>
          </div>
          <Button onClick={fetchData} variant="outline" size="sm" className="gap-2">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
        </div>
      </FadeIn>

      {/* Summary Stats */}
      <Stagger staggerDelay={0.1}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StaggerItem>
            <Card className="border-border/50 bg-card/50">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Markets</p>
                    <p className="text-3xl font-bold font-mono mt-1">{analyses?.length ?? 0}</p>
                  </div>
                  <MapPin className="w-5 h-5 text-blue-400" />
                </div>
              </CardContent>
            </Card>
          </StaggerItem>
          <StaggerItem>
            <Card className="border-border/50 bg-card/50">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">Viable Opps</p>
                    <p className="text-3xl font-bold font-mono mt-1 text-emerald-400">{viable?.length ?? 0}</p>
                  </div>
                  <Target className="w-5 h-5 text-emerald-400" />
                </div>
              </CardContent>
            </Card>
          </StaggerItem>
          <StaggerItem>
            <Card className="border-border/50 bg-card/50">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">Avg Margin</p>
                    <p className={`text-3xl font-bold font-mono mt-1 ${avgMargin > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {avgMargin > 0 ? '+' : ''}{avgMargin?.toFixed?.(2) ?? '0.00'}%
                    </p>
                  </div>
                  <TrendingUp className="w-5 h-5 text-purple-400" />
                </div>
              </CardContent>
            </Card>
          </StaggerItem>
          <StaggerItem>
            <Card className="border-border/50 bg-card/50">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">Potential Return</p>
                    <p className="text-3xl font-bold font-mono mt-1 text-emerald-400">
                      ${totalPotentialReturn?.toFixed?.(2) ?? '0.00'}
                    </p>
                  </div>
                  <BarChart3 className="w-5 h-5 text-amber-400" />
                </div>
              </CardContent>
            </Card>
          </StaggerItem>
        </div>
      </Stagger>

      {/* Rating Distribution */}
      <FadeIn delay={0.2}>
        <Card className="border-border/50 bg-card/50">
          <CardHeader>
            <CardTitle className="text-base font-display flex items-center gap-2">
              <PieChart className="w-4 h-4 text-blue-400" />
              Opportunity Rating Distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-4">
              {[
                { label: 'Excellent', count: ratingCounts.excellent, color: 'bg-emerald-500', textColor: 'text-emerald-400' },
                { label: 'Good', count: ratingCounts.good, color: 'bg-blue-500', textColor: 'text-blue-400' },
                { label: 'Marginal', count: ratingCounts.marginal, color: 'bg-yellow-500', textColor: 'text-yellow-400' },
                { label: 'None', count: ratingCounts.none, color: 'bg-slate-500', textColor: 'text-slate-400' },
              ].map((item: any) => (
                <div key={item?.label ?? ''} className="text-center p-4 rounded-lg bg-muted/20">
                  <div className={`w-3 h-3 rounded-full ${item?.color ?? ''} mx-auto mb-2`} />
                  <p className={`text-2xl font-bold font-mono ${item?.textColor ?? ''}`}>{item?.count ?? 0}</p>
                  <p className="text-[10px] text-muted-foreground uppercase">{item?.label ?? ''}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </FadeIn>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <FadeIn delay={0.3}>
          <Card className="border-border/50 bg-card/50">
            <CardHeader>
              <CardTitle className="text-base font-display flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-blue-400" />
                Profit Margin by City
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <CityOpportunitiesChart analyses={analyses} />
              </div>
            </CardContent>
          </Card>
        </FadeIn>
        <FadeIn delay={0.4}>
          <Card className="border-border/50 bg-card/50">
            <CardHeader>
              <CardTitle className="text-base font-display flex items-center gap-2">
                <LineChart className="w-4 h-4 text-emerald-400" />
                Margin Distribution
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <MarginDistributionChart analyses={analyses} />
              </div>
            </CardContent>
          </Card>
        </FadeIn>
      </div>

      {/* Best Opportunity */}
      {bestCity && (
        <FadeIn delay={0.5}>
          <Card className="border-border/50 bg-gradient-to-r from-emerald-500/5 to-blue-500/5">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500/20 to-blue-500/20 flex items-center justify-center">
                  <Target className="w-6 h-6 text-emerald-400" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Best Current Opportunity</p>
                  <p className="text-xl font-display font-bold mt-1">
                    {bestCity?.city ?? ''}, {bestCity?.state ?? ''}
                    <span className="ml-3 text-emerald-400 font-mono">
                      +{bestCity?.dutchBet?.profitMargin?.toFixed?.(2) ?? '0.00'}% margin
                    </span>
                  </p>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    NWS Forecast: {bestCity?.nwsForecast ?? 0}°F • Guaranteed return: ${bestCity?.dutchBet?.guaranteedReturn?.toFixed?.(2) ?? '0.00'} on ${bestCity?.dutchBet?.totalStake ?? 10} stake
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </FadeIn>
      )}
    </div>
  );
}

'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Thermometer, RefreshCw, MapPin, BarChart3, Clock, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { FadeIn, Stagger, StaggerItem } from '@/components/ui/animate';
import { OddsChart } from './odds-chart';

interface MarketItem {
  id: string;
  kalshiMarketId: string;
  tempRangeLow: number;
  tempRangeHigh: number;
  yesPrice: number;
  noPrice: number;
  volume: number;
  openInterest: number;
  lastUpdated: string;
}

interface CityGroup {
  city: string;
  state: string;
  eventTicker: string;
  expirationTime: string;
  markets: MarketItem[];
}

export function MarketsContent() {
  const [cities, setCities] = useState<CityGroup[]>([]);
  const [forecasts, setForecasts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCity, setSelectedCity] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [marketsRes, forecastsRes] = await Promise.all([
        fetch('/api/markets'),
        fetch('/api/forecasts'),
      ]);
      const marketsData = await marketsRes?.json?.();
      const forecastsData = await forecastsRes?.json?.();
      setCities(marketsData?.cities ?? []);
      setForecasts(forecastsData?.forecasts ?? []);
    } catch (error: any) {
      console.error('Fetch error:', error);
      toast.error('Failed to load market data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const getForecast = (city: string) => (forecasts ?? []).find((f: any) => f?.city === city);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        {[1, 2, 3].map((i: number) => <Skeleton key={i} className="h-48 rounded-xl" />)}
      </div>
    );
  }

  const selectedCityData = selectedCity ? (cities ?? []).find((c: CityGroup) => c?.city === selectedCity) : null;
  const selectedForecast = selectedCity ? getForecast(selectedCity) : null;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-display font-bold tracking-tight">Markets</h1>
            <p className="text-sm text-muted-foreground mt-1">All active Kalshi climate temperature markets</p>
          </div>
          <Button onClick={fetchData} variant="outline" size="sm" className="gap-2">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
        </div>
      </FadeIn>

      {/* City Selector */}
      <Stagger staggerDelay={0.05}>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {(cities ?? []).map((c: CityGroup) => {
            const forecast = getForecast(c?.city ?? '');
            return (
              <StaggerItem key={c?.city ?? ''}>
                <button
                  onClick={() => setSelectedCity(c?.city === selectedCity ? null : c?.city ?? null)}
                  className={`w-full p-3 rounded-xl border transition-all text-left ${
                    selectedCity === c?.city
                      ? 'border-blue-500/50 bg-blue-500/10 shadow-lg shadow-blue-500/10'
                      : 'border-border/50 bg-card/50 hover:border-border hover:bg-card'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <MapPin className="w-3.5 h-3.5 text-blue-400" />
                    <span className="text-sm font-medium truncate">{c?.city ?? ''}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground font-mono">{c?.markets?.length ?? 0} ranges</span>
                    {forecast?.forecastHigh != null && (
                      <span className="text-xs font-mono font-bold text-orange-400">{forecast.forecastHigh}°F</span>
                    )}
                  </div>
                </button>
              </StaggerItem>
            );
          })}
        </div>
      </Stagger>

      {/* Selected City Detail */}
      {selectedCityData ? (
        <FadeIn>
          <div className="space-y-4">
            <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500/20 to-emerald-500/20 flex items-center justify-center">
                      <Thermometer className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                      <CardTitle className="font-display">{selectedCityData?.city ?? ''}, {selectedCityData?.state ?? ''}</CardTitle>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-xs font-mono text-muted-foreground">{selectedCityData?.eventTicker ?? ''}</span>
                        <div className="flex items-center gap-1">
                          <Clock className="w-3 h-3 text-muted-foreground" />
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {(() => {
                              const m = selectedCityData?.eventTicker?.match?.(/(\d{2})([A-Z]{3})(\d{2})$/);
                              if (m) {
                                const mm: Record<string,string> = {JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12'};
                                const d = new Date(`20${m[1]}-${mm[m[2]] ?? '01'}-${m[3]}T12:00:00`);
                                return `Forecast: ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
                              }
                              return selectedCityData?.expirationTime
                                ? `Settles: ${new Date(selectedCityData.expirationTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                                : 'N/A';
                            })()}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                  {selectedForecast && (
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">NWS Forecast</p>
                      <p className="text-3xl font-bold font-mono text-orange-400">{selectedForecast?.forecastHigh ?? 0}°F</p>
                      <Badge variant="outline" className="text-[9px] font-mono mt-1">
                        {selectedForecast?.confidence ?? 'normal'}
                      </Badge>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-6 h-64">
                  <OddsChart
                    markets={selectedCityData?.markets ?? []}
                    forecast={selectedForecast?.forecastHigh ?? null}
                  />
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Range</TableHead>
                      <TableHead>Ticker</TableHead>
                      <TableHead className="text-right">Yes Price</TableHead>
                      <TableHead className="text-right">No Price</TableHead>
                      <TableHead className="text-right">Volume</TableHead>
                      <TableHead className="text-right">Open Interest</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(selectedCityData?.markets ?? []).map((m: MarketItem) => {
                      const isForecastRange = selectedForecast?.forecastHigh != null &&
                        selectedForecast.forecastHigh >= (m?.tempRangeLow ?? 0) &&
                        selectedForecast.forecastHigh < (m?.tempRangeHigh ?? 0);
                      return (
                        <TableRow key={m?.id ?? ''} className={isForecastRange ? 'bg-orange-500/5' : ''}>
                          <TableCell className="font-mono font-medium">
                            {m?.tempRangeLow ?? 0}° - {m?.tempRangeHigh ?? 0}°F
                            {isForecastRange && <Badge variant="outline" className="ml-2 text-[9px] text-orange-400 border-orange-400/30">NWS</Badge>}
                          </TableCell>
                          <TableCell className="text-xs font-mono text-muted-foreground">{m?.kalshiMarketId ?? ''}</TableCell>
                          <TableCell className="text-right font-mono font-bold text-emerald-400">{m?.yesPrice ?? 0}¢</TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground">{m?.noPrice ?? 0}¢</TableCell>
                          <TableCell className="text-right font-mono">{m?.volume ?? 0}</TableCell>
                          <TableCell className="text-right font-mono">{m?.openInterest ?? 0}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </FadeIn>
      ) : (
        <Card className="border-border/50 bg-card/30">
          <CardContent className="p-12 text-center">
            <BarChart3 className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
            <p className="text-muted-foreground">Select a city above to view detailed market data</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

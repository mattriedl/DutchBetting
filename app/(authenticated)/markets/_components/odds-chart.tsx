'use client';

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine, Cell } from 'recharts';

interface OddsChartProps {
  markets: { tempRangeLow: number; tempRangeHigh: number; yesPrice: number; volume: number }[];
  forecast: number | null;
}

export function OddsChart({ markets, forecast }: OddsChartProps) {
  const data = (markets ?? []).map((m: any) => ({
    range: `${m?.tempRangeLow ?? 0}-${m?.tempRangeHigh ?? 0}`,
    yesPrice: m?.yesPrice ?? 0,
    volume: m?.volume ?? 0,
    isForecast: forecast != null && forecast >= (m?.tempRangeLow ?? 0) && forecast < (m?.tempRangeHigh ?? 0),
  }));

  if ((data?.length ?? 0) === 0) return <div className="flex items-center justify-center h-full text-muted-foreground">No data</div>;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 10, right: 10, bottom: 30, left: 10 }}>
        <XAxis
          dataKey="range"
          tickLine={false}
          tick={{ fontSize: 10 }}
          label={{ value: 'Temp Range (°F)', position: 'insideBottom', offset: -15, style: { textAnchor: 'middle', fontSize: 11 } }}
        />
        <YAxis
          tickLine={false}
          tick={{ fontSize: 10 }}
          label={{ value: 'Yes Price (¢)', angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fontSize: 11 } }}
        />
        <Tooltip
          contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(15,23,42,0.95)' }}
          labelStyle={{ fontSize: 11 }}
        />
        <Bar dataKey="yesPrice" radius={[4, 4, 0, 0]}>
          {(data ?? []).map((entry: any, index: number) => (
            <Cell
              key={`cell-${index}`}
              fill={entry?.isForecast ? '#f97316' : '#60B5FF'}
              fillOpacity={entry?.isForecast ? 1 : 0.7}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

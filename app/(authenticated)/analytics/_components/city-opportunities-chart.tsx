'use client';

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts';

const COLORS = ['#60B5FF', '#FF9149', '#FF9898', '#FF90BB', '#80D8C3'];

export function CityOpportunitiesChart({ analyses }: { analyses: any[] }) {
  const safeAnalyses = analyses ?? [];
  if (safeAnalyses.length === 0) return <div className="flex items-center justify-center h-full text-muted-foreground">No data available</div>;

  const data = safeAnalyses.map((a: any) => ({
    city: a?.city ?? 'Unknown',
    margin: Math.abs(a?.dutchBet?.profitMargin ?? 0),
    isViable: a?.dutchBet?.isViable ?? false,
  }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 5, right: 10, bottom: 30, left: 10 }}>
        <XAxis
          dataKey="city"
          tickLine={false}
          tick={{ fontSize: 10 }}
          angle={-30}
          textAnchor="end"
          height={50}
        />
        <YAxis
          tickLine={false}
          tick={{ fontSize: 10 }}
          label={{ value: 'Margin (%)', angle: -90, position: 'insideLeft', style: { fontSize: 11 } }}
        />
        <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(255,255,255,0.1)' }} />
        <Bar dataKey="margin" radius={[4, 4, 0, 0]}>
          {(data ?? []).map((entry: any, index: number) => (
            <Cell key={`cell-${index}`} fill={COLORS?.[index % COLORS.length] ?? '#60B5FF'} fillOpacity={0.8} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

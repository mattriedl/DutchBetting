'use client';

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts';

export function MarginDistributionChart({ analyses }: { analyses: any[] }) {
  const safeAnalyses = analyses ?? [];
  if (safeAnalyses.length === 0) return <div className="flex items-center justify-center h-full text-muted-foreground">No data available</div>;

  const data = safeAnalyses.map((a: any) => ({
    city: a?.city ?? 'Unknown',
    margin: a?.dutchBet?.profitMargin ?? 0,
  })).sort((a: any, b: any) => (b?.margin ?? 0) - (a?.margin ?? 0));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 5, right: 20, bottom: 5, left: 70 }}>
        <XAxis
          type="number"
          tickLine={false}
          tick={{ fontSize: 10 }}
          label={{ value: 'Margin (%)', position: 'insideBottom', offset: -5, style: { fontSize: 11 } }}
        />
        <YAxis
          type="category"
          dataKey="city"
          tickLine={false}
          tick={{ fontSize: 10 }}
          width={65}
        />
        <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(255,255,255,0.1)' }} />
        <Bar dataKey="margin" radius={[0, 4, 4, 0]}>
          {(data ?? []).map((entry: any, index: number) => (
            <Cell key={`cell-${index}`} fill={(entry?.margin ?? 0) >= 0 ? '#10b981' : '#ef4444'} fillOpacity={0.8} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

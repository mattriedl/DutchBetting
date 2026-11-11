'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import type { AutoRunJob, AutoRunRecord } from '@/lib/autorun-status';

/**
 * One-line "runs on its own" status for a page header: schedule badge plus the last run and last
 * results check. Renders nothing on hosts without the schedule (AUTORUN_ENABLED unset).
 */
export function AutoRunStatus({ runJob, settleJob, runLabel = 'every hour', settleLabel = 'every 3 hours' }: {
  runJob: AutoRunJob; settleJob: AutoRunJob; runLabel?: string; settleLabel?: string;
}) {
  const [data, setData] = useState<{ enabled: boolean; runs: Partial<Record<AutoRunJob, AutoRunRecord>> } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/autorun').then(r => (r.ok ? r.json() : null)).then(d => { if (alive) setData(d); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!data?.enabled) return null;
  const fmt = (r?: AutoRunRecord) =>
    r ? `${new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} — ${r.text}` : 'not yet since the last restart';
  const run = data.runs[runJob];
  const settle = data.runs[settleJob];
  return (
    <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[10px]">Auto-runs {runLabel}</Badge>
        <Badge variant="outline" className="font-mono text-[10px]">Results checked {settleLabel}</Badge>
      </div>
      <span>Last run: {fmt(run)}</span>
      <span>Last results check: {fmt(settle)}</span>
    </div>
  );
}

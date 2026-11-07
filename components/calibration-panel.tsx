'use client';

/**
 * Model Calibration panel.
 *
 * Surfaces the calibration feedback loop: metrics learned from settled bet
 * outcomes (win rate vs break-even, realized goal average vs the model's
 * target, low-scoring hit rate) and the resulting corrections that are fed
 * back into the research models (xG bias, confidence scale). Includes a
 * Recompute action that re-analyzes the full settled history.
 */

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Gauge, RefreshCw, TrendingUp, TrendingDown, Minus, Info } from 'lucide-react';
import { toast } from 'sonner';

export interface Calibration {
  sampleSize: number;
  scoredSample: number;
  wonCount: number;
  lostCount: number;
  winRate: number;
  impliedWinRate: number;
  avgActualGoals: number;
  avgCoveredGoals: number;
  xgBias: number;
  lowScoringThreshold: number;
  lowScoringHitRate: number;
  confidenceScale: number;
  brierScore: number | null;
  probSlope?: number | null;
  probIntercept?: number | null;
  probSample?: number | null;
  computedAt: string;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

export function CalibrationPanel({ className }: { className?: string }) {
  const [cal, setCal] = useState<Calibration | null>(null);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/calibration');
      const data = await res?.json?.();
      setCal(data?.calibration ?? null);
    } catch {
      // silent — panel just shows the empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const recompute = async () => {
    setRecomputing(true);
    try {
      const res = await fetch('/api/calibration/recompute', { method: 'POST' });
      const data = await res?.json?.();
      if (data?.calibration) {
        setCal(data.calibration);
        toast.success('Calibration recomputed from settled outcomes');
      } else {
        toast.error(data?.error ?? 'Recompute failed');
      }
    } catch {
      toast.error('Recompute failed');
    } finally {
      setRecomputing(false);
    }
  };

  const recomputeBtn = (
    <Button variant="outline" size="sm" onClick={recompute} disabled={recomputing}>
      <RefreshCw className={`w-4 h-4 mr-1 ${recomputing ? 'animate-spin' : ''}`} />
      Recompute
    </Button>
  );

  if (loading) {
    return <Skeleton className={`h-40 rounded-xl ${className ?? ''}`} />;
  }

  if (!cal || cal.sampleSize === 0) {
    return (
      <Card className={`bg-card/50 border-cyan-500/20 ${className ?? ''}`}>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Gauge className="w-4 h-4 text-cyan-400" /> Model Calibration
          </CardTitle>
          {recomputeBtn}
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No calibration computed yet. Once baskets settle, the model analyzes those outcomes to correct
            its expected-goals bias and confidence. Click Recompute to run it now.
          </p>
        </CardContent>
      </Card>
    );
  }

  const overconf = cal.confidenceScale < 0.98;
  const underconf = cal.confidenceScale > 1.02;
  const biasUp = cal.xgBias > 0.05;
  const biasDown = cal.xgBias < -0.05;

  return (
    <Card className={`bg-card/50 border-cyan-500/20 ${className ?? ''}`}>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Gauge className="w-4 h-4 text-cyan-400" /> Model Calibration
            <Badge variant="outline" className="border-cyan-500/40 text-cyan-300 text-[10px]">
              {cal.sampleSize} settled baskets
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Learned from settled outcomes and fed back into the research models
          </p>
        </div>
        {recomputeBtn}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Metric grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-lg border border-border/60 bg-background/40 p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Realized win rate</div>
            <div className="text-lg font-semibold mt-0.5">{pct(cal.winRate)}</div>
            <div className="text-[11px] text-muted-foreground">vs {pct(cal.impliedWinRate)} break-even</div>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/40 p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Avg actual goals</div>
            <div className="text-lg font-semibold mt-0.5">{cal.avgActualGoals.toFixed(2)}</div>
            <div className="text-[11px] text-muted-foreground">model targeted {cal.avgCoveredGoals.toFixed(2)}</div>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/40 p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Low-scoring (≤{cal.lowScoringThreshold})
            </div>
            <div className="text-lg font-semibold mt-0.5">{pct(cal.lowScoringHitRate)}</div>
            <div className="text-[11px] text-muted-foreground">of settled matches</div>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/40 p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Record</div>
            <div className="text-lg font-semibold mt-0.5">
              <span className="text-emerald-400">{cal.wonCount}W</span>
              {' '}–{' '}
              <span className="text-rose-400">{cal.lostCount}L</span>
            </div>
            <div className="text-[11px] text-muted-foreground">{cal.scoredSample} with final score</div>
          </div>
        </div>

        {/* Active corrections fed back into the model */}
        <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-cyan-200">
            <Info className="w-3.5 h-3.5" /> Active corrections applied to new research
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge
              variant="outline"
              className={`gap-1 ${biasUp ? 'border-amber-500/40 text-amber-300' : biasDown ? 'border-sky-500/40 text-sky-300' : 'border-border text-muted-foreground'}`}
            >
              {biasUp ? <TrendingUp className="w-3 h-3" /> : biasDown ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
              xG bias {cal.xgBias > 0 ? '+' : ''}{cal.xgBias.toFixed(2)} goals
            </Badge>
            <Badge
              variant="outline"
              className={`gap-1 ${overconf ? 'border-rose-500/40 text-rose-300' : underconf ? 'border-emerald-500/40 text-emerald-300' : 'border-border text-muted-foreground'}`}
            >
              {overconf ? <TrendingDown className="w-3 h-3" /> : underconf ? <TrendingUp className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
              confidence ×{cal.confidenceScale.toFixed(2)}
            </Badge>
            {cal.brierScore != null && (
              <Badge variant="outline" className="border-border text-muted-foreground">
                Brier {cal.brierScore.toFixed(3)}
              </Badge>
            )}
            {cal.probSlope != null && cal.probIntercept != null && (
              <Badge variant="outline" className="gap-1 border-cyan-500/40 text-cyan-300">
                reliability curve {cal.probSlope.toFixed(2)}× {cal.probIntercept >= 0 ? '+' : '−'}{Math.abs(cal.probIntercept * 100).toFixed(1)}pt
                {cal.probSample ? ` (n=${cal.probSample})` : ''}
              </Badge>
            )}
          </div>
          {cal.probSlope != null && cal.probIntercept != null && (
            <p className="text-[11px] text-cyan-300/80 leading-relaxed">
              Every stated probability is now re-mapped through the realized reliability curve fitted on {cal.probSample ?? 0} settled
              goals bets before edge and EV are computed — a raw 80% read becomes{' '}
              {pct(Math.max(0.02, Math.min(0.98, cal.probIntercept + cal.probSlope * 0.8)))}, and a raw 60% read becomes{' '}
              {pct(Math.max(0.02, Math.min(0.98, cal.probIntercept + cal.probSlope * 0.6)))}.
            </p>
          )}
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {biasUp && `The model has under-predicted goals — expected totals are nudged up by ${cal.xgBias.toFixed(2)}. `}
            {biasDown && `The model has over-predicted goals — expected totals are nudged down by ${Math.abs(cal.xgBias).toFixed(2)}. `}
            {!biasUp && !biasDown && 'Expected goals are well-calibrated — no bias correction. '}
            {overconf && 'Realized win rate trails break-even, so the model’s edge is shrunk to stay conservative.'}
            {underconf && 'Realized win rate beats break-even, so the model’s edge is nudged up slightly.'}
            {!overconf && !underconf && 'Win rate tracks break-even — confidence unchanged.'}
          </p>
        </div>

        <div className="text-[11px] text-muted-foreground">
          Last computed {new Date(cal.computedAt).toLocaleString('en-US')}
        </div>
      </CardContent>
    </Card>
  );
}

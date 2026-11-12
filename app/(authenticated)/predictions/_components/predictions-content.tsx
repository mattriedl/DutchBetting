'use client';

import { AutoRunStatus } from '@/components/auto-run-status';
import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { FadeIn, Stagger, StaggerItem } from '@/components/animations';
import {
  ListChecks,
  Loader2,
  Download,
  CheckCircle2,
  XCircle,
  Clock,
  Gauge,
  KeyRound,
} from 'lucide-react';

interface ExternalPrediction {
  id: string;
  source: string;
  league: string;
  matchKey: string;
  matchTitle: string;
  teamA: string;
  teamB: string;
  matchDate: string | null;
  market: string;
  prediction: string;
  line: number | null;
  probability: number | null;
  advice: string | null;
  status: string;
  actualResult: string | null;
  correct: boolean | null;
  finalScore: string | null;
  fetchedAt: string;
}

interface SourceAccuracy {
  source: string;
  market: string;
  settled: number;
  correct: number;
  hitRate: number | null;
  brier: number | null;
  open: number;
}

interface SourceMeta {
  id: string;
  label: string;
  detail: string;
}

const MARKET_LABEL: Record<string, string> = {
  total_goals: 'Total goals',
  btts: 'Both teams to score',
  match_result: 'Match result',
};

function sourceLabel(id: string, sources: SourceMeta[]): string {
  return sources.find(s => s.id === id)?.label ?? id;
}

function pct(x: number | null | undefined, digits = 1): string {
  if (x == null) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

export function PredictionsContent() {
  const [rows, setRows] = useState<ExternalPrediction[]>([]);
  const [accuracy, setAccuracy] = useState<SourceAccuracy[]>([]);
  const [sources, setSources] = useState<SourceMeta[]>([]);
  const [footystatsConfigured, setFootystatsConfigured] = useState(true);
  const [apiFootballConfigured, setApiFootballConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [ingesting, setIngesting] = useState(false);
  const [settling, setSettling] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');

  const load = useCallback(async (status: string, source: string) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ status });
      if (source !== 'all') qs.set('source', source);
      const res = await fetch(`/api/external-predictions?${qs.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Failed to load');
      setRows(data.predictions ?? []);
      setAccuracy(data.accuracy ?? []);
      setSources(data.sources ?? []);
      setFootystatsConfigured(!!data.footystatsConfigured);
      setApiFootballConfigured(!!data.apiFootballConfigured);
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to load predictions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(statusFilter, sourceFilter);
  }, [load, statusFilter, sourceFilter]);

  const ingest = async () => {
    setIngesting(true);
    toast.info('Pulling third-party predictions for every tradeable match…');
    try {
      const res = await fetch('/api/external-predictions/ingest', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Ingest failed');
      const s = data.summary;
      toast.success(
        `${s.matchesConsidered} matches scanned · API-Football ${s.apiFootball.added} new, ${s.apiFootball.refreshed ?? 0} refreshed, ${s.apiFootball.skippedRecent ?? 0} up to date · FootyStats ${
          s.footystats.needsKey ? 'skipped (no key)' : `matched ${s.footystats.matched}, ${s.footystats.added} new, ${s.footystats.refreshed ?? 0} refreshed`
        }`,
      );
      await load(statusFilter, sourceFilter);
    } catch (err: any) {
      toast.error(err?.message ?? 'Ingest failed');
    } finally {
      setIngesting(false);
    }
  };

  const settle = async () => {
    setSettling(true);
    try {
      const res = await fetch('/api/external-predictions/settle', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Settle failed');
      const s = data.summary;
      toast.success(`Graded ${s.settled} of ${s.checked} (${s.correct} correct, ${s.unresolved} still pending, ${s.abandoned ?? 0} voided).`);
      await load(statusFilter, sourceFilter);
    } catch (err: any) {
      toast.error(err?.message ?? 'Settle failed');
    } finally {
      setSettling(false);
    }
  };

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-lg shadow-amber-500/20">
              <ListChecks className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold tracking-tight">External Predictions</h1>
              <p className="text-sm text-muted-foreground max-w-2xl">
                Third-party forecasts for the matches we can actually bet, graded against the real result. Each source builds a
                track record, and that track record is fed back into the research prompts of every app so the AI weights outside
                opinions by how often they have actually been right.
              </p>
              <AutoRunStatus runJob="predictions-ingest" settleJob="predictions-settle" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={ingest} disabled={ingesting} className="gap-2">
              {ingesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {ingesting ? 'Pulling…' : 'Pull predictions'}
            </Button>
            <Button onClick={settle} disabled={settling} variant="outline" className="gap-2">
              {settling ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Grade finished
            </Button>
          </div>
        </div>
      </FadeIn>

      {/* Source status */}
      <FadeIn>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Sources</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(sources ?? []).map(s => {
              const ok = s.id === 'api_football' ? apiFootballConfigured : footystatsConfigured;
              return (
                <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">{s.label}</p>
                    <p className="text-[11px] text-muted-foreground">{s.detail}</p>
                  </div>
                  {ok ? (
                    <Badge variant="outline" className="border-emerald-500/40 text-emerald-300 text-[10px] gap-1">
                      <CheckCircle2 className="w-3 h-3" /> connected
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-amber-500/40 text-amber-300 text-[10px] gap-1">
                      <KeyRound className="w-3 h-3" /> needs API key
                    </Badge>
                  )}
                </div>
              );
            })}
            {!footystatsConfigured && (
              <p className="text-[11px] text-amber-300/90 leading-relaxed">
                FootyStats&apos; public prediction pages sit behind Cloudflare and refuse any server-side request, so they cannot
                be scraped from the hosted app. The identical mathematical numbers (over/under 2.5 potential, BTTS potential)
                are served by their official API, which needs a paid key — add it as{' '}
                <span className="font-mono text-foreground">FOOTYSTATS_API_KEY</span> and both FootyStats sources start tracking
                immediately. Until then they stay empty rather than showing invented data.
              </p>
            )}
          </CardContent>
        </Card>
      </FadeIn>

      {/* Accuracy scoreboard */}
      <FadeIn>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Gauge className="w-4 h-4" /> Accuracy scoreboard
            </CardTitle>
          </CardHeader>
          <CardContent>
            {accuracy.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4">
                Nothing graded yet. Pull predictions, then grade them once those matches finish.
              </p>
            ) : (
              <div className="space-y-2">
                {accuracy.map(a => (
                  <div
                    key={`${a.source}|${a.market}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2"
                  >
                    <div>
                      <span className="text-sm font-medium">{sourceLabel(a.source, sources)}</span>
                      <span className="text-xs text-muted-foreground ml-2">{MARKET_LABEL[a.market] ?? a.market}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-4 text-xs font-mono">
                      <span className="text-muted-foreground">
                        {a.correct}/{a.settled} graded · {a.open} open
                      </span>
                      <span
                        className={
                          a.hitRate == null
                            ? 'text-muted-foreground'
                            : a.hitRate >= 0.55
                              ? 'text-emerald-400'
                              : a.hitRate >= 0.5
                                ? 'text-foreground'
                                : 'text-rose-400'
                        }
                      >
                        {pct(a.hitRate)} correct
                      </span>
                      <span className="text-muted-foreground">Brier {a.brier != null ? a.brier.toFixed(4) : '—'}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </FadeIn>

      {/* Rows */}
      <FadeIn>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 pb-3 flex-wrap">
            <CardTitle className="text-sm">Tracked predictions</CardTitle>
            <div className="flex gap-2">
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger className="w-[190px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  {(sources ?? []).map(s => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[130px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="settled">Graded</SelectItem>
                  <SelectItem value="void">Voided</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-12 text-center">
                No predictions on file yet — hit <span className="font-medium text-foreground">Pull predictions</span>.
              </p>
            ) : (
              <Stagger className="space-y-2">
                {rows.map(r => {
                  const isSettled = r.status === 'settled';
                  return (
                    <StaggerItem key={r.id}>
                      <div
                        className={`rounded-lg border p-3 ${
                          isSettled
                            ? r.correct
                              ? 'border-emerald-500/30 bg-emerald-500/5'
                              : 'border-rose-500/30 bg-rose-500/5'
                            : 'border-border'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              {isSettled ? (
                                r.correct ? (
                                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                                ) : (
                                  <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                                )
                              ) : (
                                <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
                              )}
                              <span className="text-sm font-medium">{r.matchTitle}</span>
                              <Badge variant="outline" className="border-amber-500/40 text-amber-300 text-[10px]">
                                {sourceLabel(r.source, sources)}
                              </Badge>
                              <span className="text-[11px] text-muted-foreground font-mono">{r.league}</span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              {MARKET_LABEL[r.market] ?? r.market}:{' '}
                              <span className="text-foreground font-medium">
                                {r.prediction}
                                {r.line != null ? ` ${r.line}` : ''}
                              </span>
                              {r.probability != null ? ` @ ${pct(r.probability, 0)}` : ''}
                              {r.matchDate ? ` · ${r.matchDate.slice(0, 10)}` : ''}
                            </p>
                            {r.advice && <p className="text-[11px] text-muted-foreground mt-0.5">{r.advice}</p>}
                          </div>
                          <div className="text-xs font-mono text-right">
                            {isSettled ? (
                              <>
                                <p className={r.correct ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                                  {r.correct ? 'correct' : 'wrong'}
                                </p>
                                <p className="text-muted-foreground">
                                  {r.actualResult}
                                  {r.finalScore ? ` · ${r.finalScore}` : ''}
                                </p>
                              </>
                            ) : (
                              <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">
                                awaiting result
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </StaggerItem>
                  );
                })}
              </Stagger>
            )}
          </CardContent>
        </Card>
      </FadeIn>
    </div>
  );
}

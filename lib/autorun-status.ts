/**
 * In-process record of the last run of each scheduled job, shown on the pages so it's visible that
 * they run on their own. Resets on restart/deploy (the next scheduled run fills it again).
 */
export type AutoRunJob =
  | 'dashboard-refresh' | 'dashboard-settle'
  | 'value-run' | 'value-settle'
  | 'predictions-ingest' | 'predictions-settle';

export interface AutoRunRecord { at: string; automated: boolean; text: string }

const runs = new Map<AutoRunJob, AutoRunRecord>();

export function recordRun(job: AutoRunJob, automated: boolean, text: string) {
  runs.set(job, { at: new Date().toISOString(), automated, text });
}

export function getRuns(): Partial<Record<AutoRunJob, AutoRunRecord>> {
  return Object.fromEntries(runs) as Partial<Record<AutoRunJob, AutoRunRecord>>;
}

/** True on hosts where the server's timers call these jobs (test site: AUTORUN_ENABLED=true). */
export function autoRunEnabled(): boolean {
  return process.env.AUTORUN_ENABLED === 'true';
}

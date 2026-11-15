/**
 * STARTUP-FREEZE-104 A4: the startup-budget check as Settings shows it. main's stallWatch watches the
 * first 120 s after window-ready for any main-thread block of >= 250 ms. At the end of that window,
 * main saves the verdict to userData/startup-budget.json (main-only, one small async write per
 * start). Settings shows the last saved verdict, and "being checked" while this start's window runs.
 */

/** One start's verdict (the 'startup-budget' log row, plus when it was decided). */
export interface StartupBudgetVerdict {
  ok: boolean;
  breaches: number;
  worstMs: number;
  budgetMs: number;
  windowMs: number;
  /** ISO time the verdict was decided. */
  at: string;
}

export interface StartupBudgetView {
  /** stallWatch is on (config `stallWatch: false` turns the check off too). */
  enabled: boolean;
  /** This start's window is still running. */
  pending: boolean;
  /** The last saved verdict (this start's once decided, else the previous start's); null if none yet. */
  last: StartupBudgetVerdict | null;
}

export const STARTUP_BUDGET_FILE = 'startup-budget.json';

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A saved verdict, validated (the file is main's own, but a torn or edited one is "none"). */
export function parseStartupVerdict(v: unknown): StartupBudgetVerdict | null {
  const r = v as Partial<StartupBudgetVerdict> | null;
  if (!r || typeof r !== 'object' || typeof r.ok !== 'boolean') return null;
  if (!fin(r.breaches) || !fin(r.worstMs) || !fin(r.budgetMs) || !fin(r.windowMs)) return null;
  if (typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) return null;
  if (r.ok !== (r.breaches === 0)) return null;
  return { ok: r.ok, breaches: Math.floor(r.breaches), worstMs: Math.round(r.worstMs), budgetMs: r.budgetMs, windowMs: r.windowMs, at: r.at };
}

const secs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

export const STARTUP_HEALTH_COPY = {
  heading: 'Startup health',
  off: 'Not checked: the stall watch is off (config stallWatch: false).',
  none: 'No startup checked yet. Guppy checks the first 2 minutes after its window opens.',
  pending: 'Checking this start (the first 2 minutes after the window opened)…',
  help: 'Guppy watches its own main thread for the first 2 minutes after the window opens. A pause of a '
    + 'quarter of a second or more is a slow moment: the window can feel frozen during it. Each one is '
    + 'also written to the log (startup-budget-breach) with what was running.'
};

/** The line Settings shows. */
export function startupHealthLine(v: StartupBudgetView | null): string {
  if (!v) return 'Startup health: …';
  if (!v.enabled) return STARTUP_HEALTH_COPY.off;
  const last = v.last;
  const when = last ? new Date(last.at).toLocaleString() : '';
  const verdict = !last
    ? null
    : last.ok
      ? `Last start (${when}): smooth, no main-thread pause of ${secs(last.budgetMs)} or more.`
      : `Last start (${when}): ${last.breaches} slow moment${last.breaches === 1 ? '' : 's'}, the worst ${secs(last.worstMs)} (limit ${secs(last.budgetMs)}).`;
  if (v.pending) return verdict ? `${STARTUP_HEALTH_COPY.pending} ${verdict}` : STARTUP_HEALTH_COPY.pending;
  return verdict ?? STARTUP_HEALTH_COPY.none;
}

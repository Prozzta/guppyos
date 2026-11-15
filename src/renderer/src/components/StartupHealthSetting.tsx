/**
 * STARTUP-FREEZE-104 A4: Settings -> General -> Startup health. A read-only line with the last
 * startup-budget verdict (src/shared/startupBudget.ts): smooth, or how many slow moments and the
 * worst. Re-read while the section is open, so the pending state turns into this start's verdict.
 */
import { useEffect, useState } from 'react';
import { STARTUP_HEALTH_COPY, startupHealthLine, type StartupBudgetView } from '@shared/startupBudget';

/** How often the open section re-reads the verdict (one IPC call and one small file read in main). */
export const STARTUP_HEALTH_REFRESH_MS = 10_000;

export function StartupHealthSetting() {
  const [view, setView] = useState<StartupBudgetView | null>(null);

  useEffect(() => {
    const refresh = () => { void window.cth.startupBudget().then(setView).catch(() => { /* the line stays as it is */ }); };
    refresh();
    const timer = window.setInterval(refresh, STARTUP_HEALTH_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const bad = !!view?.last && !view.last.ok;
  return (
    <div data-startup-health="">
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
      }}>
        {STARTUP_HEALTH_COPY.heading}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span data-startup-health-line="" data-ok={view?.last ? String(view.last.ok) : ''} style={{ fontSize: 13, lineHeight: '20px', color: bad ? 'var(--cth-status-blocked)' : 'var(--cth-ink-900)' }}>
          {startupHealthLine(view)}
        </span>
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{STARTUP_HEALTH_COPY.help}</span>
      </div>
    </div>
  );
}

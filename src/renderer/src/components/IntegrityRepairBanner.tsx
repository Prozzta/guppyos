import { useEffect, useState } from 'react';
import type { IntegrityIssue } from '../../../preload';

/** A damaged authority file must be noticeable before a human tries a write.
 * Main deliberately keeps read-only views alive with safe defaults, while this
 * banner explains why floor/config changes are paused. */
export function IntegrityRepairBanner() {
  const [issues, setIssues] = useState<IntegrityIssue[]>([]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void Promise.all([window.cth.hiveIntegrity(), window.cth.configIntegrity()])
        .then(([hive, config]) => {
          if (alive) setIssues(config ? [...hive, config] : hive);
        })
        .catch(() => { /* IPC recovery must not disturb the office UI */ });
    };
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  if (!issues.length) return null;
  return (
    <div role="alert" aria-live="assertive" data-integrity-repair-banner="" style={{
      position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 45,
      width: 'min(620px, calc(100% - 32px))', padding: '9px 12px',
      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1.5px var(--cth-status-blocked)',
      fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)', display: 'flex', flexDirection: 'column', gap: 3
    }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>Hive data needs repair — changes are paused.</span>
      {issues.map((issue) => (
        <span key={`${issue.file}:${issue.quarantine ?? ''}`} style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>
          {issue.file} is corrupt.{issue.quarantine ? ` Saved copy: ${issue.quarantine}.` : ''} Repair the original, then retry.
        </span>
      ))}
    </div>
  );
}

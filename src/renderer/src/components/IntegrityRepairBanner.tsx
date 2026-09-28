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
          // A malformed answer must never take the whole window down (it rendered inside App):
          // keep only well-formed issues.
          const valid = (x: unknown): x is IntegrityIssue => !!x && typeof x === 'object' && typeof (x as IntegrityIssue).file === 'string';
          const list = [...(Array.isArray(hive) ? hive : []), ...(config ? [config] : [])].filter(valid);
          if (alive) setIssues(list);
        })
        .catch(() => { /* IPC recovery must not disturb the office UI */ });
    };
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  if (!issues.length) return null;
  // ZT-I1-MAIL: a rebuilt mail ledger is a notice, not a pause: the harness already rebuilt it
  // from the log and the inbox, and re-delivers anything it could not prove was handled.
  const paused = issues.some((issue) => !issue.repaired);
  return (
    <div role="alert" aria-live="assertive" data-integrity-repair-banner="" style={{
      position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 45,
      width: 'min(620px, calc(100% - 32px))', padding: '9px 12px',
      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1.5px var(--cth-status-blocked)',
      fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)', display: 'flex', flexDirection: 'column', gap: 3
    }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{paused ? 'Hive data needs repair — changes are paused.' : 'Hive mail records were damaged and have been rebuilt.'}</span>
      {issues.map((issue) => (
        <span key={`${issue.file}:${issue.quarantine ?? ''}`} style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>
          {issue.repaired
            ? `${issue.file} was corrupt and was rebuilt from the log and the inbox; mail it could not prove handled is re-delivered, marked as possibly handled.${issue.quarantine ? ` Saved copy: ${issue.quarantine}.` : ''}`
            : `${issue.file} is corrupt.${issue.quarantine ? ` Saved copy: ${issue.quarantine}.` : ''} Repair the original, then retry.`}
        </span>
      ))}
    </div>
  );
}

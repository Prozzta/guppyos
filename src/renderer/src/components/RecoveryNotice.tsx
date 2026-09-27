/**
 * RENDERER-RECOVERY-164: after the window's view crashed and main brought it back (a reload,
 * or a recreated window), say so once. Main keeps the notice for this webContents and hands
 * it over exactly once; nothing here polls or pings main.
 */
import { useEffect, useState } from 'react';

type Notice = { at: number; action: 'reload' | 'recreate'; reason: string; streak: number };

export function RecoveryNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    let alive = true;
    void window.cth.takeRecoveryNotice?.().then((n) => { if (alive && n) setNotice(n); }).catch(() => { /* older main */ });
    return () => { alive = false; };
  }, []);
  if (!notice) return null;
  const time = new Date(notice.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div
      role="status"
      data-testid="recovery-notice"
      style={{
        position: 'fixed', left: 16, bottom: 16, zIndex: 1000, maxWidth: 360,
        padding: '10px 12px', background: 'var(--cth-paper-100, #fff)', color: 'var(--cth-ink-900, #1d1d1b)',
        border: '2px solid var(--cth-ink-900, #1d1d1b)', boxShadow: '4px 4px 0 var(--cth-ink-900, #1d1d1b)',
        fontFamily: 'var(--cth-font-ui, system-ui)', fontSize: 12.5, lineHeight: 1.5
      }}
    >
      <strong>The view crashed and was restored at {time}.</strong>{' '}
      Your agents kept running. Terminal history from before the crash is not shown again; new output appears as usual.
      <button type="button" onClick={() => setNotice(null)} style={{ marginLeft: 8, fontSize: 12 }}>OK</button>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';

/** MEMPALACE-REMOVAL: the memory engine's status (mirrors the preload's MemoryStatus). */
interface MemoryStatus {
  enabled: boolean;
  available: boolean;
  reason: 'disabled' | 'no-hive' | 'no-runtime' | 'shim-failed' | null;
  index: { sources?: number; chunks?: number; dbBytes?: number } | null;
  legacy: { paths: string[]; bytes: number } | null;
}

const mb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1048576))} MB`;

/** Plain-language reason memory cannot run (the pill's "Unavailable" line). */
const WHY: Record<string, string> = {
  'no-hive': 'No hive folder is set up yet.',
  'no-runtime': 'The memory engine is missing from this install. Reinstalling the app restores it.',
  'shim-failed': "The memory command couldn't be written into the hive folder."
};

/**
 * Lets the human search the shared memory agents build up across sessions and turn it on or
 * off. Agents read and write the same memory through the memory engine; this is the
 * human-facing window into it. Since 1.1.59 there is nothing to install and no model to pick:
 * the engine is built in. Old MemPalace data, if any is left on disk, can be deleted here.
 */
export function MemoryPanel() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [legacyNote, setLegacyNote] = useState<string>('');

  const refreshStatus = async () => {
    try { setStatus(await window.cth.memoryStatus()); } catch { /* ignore */ }
  };
  useEffect(() => { refreshStatus(); }, []);

  const toggleEnabled = async () => {
    await window.cth.updateConfig({ semanticMemory: !(status?.enabled ?? true) });
    await refreshStatus();
  };

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setResult('');
    try {
      const res = await window.cth.searchMemory(query.trim());
      setResult(res.ok ? (res.output || 'Nothing matched yet.') : `Couldn't search: ${res.error}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteLegacy = async () => {
    setLegacyNote('');
    const r = await window.cth.deleteLegacyMemoryData();
    if (r.ok) setLegacyNote(r.paths.length ? `Deleted ${mb(r.bytes)} of old MemPalace data.` : 'Nothing to delete.');
    else if (!('cancelled' in r && r.cancelled)) {
      setLegacyNote(`Nothing was deleted: ${r.error}.${r.locked.length ? ` In use: ${r.locked.slice(0, 3).join(', ')}${r.locked.length > 3 ? ` and ${r.locked.length - 3} more` : ''}. Close whatever holds them (an old MemPalace process, or restart the PC) and try again.` : ''}`);
    }
    await refreshStatus();
  };

  const active = !!status?.available;
  const pill = '🧠 memory';

  // One clear state line: is memory working, off, or unavailable (and why)?
  const state: { dot: string; label: string } = !status
    ? { dot: 'var(--cth-ink-500)', label: '…' }
    : !status.enabled
      ? { dot: 'var(--cth-ink-500)', label: 'Off' }
      : !status.available
        ? { dot: 'var(--cth-coral)', label: 'Unavailable' }
        : typeof status.index?.sources === 'number'
          ? { dot: 'var(--cth-mint)', label: `On · ${status.index.sources} notes indexed` }
          : { dot: 'var(--cth-lemon)', label: 'On · getting ready…' };

  return (
    <div style={{ position: 'absolute', bottom: 12, left: 12, width: open ? 380 : 'auto', zIndex: 40 }}>
      {!open ? (
        <button
          onClick={() => { setOpen(true); refreshStatus(); }}
          title="Search the shared memory your agents build up"
          style={{
            padding: '5px 10px 3px',
            background: active ? 'var(--cth-lemon-light)' : 'var(--cth-cream-200)',
            boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 12,
            color: 'var(--cth-ink-900)',
            cursor: 'pointer',
            border: 'none'
          }}
        >
          {pill}
        </button>
      ) : (
        <PixelPanel variant="dialog" title="HIVE MEMORY" noPadding>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14 }}>

            {/* What this is — one plain line. */}
            <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.5 }}>
              What your agents remember across sessions, shared between them. Search it by meaning, not just exact words.
            </div>

            {/* Status + on/off — the two things the user controls at a glance. */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)' }}>
                <span style={{ width: 9, height: 9, background: state.dot, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }} />
                {state.label}
              </span>
              {status && (
                <PixelButton
                  variant={status.enabled ? 'secondary' : 'primary'}
                  size="sm"
                  onClick={toggleEnabled}
                >
                  {status.enabled ? 'Turn off' : 'Turn on'}
                </PixelButton>
              )}
            </div>

            {status?.enabled && !status.available && status.reason && WHY[status.reason] && (
              <div style={{ fontSize: 11, color: 'var(--cth-ink-700)', lineHeight: 1.45, background: 'var(--cth-cream-100)', padding: 8 }}>
                {WHY[status.reason]} Agents still keep plain notes in memory.md.
              </div>
            )}

            {/* Search the memory. */}
            {active && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
                    placeholder="Search by meaning…"
                    style={{
                      flex: 1, padding: '6px 8px 4px',
                      background: 'var(--cth-paper-100)', border: 'none',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                      color: 'var(--cth-ink-900)', outline: 'none'
                    }}
                  />
                  <PixelButton variant="primary" size="sm" onClick={run} disabled={busy}>
                    {busy ? '…' : 'Search'}
                  </PixelButton>
                </div>
                {result && (
                  <pre style={{
                    margin: 0, maxHeight: '40vh', overflow: 'auto',
                    background: 'var(--cth-cream-100)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                    padding: 8, fontFamily: 'var(--cth-font-mono)', fontSize: 12,
                    whiteSpace: 'pre-wrap', color: 'var(--cth-ink-900)'
                  }}>{result}</pre>
                )}
              </div>
            )}

            {/* Old MemPalace data: shown only while some is left; deleted only on request. */}
            {status?.legacy && (
              <div style={{ fontSize: 11, color: 'var(--cth-ink-700)', lineHeight: 1.45, background: 'var(--cth-cream-100)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span>
                  Old MemPalace data ({mb(status.legacy.bytes)}) is still on disk at {status.legacy.paths[0]}. The app no longer uses it.
                </span>
                <div>
                  <PixelButton variant="secondary" size="sm" onClick={deleteLegacy}>
                    Delete old MemPalace data ({mb(status.legacy.bytes)})
                  </PixelButton>
                </div>
              </div>
            )}
            {legacyNote && (
              <div style={{ fontSize: 11, color: 'var(--cth-ink-700)', lineHeight: 1.45 }}>{legacyNote}</div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--cth-ink-300)', paddingTop: 10 }}>
              <PixelButton variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</PixelButton>
            </div>
          </div>
        </PixelPanel>
      )}
    </div>
  );
}

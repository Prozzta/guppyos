/**
 * GUPPY-BLOB-P01 — Settings → General → Guppy blob.
 *
 * Its own section with its own save lifecycle (like GraphicsSetting): it reads main's blob status
 * and saves only the blob fields through `blob:setConfig`, which main accepts from an app window
 * and never from the overlay itself. Each change applies at once (no restart).
 */
import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { BLOB_DEFAULT_HOTKEY, isValidBlobHotkey, type BlobSettingsPatch, type BlobStatus } from '@shared/blob';

export const BLOB_COPY = {
  heading: 'Guppy blob',
  enable: 'Show the Guppy blob',
  enableHelp: 'A small always-on-top blob. Click it for the action ring; drag it anywhere. It never takes focus from the app you are typing in.',
  hotkey: 'Show/hide hotkey',
  hotkeyHelp: `Modifiers then one key, e.g. ${BLOB_DEFAULT_HOTKEY}. Leave blank for no hotkey.`,
  hotkeyTaken: 'Not registered: another app holds this hotkey. Pick another.',
  invisible: 'Hide the blob from screen shares',
  invisibleHelp: 'Screenshots, recordings and screen shares leave the blob out (Windows 10 2004 or later).',
  invisibleMain: 'Hide Guppy\'s own windows from screen shares',
  invisibleMainHelp: 'The same for the main window and every floor. Works even when the blob is off.',
  failed: 'The blob settings could not be saved.'
};

const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } as const;
const titleStyle = { fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' } as const;
const helpStyle = { fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' } as const;
const inputStyle = {
  fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 12, padding: '4px 6px', width: 180,
  border: '1px solid var(--cth-ink-300)', background: 'var(--cth-paper-50, #fff)', color: 'var(--cth-ink-900)'
} as const;

function Toggle({ on, busy, onClick }: { on: boolean; busy: boolean; onClick: () => void }) {
  return <PixelButton variant={on ? 'primary' : 'secondary'} size="sm" onClick={onClick} disabled={busy}>{on ? 'on' : 'off'}</PixelButton>;
}

export function BlobSetting() {
  const [status, setStatus] = useState<BlobStatus | null>(null);
  const [hotkey, setHotkey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.cth.blobStatus().then((r) => {
      if (!live || !r.ok) return;
      setStatus(r.status);
      setHotkey(r.status.hotkey);
    }).catch(() => { /* section stays empty */ });
    return () => { live = false; };
  }, []);

  const save = async (patch: BlobSettingsPatch): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const r = await window.cth.blobSetConfig(patch);
      if (r.ok) { setStatus(r.status); setHotkey(r.status.hotkey); } else setError(r.error);
    } catch {
      setError(BLOB_COPY.failed);
    } finally { setBusy(false); }
  };

  if (!status) return null;
  const hotkeyDraft = hotkey.trim();
  const hotkeyValid = isValidBlobHotkey(hotkeyDraft);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="blob-setting">
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
      }}>
        {BLOB_COPY.heading}
      </div>

      <div style={rowStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={titleStyle}>{BLOB_COPY.enable}</span>
          <span style={helpStyle}>{BLOB_COPY.enableHelp}</span>
        </div>
        <Toggle on={status.enabled} busy={busy} onClick={() => void save({ enabled: !status.enabled })} />
      </div>

      {status.enabled && (
        <>
          <div style={rowStyle}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={titleStyle}>{BLOB_COPY.hotkey}</span>
              <span style={helpStyle}>{BLOB_COPY.hotkeyHelp}</span>
              {status.hotkey !== '' && !status.hotkeyRegistered && (
                <span style={{ ...helpStyle, color: 'var(--cth-danger-600, #b3261e)' }}>{BLOB_COPY.hotkeyTaken}</span>
              )}
            </div>
            <input
              aria-label={BLOB_COPY.hotkey}
              value={hotkey}
              placeholder={BLOB_DEFAULT_HOTKEY}
              onChange={(e) => setHotkey(e.target.value)}
              onBlur={() => { if (hotkeyValid && hotkeyDraft !== status.hotkey) void save({ hotkey: hotkeyDraft }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              style={{ ...inputStyle, borderColor: hotkeyValid ? 'var(--cth-ink-300)' : 'var(--cth-danger-600, #b3261e)' }}
            />
          </div>

          <div style={rowStyle}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={titleStyle}>{BLOB_COPY.invisible}</span>
              <span style={helpStyle}>{BLOB_COPY.invisibleHelp}</span>
            </div>
            <Toggle on={status.invisible} busy={busy} onClick={() => void save({ invisible: !status.invisible })} />
          </div>
        </>
      )}

      <div style={rowStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={titleStyle}>{BLOB_COPY.invisibleMain}</span>
          <span style={helpStyle}>{BLOB_COPY.invisibleMainHelp}</span>
        </div>
        <Toggle on={status.invisibleMain} busy={busy} onClick={() => void save({ invisibleMain: !status.invisibleMain })} />
      </div>

      {error && <span style={{ ...helpStyle, color: 'var(--cth-danger-600, #b3261e)' }}>{error}</span>}
    </div>
  );
}

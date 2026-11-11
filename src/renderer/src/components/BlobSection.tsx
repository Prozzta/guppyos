/**
 * BLOB-SETUP-GUIDE (Part B): Settings → Blob. One place for everything the Blob needs: the
 * set-up guide, the user's own Groq API key, and the overlay settings (BlobSetting: show/hide,
 * hotkey, invisible, dictation).
 *
 * The key is the SAME `groqApiKey` the Voice tab edits (Free Flow uses it too), so SettingsModal
 * owns the draft and hands it down: both tabs show one value and neither can save a stale copy
 * over the other. Saving here sends only the key, never Free Flow's on/off or model, so existing
 * configs keep their Voice settings untouched.
 */
import { PixelButton } from './PixelButton';
import { BlobSetting } from './BlobSetting';
import { BLOB_SETUP_GUIDE_URL } from '@shared/blob';

export const BLOB_SECTION_COPY = {
  guide: 'How to set up your Blob',
  guideHelp: 'A five-minute guide: a free Groq key, turning on dictation, a test and troubleshooting. Opens in your browser.',
  keyLabel: 'Groq API key',
  keyHelp: 'Your own free key from console.groq.com. Blob dictation sends the audio you record to Groq with this key. The Voice tab uses the same key.',
  keyPlaceholder: 'gsk_... (get a free key at console.groq.com)',
  save: 'save',
  saved: 'saved',
  cleared: 'key removed'
};

const helpStyle = { fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' } as const;
const labelStyle = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase'
} as const;
const inputStyle = {
  flex: 1, fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 12, padding: '4px 6px',
  border: '1px solid var(--cth-ink-300)', background: 'var(--cth-paper-50, #fff)', color: 'var(--cth-ink-900)'
} as const;

export interface BlobSectionProps {
  groqKey: string;
  setGroqKey: (v: string) => void;
  showGroqKey: boolean;
  setShowGroqKey: (fn: (v: boolean) => boolean) => void;
  onSaveKey: () => void;
  busy: boolean;
  note: string;
}

export function BlobSection(p: BlobSectionProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div
        data-testid="blob-setup-guide"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 10, border: '2px solid var(--cth-ink-900)', background: 'var(--cth-lemon-light, var(--cth-paper-100))' }}
      >
        <span style={helpStyle}>{BLOB_SECTION_COPY.guideHelp}</span>
        <PixelButton variant="primary" size="sm" onClick={() => void window.cth.openExternal(BLOB_SETUP_GUIDE_URL)}>
          {BLOB_SECTION_COPY.guide}
        </PixelButton>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>{BLOB_SECTION_COPY.keyLabel}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            data-testid="blob-groq-key"
            type={p.showGroqKey ? 'text' : 'password'}
            value={p.groqKey}
            onChange={(e) => p.setGroqKey(e.target.value)}
            placeholder={BLOB_SECTION_COPY.keyPlaceholder}
            style={inputStyle}
          />
          <PixelButton variant="secondary" size="sm" onClick={() => p.setShowGroqKey((v) => !v)} disabled={!p.groqKey}>
            {p.showGroqKey ? 'hide' : 'show'}
          </PixelButton>
          <PixelButton variant="ghost" size="sm" onClick={p.onSaveKey} disabled={p.busy}>
            {BLOB_SECTION_COPY.save}
          </PixelButton>
        </div>
        <span style={helpStyle}>{BLOB_SECTION_COPY.keyHelp}{p.note ? ` (${p.note})` : ''}</span>
      </label>

      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

      <BlobSetting />
    </div>
  );
}

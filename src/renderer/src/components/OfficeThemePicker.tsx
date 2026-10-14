import { useState } from 'react';
import type { HarnessConfig } from '@/store/config';
import { useStore } from '@/store/store';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import type { ThemeId } from '@/scene/office/themeRegistry';
import { projectTheme, PROJECT_THEMES, resolveProjectTheme, type ProjectThemeId } from '@shared/projectTheme';

/** Project-scoped theme picker. Switching a populated project changes only its
 * presentation; default people and looks are intentionally creation-only. */
export function OfficeThemePicker({ config }: { config: HarnessConfig }) {
  const [enabled, setEnabled] = useState(!!config.tvShowOffices);
  const [current, setCurrent] = useState<ProjectThemeId>(resolveProjectTheme(config, config.harnessHome));
  const [pending, setPending] = useState<ProjectThemeId | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const setOfficeTheme = useStore((s) => s.setOfficeTheme);

  const toggleFlag = async () => {
    const next = !enabled;
    setEnabled(next);
    try {
      await window.cth.updateConfig({ tvShowOffices: next });
      setOfficeTheme(next ? projectTheme(current).sceneTheme as ThemeId : 'office');
    } catch { setEnabled(!next); }
  };

  const applyTheme = async (id: ProjectThemeId) => {
    setBusy(true);
    try {
      await window.cth.setProjectTheme(id);
      setCurrent(id);
      setOfficeTheme(projectTheme(id).sceneTheme as ThemeId);
      setNote('');
    } catch (error) {
      setNote(`Could not switch theme: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const selected = pending ? projectTheme(pending) : null;
  return <div>
    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10 }}>Office theme</div>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div><div style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>TV-show offices <span style={{ color: 'var(--cth-ink-500)' }}>(experimental)</span></div><div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>Choose a presentation for this project.</div></div>
      <PixelButton variant={enabled ? 'primary' : 'secondary'} size="sm" onClick={() => void toggleFlag()}>{enabled ? 'on' : 'off'}</PixelButton>
    </div>
    {enabled && <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
      {PROJECT_THEMES.map((theme) => {
        const isCurrent = theme.id === current;
        return <button key={theme.id} disabled={busy} onClick={() => { if (!isCurrent) setPending(theme.id); }} style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', padding: 8, border: 'none', cursor: busy ? 'default' : 'pointer', background: isCurrent ? 'var(--cth-paper-100)' : 'transparent', boxShadow: isCurrent ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-300)' }}>
          <span style={{ width: 28, height: 28, flexShrink: 0, background: theme.swatch, boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)' }} />
          <span><span style={{ display: 'block', fontSize: 12, color: 'var(--cth-ink-900)' }}>{theme.label}{isCurrent ? ' · current' : ''}</span><span style={{ display: 'block', fontSize: 11, color: 'var(--cth-ink-500)' }}>{theme.blurb}</span></span>
        </button>;
      })}
    </div>}
    {note && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--cth-ink-500)' }}>{note}</div>}
    {selected && <ThemeSwitchConfirmModal theme={selected} busy={busy} onCancel={() => setPending(null)} onConfirm={() => void applyTheme(selected.id)} />}
  </div>;
}

function ThemeSwitchConfirmModal({ theme, busy, onCancel, onConfirm }: { theme: ReturnType<typeof projectTheme>; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div onClick={busy ? undefined : onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(26, 19, 32, 0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 400 }}>
    <div onClick={(event) => event.stopPropagation()} style={{ width: 480, maxWidth: '92vw' }}>
      <PixelPanel variant="dialog" title={`SWITCH TO ${theme.label.toUpperCase()}`} noPadding>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ width: 32, height: 32, flexShrink: 0, background: 'var(--cth-lemon-light)', boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)', display: 'grid', placeItems: 'center' }}><Icon name="bell" /></div>
            <div style={{ fontSize: 14, lineHeight: '21px', color: 'var(--cth-ink-700)' }}>Agent names stay the same so agent memory keeps working. Only their look changes. To load <strong>{theme.label}</strong>-themed names, start a blank project.</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><PixelButton variant="secondary" size="md" onClick={onCancel} disabled={busy}>Cancel</PixelButton><PixelButton variant="primary" size="md" onClick={onConfirm} disabled={busy}>{busy ? 'Switching…' : 'Switch'}</PixelButton></div>
        </div>
      </PixelPanel>
    </div>
  </div>;
}

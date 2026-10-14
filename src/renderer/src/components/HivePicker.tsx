import { useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import type { HarnessConfig } from '@/store/config';
import { isPackProjectTheme, projectThemes, type ProjectThemeId } from '@shared/projectTheme';

export interface HivePickerProps {
  config: HarnessConfig;
  /** Open the CURRENT harness home in-place (no relaunch). */
  onOpenCurrent: () => void;
}

// Set right before a hive SWITCH so App skips this picker once after the relaunch
// changeHome triggers — otherwise the user would land back on the picker for the
// hive they just chose. App.tsx reads + clears it on mount.
const SKIP_KEY = 'cth.skipHivePickerOnce';

function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * HivePicker — the launch-time workspace selector. A "hive" is a harness home
 * folder: its own agents, memory, tasks, and history. On reopen the user can open
 * the hive they were in (fast, in-place), jump to a recent one, browse to an
 * existing folder, or start a new one. Switching to a DIFFERENT home goes through
 * changeHome('fresh'), which tears down services and relaunches against it — so
 * every switch is a clean process restart (cheap here, before any work is live).
 */
export function HivePicker({ config, onOpenCurrent }: HivePickerProps) {
  const current = config.harnessHome;
  const recents = (config.recentHives ?? []).filter((h) => h && h !== current);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [newProjectPath, setNewProjectPath] = useState<string | undefined>();

  // Open a hive. Same folder as the current one → just enter it (no relaunch).
  // A different folder → changeHome('fresh') re-points + relaunches the process.
  const openHive = async (path: string, projectTheme?: ProjectThemeId) => {
    if (!path) return;
    if (current && path === current) {
      if (projectTheme) { setError('Choose a different empty folder for a new project.'); return; }
      onOpenCurrent(); return;
    }
    setError(undefined);
    setBusy(path);
    try {
      window.localStorage.setItem(SKIP_KEY, '1');
      const res = await window.cth.changeHome(path, 'fresh', projectTheme);
      // Success never returns (the process relaunches). A return means an error.
      if (!res.ok) {
        window.localStorage.removeItem(SKIP_KEY);
        setError(res.error ?? 'Could not open that folder.');
        setBusy(undefined);
      }
    } catch (e) {
      window.localStorage.removeItem(SKIP_KEY);
      setError(e instanceof Error ? e.message : String(e));
      setBusy(undefined);
    }
  };

  const browse = async (create = false) => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) {
      if (create) setNewProjectPath(res.path);
      else void openHive(res.path);
    }
    else if (res.error !== 'cancelled') setError(res.error);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--cth-cream-200)',
      backgroundImage:
        `repeating-linear-gradient(45deg, var(--cth-hatch-strong) 0 1px, transparent 1px 8px)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 200,
      padding: 32
    }}>
      <div style={{ width: 560, maxWidth: '94vw' }}>
        <PixelPanel variant="dialog" title="SELECT A HARNESS CONFIG" noPadding>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ margin: 0, fontSize: 12, lineHeight: '19px', color: 'var(--cth-ink-700)' }}>
              A <strong>harness config</strong> is the folder where the app keeps everything for one
              workspace — its settings, your agents and their memory, tasks, triggers, and history.
              Each config is separate and self-contained, so you can run different setups side by side.
              Open the one you were working in, switch to another, or start a new one.
            </p>

            {/* CURRENT — the last-used home, the one-click default. */}
            {current && (
              <div>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', marginBottom: 4 }}>
                  CURRENT
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  background: 'var(--cth-mint-light)', boxShadow: 'inset 0 0 0 2px var(--cth-mint)'
                }}>
                  <Icon name="folder" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11, lineHeight: '15px' }}>
                      {folderName(current)}
                    </div>
                    <div style={{
                      fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left'
                    }}>{current}</div>
                  </div>
                  <PixelButton variant="primary" size="md" onClick={onOpenCurrent} disabled={!!busy}>
                    open
                  </PixelButton>
                </div>
              </div>
            )}

            {/* RECENTS — other homes this install has opened before. */}
            {recents.length > 0 && (
              <div>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', marginBottom: 4 }}>
                  RECENT
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                  {recents.map((h) => (
                    <button
                      key={h}
                      onClick={() => openHive(h)}
                      disabled={!!busy}
                      title={`Switch to ${h} (reloads the app)`}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                        background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        border: 'none', cursor: busy ? 'default' : 'pointer', textAlign: 'left',
                        opacity: busy && busy !== h ? 0.5 : 1
                      }}
                    >
                      <Icon name="folder" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
                          {folderName(h)}
                        </div>
                        <div style={{
                          fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left'
                        }}>{h}</div>
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', flexShrink: 0 }}>
                        {busy === h ? 'opening…' : 'switch →'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div style={{
                padding: '6px 10px', background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)', fontSize: 12, color: 'var(--cth-ink-900)'
              }}>{error}</div>
            )}

            {busy && (
              <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                Opening {folderName(busy)} — the app will reload…
              </div>
            )}

            {/* OPEN / CREATE — both browse to a folder; "fresh" mode re-points at it
                (bootstrapping an empty one, or reusing existing hive data in place). */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <PixelButton variant="secondary" size="md" onClick={() => void browse()} disabled={!!busy}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="folder" /> open existing config…
                </span>
              </PixelButton>
              <PixelButton variant="secondary" size="md" onClick={() => void browse(true)} disabled={!!busy}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="plus" /> create new config…
                </span>
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
      {newProjectPath && <ProjectThemeChoice path={newProjectPath} onCancel={() => setNewProjectPath(undefined)} onChoose={(theme) => void openHive(newProjectPath, theme)} />}
    </div>
  );
}

function ProjectThemeChoice({ path, onCancel, onChoose }: { path: string; onCancel: () => void; onChoose: (theme: ProjectThemeId) => void }) {
  return <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(26, 19, 32, 0.7)', display: 'grid', placeItems: 'center', padding: 20 }}>
    <div style={{ width: 520, maxWidth: '94vw' }}><PixelPanel variant="dialog" title="CHOOSE A PROJECT THEME" noPadding>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>This choice seeds a blank project only. Existing project names and memories are never changed.</div>
        {projectThemes().filter((theme) => theme.id === 'office' || isPackProjectTheme(theme.id)).map((theme) => <button key={theme.id} onClick={() => onChoose(theme.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, border: 'none', padding: 10, textAlign: 'left', cursor: 'pointer', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}><span style={{ width: 24, height: 24, background: theme.swatch }} /><span><strong>{theme.label}</strong><span style={{ display: 'block', fontSize: 11, color: 'var(--cth-ink-500)' }}>{theme.projectDefaults?.orchestrator?.name ?? 'Default orchestrator'} starts this project</span></span></button>)}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><PixelButton variant="secondary" size="md" onClick={onCancel}>cancel</PixelButton></div>
      </div>
    </PixelPanel></div>
  </div>;
}

/**
 * CODEX-BLOAT-165 fix 5 (the Human's choice) — Settings → Agents & Models →
 * "Hive Codex agents inherit my Codex plugins". OFF by default.
 *
 * Off: each hive Codex agent's OWN config.toml turns the plugins it copied from the user's
 * ~/.codex/config.toml off (each one adds tools and instructions to every request). On: the
 * inherited plugin config is left exactly as the user's file has it. The user's own file is
 * never written either way.
 *
 * The same conventions as CodexToolOutputSetting: it reads the CURRENT config when it mounts
 * (the 1.1.57 rule), saves only this key (main validates it), reverts on a failed save, and
 * uses theme tokens only. Codex reads config.toml when it starts, so the hint says a change
 * reaches an agent at its next start.
 */
import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';

export const CODEX_PLUGINS_COPY = {
  title: 'Hive Codex agents inherit my Codex plugins',
  help: 'Off (the default): hive Codex agents start without the plugins in your Codex config (browser, '
    + 'computer use, documents, pdf, ...). Each plugin adds tools and instructions to every request, so off keeps '
    + 'requests smaller. On: hive Codex agents get your plugins as your Codex config has them. Your own Codex '
    + 'config is not changed either way.',
  restartHint: 'Codex reads this when an agent starts: running Codex agents keep their current plugins until '
    + 'they are restarted (Restart & Continue keeps the conversation).',
  saveFailed: 'Could not save. The previous value is unchanged.'
};

/** The stored setting as the control shows it: only an explicit `true` is on. Pure. */
export function codexInheritPluginsOf(c: { codexInheritPlugins?: unknown } | null | undefined): boolean {
  return c?.codexInheritPlugins === true;
}

export function CodexPluginsSetting() {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.cth.getConfig().then((c) => setOn(codexInheritPluginsOf(c))).catch(() => { /* keep off */ });
  }, []);

  const save = (value: boolean) => {
    const prev = on;
    setOn(value);
    void window.cth.updateConfig({ codexInheritPlugins: value }).then((c) => {
      setOn(codexInheritPluginsOf(c));
      setError(null);
    }).catch(() => { setOn(prev); setError(CODEX_PLUGINS_COPY.saveFailed); });
  };

  return (
    <div data-codex-plugins-setting="" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>{CODEX_PLUGINS_COPY.title}</span>
        <PixelButton
          variant={on ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => save(!on)}
        >{on ? 'on' : 'off'}</PixelButton>
      </div>
      {error && <span role="alert" style={{ fontSize: 12, color: 'var(--cth-status-blocked)' }}>{error}</span>}
      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)' }}>{CODEX_PLUGINS_COPY.restartHint}</span>
      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{CODEX_PLUGINS_COPY.help}</span>
    </div>
  );
}

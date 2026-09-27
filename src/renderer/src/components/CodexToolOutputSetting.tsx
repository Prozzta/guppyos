/**
 * CODEX-BLOAT-165 fix 2 — Settings → Agents & Models → "Codex tool output cap".
 *
 * The `tool_output_token_limit` the app writes into each hive Codex agent's OWN config.toml
 * (never the user's ~/.codex/config.toml). A number from 1000 to 10000 (default 4000), or Off.
 *
 * Its own save lifecycle, like CapacityDisplaySetting: it reads the CURRENT config from main
 * when it mounts (the 1.1.57 rule: Settings shows what was saved, not what the app started
 * with), saves only this key, and main validates again. Out-of-range numbers are clamped (and
 * the note says so); anything that is not a whole number is refused and the stored value stays.
 * Every colour is a theme token, so the control reads in both themes.
 *
 * Codex reads config.toml when it starts, so a change reaches a Codex agent at its next start:
 * the hint says so.
 */
import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import {
  CODEX_TOOL_OUTPUT_LIMIT_DEFAULT, CODEX_TOOL_OUTPUT_LIMIT_MAX, CODEX_TOOL_OUTPUT_LIMIT_MIN,
  normalizeCodexToolOutputLimit, parseCodexToolOutputLimitInput, type CodexToolOutputLimitSetting
} from '@shared/codexToolOutputLimit';

export const CODEX_TOOL_OUTPUT_COPY = {
  heading: 'Codex agents',
  title: 'Codex tool output cap',
  unit: 'tokens per tool output',
  help: 'How much of each command or tool output a hive Codex agent keeps in its conversation, in Codex\'s '
    + 'estimated tokens (about 4 characters each). A longer output keeps its beginning and its end; the middle '
    + 'is replaced by a "…N tokens truncated…" marker. Everything kept is re-sent with every later request, so a '
    + 'lower cap means cheaper requests; the agent can re-run a command with a filter when it needs the middle. '
    + `Codex's own limit (10,000 for current models) still applies, so that is the maximum. Off: no hive cap. From ${CODEX_TOOL_OUTPUT_LIMIT_MIN} `
    + `to ${CODEX_TOOL_OUTPUT_LIMIT_MAX}; default ${CODEX_TOOL_OUTPUT_LIMIT_DEFAULT}. Only hive Codex agents; your own `
    + 'Codex config is not changed.',
  restartHint: 'Codex reads this when an agent starts: running Codex agents keep their current cap until they are '
    + 'restarted (Restart & Continue keeps the conversation).',
  clamped: (v: number) => `Saved as ${v} (the allowed range is ${CODEX_TOOL_OUTPUT_LIMIT_MIN} to ${CODEX_TOOL_OUTPUT_LIMIT_MAX}).`,
  saveFailed: 'Could not save. The previous value is unchanged.'
};

/** The stored setting as the control shows it (absent or unreadable = the default). Pure. */
export function codexToolOutputSettingOf(c: { codexToolOutputTokenLimit?: unknown } | null | undefined): CodexToolOutputLimitSetting {
  return normalizeCodexToolOutputLimit(c?.codexToolOutputTokenLimit) ?? CODEX_TOOL_OUTPUT_LIMIT_DEFAULT;
}

export function CodexToolOutputSetting() {
  const [stored, setStored] = useState<CodexToolOutputLimitSetting>(CODEX_TOOL_OUTPUT_LIMIT_DEFAULT);
  const [draft, setDraft] = useState<string>(String(CODEX_TOOL_OUTPUT_LIMIT_DEFAULT));
  const [lastNumber, setLastNumber] = useState<number>(CODEX_TOOL_OUTPUT_LIMIT_DEFAULT);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = (v: CodexToolOutputLimitSetting) => {
    setStored(v);
    if (v !== 'off') { setDraft(String(v)); setLastNumber(v); }
  };

  useEffect(() => {
    void window.cth.getConfig().then((c) => show(codexToolOutputSettingOf(c))).catch(() => { /* keep the default */ });
  }, []);

  const save = (value: CodexToolOutputLimitSetting, clamped = false) => {
    const prev = stored;
    setStored(value);
    void window.cth.updateConfig({ codexToolOutputTokenLimit: value }).then((c) => {
      const saved = codexToolOutputSettingOf(c);
      show(saved);
      setError(null);
      setNote(clamped && saved !== 'off' ? CODEX_TOOL_OUTPUT_COPY.clamped(saved) : null);
    }).catch(() => { show(prev); setError(CODEX_TOOL_OUTPUT_COPY.saveFailed); });
  };

  const commit = () => {
    const p = parseCodexToolOutputLimitInput(draft);
    if (!p.ok) { setError(p.error); return; }
    setError(null);
    if (p.value === stored) { setDraft(String(p.value)); return; }
    save(p.value, p.clamped);
  };

  const off = stored === 'off';
  return (
    <div data-codex-tool-output-setting="">
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
      }}>
        {CODEX_TOOL_OUTPUT_COPY.heading}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>{CODEX_TOOL_OUTPUT_COPY.title}</span>
          <PixelButton
            variant={off ? 'secondary' : 'primary'}
            size="sm"
            onClick={() => save(off ? lastNumber : 'off')}
          >{off ? 'off' : 'on'}</PixelButton>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: off ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)' }}>
          <input
            data-codex-tool-output-limit=""
            aria-label={CODEX_TOOL_OUTPUT_COPY.title}
            type="text"
            inputMode="numeric"
            disabled={off}
            value={off ? 'Off' : draft}
            onChange={(e) => { setDraft(e.target.value); setError(null); setNote(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
            aria-invalid={error !== null}
            style={{
              width: 72, padding: '2px 6px', fontSize: 13, textAlign: 'right',
              background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
              border: 'none', boxShadow: `inset 0 0 0 1px ${error ? 'var(--cth-status-blocked)' : 'var(--cth-ink-300)'}`
            }}
          />
          {CODEX_TOOL_OUTPUT_COPY.unit}
          {!off && <PixelButton variant="secondary" size="sm" onClick={commit}>set</PixelButton>}
        </label>
        {error && <span role="alert" style={{ fontSize: 12, color: 'var(--cth-status-blocked)' }}>{error}</span>}
        {note && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{note}</span>}
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)' }}>{CODEX_TOOL_OUTPUT_COPY.restartHint}</span>
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{CODEX_TOOL_OUTPUT_COPY.help}</span>
      </div>
    </div>
  );
}

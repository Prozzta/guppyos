/**
 * TERM-FONT-SETTINGS-107: Settings -> General -> Terminal.
 *
 * Its own section with its own save lifecycle, like GraphicsSetting: the terminal font, and
 * directly under it the pattern colours toggle. Each control saves only its own config key at
 * once (config.json, through main), so both survive a restart. A change is applied live:
 *   - the font goes to terminalFont.ts, whose subscriber (terminalPool) re-measures and
 *     reflows every open terminal of this window; main pushes it to every other window;
 *   - the colours toggle goes to terminalPatternColor.ts.
 * A save that fails puts the control and the terminals back to what is stored.
 */
import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import {
  TERMINAL_FONT_FACES, getTerminalFontFace, parseTerminalFontFace, setTerminalFontFace,
  type TerminalFontFace
} from './terminalFont';
import { setTerminalPatternColoringEnabled } from './terminalPatternColor';

export const TERMINAL_COPY = {
  heading: 'Terminal',
  fontLabel: 'Font',
  fontHelp: 'The font of every terminal. It changes the open terminals at once.',
  fontFailed: 'The terminal font could not be saved. The current one is unchanged.',
  coloringLabel: 'Colour recognizable output',
  coloringHelp: 'Highlight paths, links, git IDs, status words and agent names. Terminal output is unchanged.'
};

type TerminalConfigView = { terminalFont?: string; terminalPatternColoring?: boolean };

export function TerminalSetting({ config }: { config: TerminalConfigView }) {
  const [font, setFont] = useState<TerminalFontFace>(parseTerminalFontFace(config.terminalFont));
  const [coloring, setColoring] = useState<boolean>(config.terminalPatternColoring !== false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The modal's config prop can be older than the file (another window saved): read it fresh.
    let alive = true;
    void window.cth.getConfig().then((c) => {
      if (!alive) return;
      const cc = c as TerminalConfigView;
      const face = parseTerminalFontFace(cc.terminalFont);
      setFont(face);
      setTerminalFontFace(face);
      setColoring(cc.terminalPatternColoring !== false);
      setTerminalPatternColoringEnabled(cc.terminalPatternColoring !== false);
    }).catch(() => { /* the section keeps what the modal was opened with */ });
    return () => { alive = false; };
  }, []);

  const chooseFont = async (value: string) => {
    const next = parseTerminalFontFace(value);
    const prev = font;
    if (next === prev) return;
    setError(null);
    setFont(next);
    setTerminalFontFace(next);
    try { await window.cth.updateConfig({ terminalFont: next }); }
    catch {
      setFont(prev);
      // Put the terminals back only if no later pick replaced this one meanwhile.
      if (getTerminalFontFace() === next) setTerminalFontFace(prev);
      setError(TERMINAL_COPY.fontFailed);
    }
  };

  const toggleColoring = async () => {
    const next = !coloring;
    setColoring(next);
    setTerminalPatternColoringEnabled(next);
    try { await window.cth.updateConfig({ terminalPatternColoring: next }); }
    catch { setColoring(!next); setTerminalPatternColoringEnabled(!next); }
  };

  return (
    <div data-terminal-setting="">
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
      }}>
        {TERMINAL_COPY.heading}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
              {TERMINAL_COPY.fontLabel}
            </span>
            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
              {TERMINAL_COPY.fontHelp}
            </span>
            {error && <span role="alert" style={{ fontSize: 12, color: 'var(--cth-status-blocked)' }}>{error}</span>}
          </div>
          <select
            aria-label="Terminal font"
            data-terminal-font=""
            value={font}
            onChange={(e) => { void chooseFont(e.target.value); }}
            style={{ fontSize: 12, padding: '2px 6px' }}>
            {TERMINAL_FONT_FACES.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
              {TERMINAL_COPY.coloringLabel}
            </span>
            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
              {TERMINAL_COPY.coloringHelp}
            </span>
          </div>
          <span data-terminal-coloring="">
            <PixelButton variant={coloring ? 'primary' : 'secondary'} size="sm" onClick={toggleColoring}>
              {coloring ? 'on' : 'off'}
            </PixelButton>
          </span>
        </div>
      </div>
    </div>
  );
}

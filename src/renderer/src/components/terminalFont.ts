import type { Terminal } from '@xterm/xterm';

/**
 * TERM-FONT-105: the one place the terminal font is chosen: Martian Mono (the Human's pick).
 *
 * The face is bundled (design/fonts.css), never fetched. Martian Mono is a WIDE face (its
 * advance is about 0.7em against 0.6em for most monospace fonts), so the cell must be
 * measured with the face itself, never with a fallback: see remeasureTerminalFont below.
 * Consolas sits before the generic
 * `monospace` so that, on Windows, a missing face falls back to a real monospace font of
 * known width instead of whatever Chromium's default monospace is this release (Courier New
 * in Chrome 128, Consolas in Chrome 156 — the change that exposed the cell-width bug).
 */
export const TERMINAL_FONT_FACE = 'Martian Mono';
export const TERMINAL_FONT_FAMILY = `"${TERMINAL_FONT_FACE}", Consolas, monospace`;

let loaded: Promise<void> | null = null;

/** Load the bundled terminal face (regular + bold, the two weights xterm draws).
 *  Resolves once both are usable; rejects loudly if the bundled files are missing. */
export function loadTerminalFont(): Promise<void> {
  if (!loaded) {
    loaded = Promise.all([
      document.fonts.load(`14px "${TERMINAL_FONT_FACE}"`),
      document.fonts.load(`bold 14px "${TERMINAL_FONT_FACE}"`)
    ]).then((faces) => {
      if (faces.some((f) => f.length === 0)) throw new Error(`terminal font "${TERMINAL_FONT_FACE}" is not bundled`);
    });
    loaded.catch((err) => console.error('[terminalFont]', err));
  }
  return loaded;
}

/** The weights xterm draws with (fontWeight 400, fontWeightBold 700). */
const TERMINAL_FONT_WEIGHTS = ['400', '700'];

/**
 * True only when the BUNDLED faces (design/fonts.css) for both weights are loaded.
 * Not document.fonts.check(): that returns true for a family with no @font-face at all
 * (Chrome 156, Jim on 35bbbf72), so a missing fonts.css would read "ready", the load
 * below would never run and its loud error would never fire.
 */
export function terminalFontReady(): boolean {
  const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === TERMINAL_FONT_FACE);
  return TERMINAL_FONT_WEIGHTS.every((w) => faces.some((f) => f.weight === w && f.status === 'loaded'));
}

/**
 * Make xterm measure its character cell again and re-raster the WebGL glyph atlas.
 *
 * xterm measures the cell on open() and on a CHANGE of a font option only: its option
 * setter fires nothing when the new value equals the old (`rawOptions[key] !== value`), so
 * re-assigning the same fontFamily/fontSize (what the code did before) never re-measured.
 * Stepping fontSize away and back is two real changes through the public API: each one
 * re-measures with the now-loaded face; the grid itself is resized by the caller's fit().
 */
export function remeasureTerminalFont(term: Terminal): void {
  const size = term.options.fontSize ?? 14;
  term.options.letterSpacing = TERMINAL_CELL_PAD;
  term.options.fontSize = size + 1;
  term.options.fontSize = size;
  term.clearTextureAtlas();
}

/**
 * Whole-pixel cells with air around every glyph (TERM-FONT-105: readability is the bar).
 *
 * xterm's cell width is floor(advance x dpr) + round(letterSpacing) device px. Martian Mono's
 * advance is 0.7em, fractional at most sizes (8.4px at 12px), so the floor alone made 8px
 * cells for 8.4px glyphs and W/m were drawn squeezed; where the advance is whole (7.0 at
 * 10px) the glyphs fit but W/m touch their neighbours. The rule (god 5f0f8b) is
 * cell = floor(advance) + 1 at every size: 10px -> 8, 12px -> 9, 14px -> 10, 16px -> 12.
 * So the pad is always one device px, never measured: it cannot disagree with xterm's own
 * measurement, and every size change must carry it (see applyTerminalFontSize).
 */
export const TERMINAL_CELL_PAD = 1;

/** Change the terminal's px size (zoom) and keep the one-pixel cell pad with it. */
export function applyTerminalFontSize(term: Terminal, fontSize: number): void {
  term.options.letterSpacing = TERMINAL_CELL_PAD;
  term.options.fontSize = fontSize;
}

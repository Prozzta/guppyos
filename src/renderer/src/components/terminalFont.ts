import type { Terminal } from '@xterm/xterm';

/**
 * TERM-FONT-105: the one place the terminal font is chosen.
 *
 * The face is bundled (design/fonts.css), never fetched. Consolas sits before the generic
 * `monospace` so that, on Windows, a missing face falls back to a real monospace font of
 * known width instead of whatever Chromium's default monospace is this release (Courier New
 * in Chrome 128, Consolas in Chrome 156 — the change that exposed the cell-width bug).
 */
export const TERMINAL_FONT_FACE = 'JetBrains Mono';
export const TERMINAL_FONT_FAMILY = `"${TERMINAL_FONT_FACE}", "SF Mono", Menlo, Consolas, monospace`;

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

export function terminalFontReady(): boolean {
  return document.fonts.check(`14px "${TERMINAL_FONT_FACE}"`) && document.fonts.check(`bold 14px "${TERMINAL_FONT_FACE}"`);
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
  term.options.fontSize = size + 1;
  term.options.fontSize = size;
  term.clearTextureAtlas();
}

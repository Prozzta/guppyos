import type { Terminal } from '@xterm/xterm';

/**
 * The one place the terminal font is chosen (TERM-FONT-105, TERM-FONT-JETBRAINS).
 *
 * The user picks the face in Settings -> General -> Terminal (TerminalSetting.tsx,
 * TERM-FONT-SETTINGS-107): JetBrains Mono (the default), Martian Mono, Cascadia Mono or
 * Atkinson Hyperlegible Mono. All are bundled (design/fonts.css), never fetched. The pick is
 * saved in config.json as `terminalFont` (main owns the file); this module only holds the
 * face in use in this window. It is set from the config at app start (App.tsx), by the
 * Settings section, and by main's `terminal:fontChanged` push when another window picks.
 * Their widths differ (advance: JetBrains Mono 0.6em, Martian Mono 0.7em, Cascadia Mono
 * 0.586em, Atkinson Hyperlegible Mono 0.632em), so the cell must be measured with the
 * chosen face itself, never with a fallback or with another face: see
 * remeasureTerminalFont and applyTerminalFontFace below.
 * Consolas sits before the generic
 * `monospace` so that, on Windows, a missing face falls back to a real monospace font of
 * known width instead of whatever Chromium's default monospace is this release (Courier New
 * in Chrome 128, Consolas in Chrome 156 — the change that exposed the cell-width bug).
 */
export const TERMINAL_FONT_FACES = ['JetBrains Mono', 'Martian Mono', 'Cascadia Mono', 'Atkinson Hyperlegible Mono'] as const;
export type TerminalFontFace = (typeof TERMINAL_FONT_FACES)[number];
export const DEFAULT_TERMINAL_FONT_FACE: TerminalFontFace = 'JetBrains Mono';

function isTerminalFontFace(v: unknown): v is TerminalFontFace {
  return (TERMINAL_FONT_FACES as readonly unknown[]).includes(v);
}

/** The face a saved `terminalFont` config value means: the value itself when it is a face we
 *  ship; anything else (no key, a face we no longer ship, a hand-edited value) is the default. */
export function parseTerminalFontFace(v: unknown): TerminalFontFace {
  return isTerminalFontFace(v) ? v : DEFAULT_TERMINAL_FONT_FACE;
}

let current: TerminalFontFace = DEFAULT_TERMINAL_FONT_FACE;
const listeners = new Set<() => void>();

export function getTerminalFontFace(): TerminalFontFace {
  return current;
}

/** Use a terminal face in this window. An unknown face and an unchanged one are no-ops.
 *  Subscribers (terminalPool) apply it to every pooled terminal. Nothing is saved here:
 *  the Settings section saves the pick to config.json through main. */
export function setTerminalFontFace(next: string): TerminalFontFace {
  if (!isTerminalFontFace(next) || next === current) return current;
  current = next;
  for (const l of [...listeners]) l();
  return current;
}

export function subscribeTerminalFontFace(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Live terminal face. Re-renders the caller whenever the pick changes. */

/** The xterm fontFamily for a face: the face first, then Consolas, then monospace. */
export function terminalFontFamily(face: TerminalFontFace = current): string {
  return `"${face}", Consolas, monospace`;
}

const loaded = new Map<TerminalFontFace, Promise<void>>();

/** Load a bundled terminal face (regular + bold, the two weights xterm draws); the chosen
 *  one by default. Resolves once both are usable; rejects loudly if the bundled files are missing. */
export function loadTerminalFont(face: TerminalFontFace = current): Promise<void> {
  let p = loaded.get(face);
  if (!p) {
    p = Promise.all([
      document.fonts.load(`14px "${face}"`),
      document.fonts.load(`bold 14px "${face}"`)
    ]).then((faces) => {
      if (faces.some((f) => f.length === 0)) throw new Error(`terminal font "${face}" is not bundled`);
    });
    p.catch((err) => console.error('[terminalFont]', err));
    loaded.set(face, p);
  }
  return p;
}

/** The weights xterm draws with (fontWeight 400, fontWeightBold 700). */
const TERMINAL_FONT_WEIGHTS = ['400', '700'];

/**
 * True only when the BUNDLED faces (design/fonts.css) for both weights are loaded.
 * Not document.fonts.check(): that returns true for a family with no @font-face at all
 * (Chrome 156, Jim on 35bbbf72), so a missing fonts.css would read "ready", the load
 * below would never run and its loud error would never fire.
 */
export function terminalFontReady(face: TerminalFontFace = current): boolean {
  const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === face);
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
 * xterm's cell width is floor(advance x dpr) + round(letterSpacing) device px, and a face's
 * advance is fractional at most sizes: Martian Mono (0.7em) is 8.4px at 12px, JetBrains Mono
 * (0.6em) is 7.2px. The floor alone makes cells narrower than their glyphs whenever the
 * fraction is lost (8px cells for 8.4px glyphs: W/m drawn squeezed); where the advance is
 * whole the glyphs fit but W/m touch their neighbours. The rule (god 5f0f8b) is
 * cell = floor(advance) + 1 at every size, for every face:
 *   Martian Mono   10px -> 8, 12px -> 9, 14px -> 10, 16px -> 12
 *   JetBrains Mono 10px -> 7, 12px -> 8, 14px -> 9,  16px -> 10
 * floor(a) + 1 is wider than a for any advance, so the rule needs no per-face constant: the
 * pad is always one device px, never measured. It cannot disagree with xterm's own
 * measurement, and every size or face change must carry it (see applyTerminalFontSize and
 * applyTerminalFontFace).
 */
export const TERMINAL_CELL_PAD = 1;

/** Change the terminal's px size (zoom) and keep the one-pixel cell pad with it. */
export function applyTerminalFontSize(term: Terminal, fontSize: number): void {
  term.options.letterSpacing = TERMINAL_CELL_PAD;
  term.options.fontSize = fontSize;
}

/**
 * Switch a terminal to a face and keep the one-pixel cell pad with it. Call it only once
 * the face is loaded (loadTerminalFont): the fontFamily change makes xterm measure its cell
 * right away, and an unloaded face would be measured as Consolas. The caller refits the
 * grid (terminalPool's reflowTerminal).
 */
export function applyTerminalFontFace(term: Terminal, face: TerminalFontFace): void {
  term.options.letterSpacing = TERMINAL_CELL_PAD;
  term.options.fontFamily = terminalFontFamily(face);
}

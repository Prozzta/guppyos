// Theme-scoped UI colour roles — the JS mirror of the colour tokens in tokens.css, plus the pure helpers a floor theme
// uses to override them. No DOM and no React here (design/uiTheme.ts applies them), so tests load this file directly.
//
// A theme's `uiTokens.light/dark` may override only the names in UI_TOKEN_NAMES: colours, never spacing, type or
// geometry. Values not set by the theme keep the Office value below, so Office (no theme tokens) looks exactly as before.

export type UiMode = 'light' | 'dark';

export const UI_TOKEN_NAMES = [
  // grounds and ink
  'cream-50', 'cream-100', 'cream-200', 'cream-300', 'paper-100', 'paper-200',
  'ink-900', 'ink-700', 'ink-500', 'ink-300', 'ink-100',
  // accents
  'coral', 'coral-light', 'mint', 'mint-light', 'sky', 'sky-light', 'lemon', 'lemon-light',
  'lilac', 'lilac-light', 'peach', 'peach-light', 'on-accent',
  // status
  'status-idle', 'status-thinking', 'status-working', 'status-waiting', 'status-blocked', 'status-success',
  'status-ghost', 'status-compacting', 'status-looping', 'status-typing',
  // roles for colours that used to be literals in components
  'lemon-strong',        // the accent as a mark (dots, meters, borders, accent text), apart from lemon as a fill
  'select',              // editor / terminal selection, active gutter row
  'select-strong',       // the current search match
  'select-line',         // the editor's active-line wash
  'hatch',               // the body background hatch
  'hatch-strong',        // the hatch on full-screen pickers (hive picker, onboarding)
  'track',               // the empty part of a meter or pie
  'term-yellow', 'term-yellow-bright',   // terminal ANSI yellow, readable on the terminal ground
  'warn', 'warn-light',  // warnings (near a cap, something needs a look), apart from the accent
  'warn-mark',           // a warning as a mark (near-cap meters, warning dots); Office keeps the accent here
  'amber-light'          // the update badge's warning tone
] as const;

export type UiTokenName = (typeof UI_TOKEN_NAMES)[number];
export type UiTokenSet = Partial<Record<UiTokenName, string>>;
export interface UiTokenOverrides { light?: UiTokenSet; dark?: UiTokenSet }

/** Office values, light and dark. Mirrors tokens.css (:root and [data-cth-theme='dark']); update both together. */
export const OFFICE_UI_TOKENS: Record<UiMode, Record<UiTokenName, string>> = {
  light: {
    'cream-50': '#FFFDF5', 'cream-100': '#FFF8E7', 'cream-200': '#F4E9C7', 'cream-300': '#E8D9A0', 'paper-100': '#FCFAF0', 'paper-200': '#F0EAD2',
    'ink-900': '#1A1320', 'ink-700': '#3D2E4A', 'ink-500': '#6B5878', 'ink-300': '#A899B5', 'ink-100': '#D9CFE0',
    coral: '#D96A62', 'coral-light': '#F3D3CD', mint: '#5CA97A', 'mint-light': '#D2E7DA', sky: '#4F9FAF', 'sky-light': '#CFE5E9',
    lemon: '#DCAB3C', 'lemon-light': '#F3E4BC', lilac: '#9482D3', 'lilac-light': '#E0DAF2', peach: '#D99168', 'peach-light': '#F3DACA',
    'on-accent': '#1A1320',
    'status-idle': '#A199AB', 'status-thinking': '#4F9FAF', 'status-working': '#DCAB3C', 'status-waiting': '#6D87D6',
    'status-blocked': '#D96A62', 'status-success': '#5CA97A', 'status-ghost': '#D9D3DE', 'status-compacting': '#8F7CC7',
    'status-looping': '#D6903F', 'status-typing': '#C89838',
    'lemon-strong': '#DCAB3C', select: '#FFEC99', 'select-strong': '#FFD93D', 'select-line': 'rgba(255, 217, 61, 0.10)',
    hatch: 'rgba(232, 217, 160, 0.20)', 'hatch-strong': 'rgba(232, 217, 160, 0.40)', track: '#F6F3E8',
    'term-yellow': '#9C6B00', 'term-yellow-bright': '#B8860B', warn: '#B8860B', 'warn-light': '#F6E2B3', 'warn-mark': '#DCAB3C',
    'amber-light': '#F6E2B3'
  },
  dark: {
    'cream-50': '#17171B', 'cream-100': '#1D1D22', 'cream-200': '#26262C', 'cream-300': '#313139', 'paper-100': '#1A1A1F', 'paper-200': '#222229',
    'ink-900': '#DEDBD6', 'ink-700': '#B3B0AC', 'ink-500': '#96919F', 'ink-300': '#787684', 'ink-100': '#3E3D46',
    coral: '#E08C82', 'coral-light': '#3B2724', mint: '#74C096', 'mint-light': '#1E3227', sky: '#6FB3C4', 'sky-light': '#1F3238',
    lemon: '#CFAA57', 'lemon-light': '#332C1D', lilac: '#A896E3', 'lilac-light': '#2B2740', peach: '#DFA57F', 'peach-light': '#352822',
    'on-accent': '#1A1320',
    'status-idle': '#6F6C77', 'status-thinking': '#64ACBB', 'status-working': '#D8B052', 'status-waiting': '#8095DC',
    'status-blocked': '#DF8078', 'status-success': '#6FB88B', 'status-ghost': '#6C6A76', 'status-compacting': '#9D8BD2',
    'status-looping': '#D69A55', 'status-typing': '#CBA24A',
    // The editors are light in both app themes, and the hatch, track and warning colours never had a dark value:
    // these keep today's literals so Office dark is unchanged.
    'lemon-strong': '#CFAA57', select: '#37363F', 'select-strong': '#FFD93D', 'select-line': 'rgba(255, 217, 61, 0.10)',
    hatch: 'rgba(232, 217, 160, 0.20)', 'hatch-strong': 'rgba(232, 217, 160, 0.40)', track: '#F6F3E8',
    'term-yellow': '#CFAA57', 'term-yellow-bright': '#E5C87E', warn: '#B8860B', 'warn-light': '#F6E2B3', 'warn-mark': '#CFAA57',
    'amber-light': '#F6E2B3'
  }
};

const NAMES = new Set<string>(UI_TOKEN_NAMES);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i;
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const isUiTokenName = (name: string): name is UiTokenName => NAMES.has(name);
export const isUiColour = (value: unknown): value is string => typeof value === 'string' && (HEX.test(value.trim()) || RGB.test(value.trim()));
export const isFloorThemeId = (id: unknown): id is string => typeof id === 'string' && THEME_ID.test(id);

/** Keep only whitelisted names with plain colour values (hex or rgb/rgba); anything else is dropped. */
export function sanitizeUiTokens(input: unknown): UiTokenOverrides {
  const out: UiTokenOverrides = {};
  if (!input || typeof input !== 'object') return out;
  for (const mode of ['light', 'dark'] as const) {
    const set = (input as Record<string, unknown>)[mode];
    if (!set || typeof set !== 'object') continue;
    const clean: UiTokenSet = {};
    for (const [name, value] of Object.entries(set as Record<string, unknown>)) {
      if (isUiTokenName(name) && isUiColour(value)) clean[name] = value.trim();
    }
    if (Object.keys(clean).length) out[mode] = clean;
  }
  return out;
}

/** The full palette for one mode: Office values with the theme's overrides on top. */
export function resolveUiPalette(mode: UiMode, overrides?: UiTokenOverrides | null): Record<UiTokenName, string> {
  return { ...OFFICE_UI_TOKENS[mode], ...(overrides?.[mode] ?? {}) };
}

/**
 * The stylesheet for a floor theme's overrides. Light values apply only outside dark mode, and dark values win over
 * both the light overrides and tokens.css's own dark block, so a theme that sets only one mode leaves the other alone.
 */
export function uiTokenCss(themeId: string, overrides: UiTokenOverrides): string {
  if (!isFloorThemeId(themeId)) return '';
  const block = (selector: string, set?: UiTokenSet): string => {
    const lines = Object.entries(set ?? {}).map(([name, value]) => `  --cth-${name}: ${value};`);
    return lines.length ? `${selector} {\n${lines.join('\n')}\n}\n` : '';
  };
  const root = `:root[data-floor-theme='${themeId}']`;
  return block(`${root}:not([data-cth-theme='dark'])`, overrides.light) + block(`${root}[data-cth-theme='dark']`, overrides.dark);
}

// ─── Consumers that take literal colours (they cannot read CSS custom properties) ───────────────────────────────

/** The xterm colours that follow the palette: ground, ink, selection and ANSI yellow. Other ANSI slots stay fixed. */
export function terminalPaletteColours(p: Record<UiTokenName, string>) {
  return {
    background: p['paper-100'],
    foreground: p['ink-900'],
    cursorAccent: p['paper-100'],
    selectionBackground: p.select,
    selectionForeground: p['ink-900'],
    yellow: p['term-yellow'],
    brightYellow: p['term-yellow-bright']
  };
}

/** CodeMirror (light in both app themes): the colours of the CTH editor theme that follow the palette. */
export function codeMirrorPaletteColours(p: Record<UiTokenName, string>) {
  return {
    background: p['paper-100'],
    foreground: p['ink-900'],
    gutterBackground: p['paper-200'],
    gutterForeground: p['ink-500'],
    gutterBorder: p['ink-100'],
    activeLineGutter: p.select,
    activeLine: p['select-line'],
    selection: p.select,
    searchMatchSelected: p['select-strong']
  };
}

const bare = (c: string): string => c.replace(/^#/, '');

/** Monaco (light in both app themes): the colours of the 'cth-light' theme that follow the palette. */
export function monacoPaletteColours(p: Record<UiTokenName, string>) {
  return {
    rules: { foreground: bare(p['ink-900']), background: bare(p['paper-100']), comment: bare(p['ink-500']), delimiter: bare(p['ink-500']) },
    colors: {
      'editor.background': p['paper-100'],
      'editor.foreground': p['ink-900'],
      'editorLineNumber.foreground': p['ink-300'],
      'editorLineNumber.activeForeground': p['ink-700'],
      'editor.selectionBackground': p.select,
      'editor.lineHighlightBackground': p['cream-100'],
      'editorGutter.background': p['paper-200'],
      'editorWidget.background': p['cream-100'],
      'editorIndentGuide.background1': p['cream-300']
    }
  };
}

// ─── Contrast (WCAG 2.x), for the checks a palette must pass ────────────────────────────────────────────────────

function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The 15 text and mark pairs every theme palette is held to, in light and dark: [label, foreground, background, minimum]. */
export const UI_CONTRAST_CHECKS: ReadonlyArray<readonly [string, UiTokenName, UiTokenName, number]> = [
  ['body text on the ground', 'ink-900', 'cream-50', 4.5],
  ['body text on cards', 'ink-900', 'paper-100', 4.5],
  ['secondary text on the sidebar', 'ink-700', 'cream-100', 4.5],
  ['hints on cards', 'ink-500', 'paper-100', 4.5],
  ['borders on the ground', 'ink-300', 'cream-50', 3],
  ['borders on cards', 'ink-300', 'paper-100', 3],
  ['text on a filled accent', 'on-accent', 'lemon', 4.5],
  ['text on an accent chip', 'ink-900', 'lemon-light', 4.5],
  ['accent mark on the ground', 'lemon-strong', 'cream-50', 3],
  ['working dot on cards', 'status-working', 'paper-100', 3],
  ['text on a selection', 'ink-900', 'select', 4.5],
  ['warning text on cards', 'warn', 'paper-100', 4.5],
  ['warning mark on cards', 'warn-mark', 'paper-100', 3],
  ['text on a header', 'ink-900', 'cream-200', 4.5],
  ['blocked dot on cards', 'status-blocked', 'paper-100', 3]
];

/** Every check that a palette fails, with its measured ratio. Empty means the palette passes. */
export function contrastFailures(p: Record<UiTokenName, string>): Array<{ label: string; ratio: number; min: number }> {
  return UI_CONTRAST_CHECKS
    .map(([label, fg, bg, min]) => ({ label, ratio: contrastRatio(p[fg], p[bg]), min }))
    .filter((r) => r.ratio < r.min);
}

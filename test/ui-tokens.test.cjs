'use strict';
require('./tools/own-job.cjs');

// Theme-scoped UI colour tokens (design/uiTokens.ts, design/uiTheme.ts). These tests hold four things in place:
// tokens.css and its JS mirror agree; Office looks exactly as before (every colour that used to be a literal in the
// editors, terminals and hatches resolves to the same value); a theme can override colour roles only; and the
// unbranded command-gold fixture (Palette A) passes the 15 contrast checks in light and dark.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const T = loadTs('src/renderer/src/design/uiTokens.ts');
const FIXTURE = JSON.parse(read('test/fixtures/ui-tokens-command-gold.json'));
const norm = (v) => v.trim().replace(/\s+/g, ' ').toUpperCase();

function cssBlocks() {
  const css = read('src/renderer/src/design/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (sel) => {
    const at = css.indexOf(sel + ' {');
    assert.ok(at >= 0, `tokens.css has no ${sel} block`);
    const body = css.slice(at, css.indexOf('}', at));
    return Object.fromEntries([...body.matchAll(/--cth-([a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
  };
  return { light: block(':root'), dark: block(":root[data-cth-theme='dark']") };
}

test('tokens.css and the JS mirror agree on every UI colour token, light and dark', () => {
  const { light, dark } = cssBlocks();
  for (const name of T.UI_TOKEN_NAMES) {
    assert.ok(light[name], `--cth-${name} is not defined in :root`);
    assert.equal(norm(light[name]), norm(T.OFFICE_UI_TOKENS.light[name]), `light --cth-${name}`);
    assert.equal(norm(dark[name] ?? light[name]), norm(T.OFFICE_UI_TOKENS.dark[name]), `dark --cth-${name}`);
  }
});

test('Office is unchanged: the editors and terminals resolve to the literals they used before', () => {
  const L = T.OFFICE_UI_TOKENS.light, D = T.OFFICE_UI_TOKENS.dark;
  assert.deepEqual(T.terminalPaletteColours(L), {
    background: '#FCFAF0', foreground: '#1A1320', cursorAccent: '#FCFAF0', selectionBackground: '#FFEC99',
    selectionForeground: '#1A1320', yellow: '#9C6B00', brightYellow: '#B8860B'
  });
  assert.deepEqual(T.terminalPaletteColours(D), {
    background: '#1A1A1F', foreground: '#DEDBD6', cursorAccent: '#1A1A1F', selectionBackground: '#37363F',
    selectionForeground: '#DEDBD6', yellow: '#CFAA57', brightYellow: '#E5C87E'
  });
  assert.deepEqual(T.codeMirrorPaletteColours(L), {
    background: '#FCFAF0', foreground: '#1A1320', gutterBackground: '#F0EAD2', gutterForeground: '#6B5878',
    gutterBorder: '#D9CFE0', activeLineGutter: '#FFEC99', activeLine: 'rgba(255, 217, 61, 0.10)', selection: '#FFEC99',
    searchMatchSelected: '#FFD93D'
  });
  assert.deepEqual(T.monacoPaletteColours(L), {
    rules: { foreground: '1A1320', background: 'FCFAF0', comment: '6B5878', delimiter: '6B5878' },
    colors: {
      'editor.background': '#FCFAF0', 'editor.foreground': '#1A1320', 'editorLineNumber.foreground': '#A899B5',
      'editorLineNumber.activeForeground': '#3D2E4A', 'editor.selectionBackground': '#FFEC99',
      'editor.lineHighlightBackground': '#FFF8E7', 'editorGutter.background': '#F0EAD2',
      'editorWidget.background': '#FFF8E7', 'editorIndentGuide.background1': '#E8D9A0'
    }
  });
  // CSS roles that replaced literals or the fallbacks of undefined tokens (the same value in both modes, as before)
  for (const m of [L, D]) {
    assert.equal(m.hatch, 'rgba(232, 217, 160, 0.20)');
    assert.equal(m['hatch-strong'], 'rgba(232, 217, 160, 0.40)');
    assert.equal(m.warn, '#B8860B');
    assert.equal(m['amber-light'], '#F6E2B3');
  }
  assert.equal(L['lemon-strong'], L.lemon);
  assert.equal(D['lemon-strong'], D.lemon);
  assert.equal(L['warn-mark'], L.lemon, 'the warning marks were lemon in Office and stay pixel-identical');
  assert.equal(D['warn-mark'], D.lemon);
});

test('the warning and near-cap marks read --cth-warn-mark, not the accent', () => {
  const sites = [
    ['src/renderer/src/components/GitTab.tsx', /code === 'M'\) return 'var\(--cth-warn-mark\)'/],
    ['src/renderer/src/components/AgentCard.tsx', /progress >= 6 \? 'var\(--cth-warn-mark\)'/],
    ['src/renderer/src/components/CommandCenterPanel.tsx', /pct >= 60 \? 'var\(--cth-warn-mark\)'/],
    ['src/renderer/src/components/CommandCenterPanel.tsx', /cpct >= 75 \? 'var\(--cth-warn-mark\)'/],
    ['src/renderer/src/components/MemoryPanel.tsx', /dot: 'var\(--cth-warn-mark\)', label: 'On · getting ready…'/] // Guppy: no i18n
  ];
  for (const [f, re] of sites) assert.match(read(f), re, f);
  const gold = T.resolveUiPalette('light', T.sanitizeUiTokens(FIXTURE.uiTokens));
  assert.equal(gold['warn-mark'], gold.warn, 'Palette A: a warning mark takes the warning colour');
  assert.notEqual(gold['warn-mark'], gold.lemon);
});

test('the yellow/beige UI literals are gone from the components that now read tokens', () => {
  const files = [
    'src/renderer/src/components/CodeEditor.tsx', 'src/renderer/src/components/PtyTerminalView.tsx',
    'src/renderer/src/ide/monaco.ts', 'src/renderer/src/design/global.css',
    'src/renderer/src/components/HivePicker.tsx', 'src/renderer/src/components/OnboardingWizard.tsx',
    'src/renderer/src/realtime/CostHud.tsx', 'src/renderer/src/components/UpdateBadge.tsx',
    'src/renderer/src/components/IntegrationsRegistry.tsx', 'src/renderer/src/components/AddAgentModal.tsx',
    'src/renderer/src/components/QuitWarningModal.tsx'
  ];
  const LITERALS = /#(?:FCFAF0|F0EAD2|FFEC99|FFD93D|FFF8E7|E8D9A0|9C6B00|B8860B|CFAA57|E5C87E|FDF3CF|F6ECC4|F6E2B3)\b|rgba\(\s*(?:232,\s*217,\s*160|255,\s*217,\s*61)/i;
  for (const f of files) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const hit = code.match(LITERALS);
    assert.equal(hit, null, `${f} still has the literal ${hit && hit[0]}`);
  }
});

test('a theme can override colour roles only, with plain colour values', () => {
  const got = T.sanitizeUiTokens({
    light: { lemon: '#E3A91A', 'space-4': '99px', 'font-ui': 'Comic Sans', select: 'url(x)', hatch: 'rgba(1, 2, 3, 0.5)', bogus: '#000000' },
    dark: { lemon: 'red' },
    extra: { lemon: '#000000' }
  });
  assert.deepEqual(got, { light: { lemon: '#E3A91A', hatch: 'rgba(1, 2, 3, 0.5)' } });
  assert.deepEqual(T.sanitizeUiTokens(null), {});
  assert.deepEqual(T.sanitizeUiTokens('x'), {});
  assert.ok(!T.UI_TOKEN_NAMES.some((n) => /^(space|text|lh|font|shadow|panel)/.test(n)), 'no geometry/type token is whitelisted');
});

test('the theme stylesheet scopes light values to light mode and dark values to dark mode', () => {
  const css = T.uiTokenCss('command-gold', { light: { lemon: '#E3A91A' }, dark: { lemon: '#F2BE3A' } });
  assert.equal(css,
    ":root[data-floor-theme='command-gold']:not([data-cth-theme='dark']) {\n  --cth-lemon: #E3A91A;\n}\n" +
    ":root[data-floor-theme='command-gold'][data-cth-theme='dark'] {\n  --cth-lemon: #F2BE3A;\n}\n");
  assert.equal(T.uiTokenCss('x', { light: {} }), '');
  assert.equal(T.uiTokenCss("bad'] {} body {", { light: { lemon: '#000000' } }), '', 'a theme id cannot break out of the selector');
});

test('the command-gold fixture is Palette A: whitelisted, unbranded, and passes all 15 contrast checks', () => {
  const clean = T.sanitizeUiTokens(FIXTURE.uiTokens);
  assert.deepEqual(clean, FIXTURE.uiTokens, 'every fixture entry is a whitelisted colour');
  assert.doesNotMatch(JSON.stringify(FIXTURE), /\b(tes|tos|kerk|speck|mccey|uhera|jackov|sele|velcan|bridge|starfleet)\b/i);
  for (const mode of ['light', 'dark']) {
    const p = T.resolveUiPalette(mode, clean);
    assert.deepEqual(T.contrastFailures(p), [], `command-gold ${mode}`);
  }
  // Office for reference: dark passes; light falls short on 6 pairs today (borders, gold marks, warning text, and the
  // warning mark, which is the accent at 2.1:1), which this PR leaves as it is (no Office visual change).
  assert.deepEqual(T.contrastFailures(T.OFFICE_UI_TOKENS.dark), []);
  assert.deepEqual(T.contrastFailures(T.OFFICE_UI_TOKENS.light).map((f) => f.label).sort(), [
    'accent mark on the ground', 'borders on cards', 'borders on the ground', 'warning mark on cards',
    'warning text on cards', 'working dot on cards'
  ]);
});

test('the active floor theme re-themes the app: ThemeConfig.uiTokens -> App effect -> root + palette consumers', () => {
  // the wiring: ThemeConfig carries uiTokens, and App applies getTheme(active).uiTokens at boot and on every switch
  assert.match(read('src/renderer/src/scene/office/themeRegistry.ts'), /\n\s*uiTokens\?: UiTokenOverrides;/);
  assert.match(read('src/renderer/src/App.tsx'),
    /useEffect\(\(\) => \{ applyThemeUiTokens\(\{ id: officeTheme, uiTokens: themeUiTokens\(officeTheme\) \?\? getTheme\(officeTheme\)\.uiTokens \}\); \}, \[officeTheme\]\);/);
  const styles = new Map();
  global.document = {
    documentElement: { dataset: {} },
    head: { appendChild: (el) => styles.set(el.id, el) },
    getElementById: (id) => styles.get(id) ?? null,
    createElement: () => { const el = { id: '', textContent: '', remove: () => styles.delete(el.id) }; return el; }
  };
  try {
    const U = loadTs('src/renderer/src/design/uiTheme.ts');
    U.applyFloorUiTokens(null);
    const office = { term: T.terminalPaletteColours(U.uiPalette('light')), cm: T.codeMirrorPaletteColours(U.uiPalette('light')), monaco: T.monacoPaletteColours(U.uiPalette('dark')) };
    let calls = 0; const off = U.subscribeUiTokens(() => calls++);
    // Office (no uiTokens): nothing stamped, no re-theme
    U.applyThemeUiTokens({ id: 'office' });
    assert.equal(document.documentElement.dataset.floorTheme, undefined);
    assert.equal(styles.size, 0);
    assert.equal(calls, 0);
    // a theme with uiTokens: the root is stamped and every literal-colour consumer re-themes
    U.applyThemeUiTokens({ id: 'command-gold', uiTokens: FIXTURE.uiTokens });
    assert.equal(document.documentElement.dataset.floorTheme, 'command-gold');
    assert.match(styles.get('cth-floor-ui-tokens').textContent, /--cth-warn-mark: #8F6200;/);
    assert.equal(calls, 1, 'subscribers (xterm, CodeMirror, Monaco) are told once');
    const L = FIXTURE.uiTokens.light, D = FIXTURE.uiTokens.dark;
    const term = T.terminalPaletteColours(U.uiPalette('light'));
    assert.equal(term.background, L['paper-100']);
    assert.equal(term.selectionBackground, L.select);
    assert.equal(term.yellow, L['term-yellow']);
    assert.equal(T.codeMirrorPaletteColours(U.uiPalette('light')).background, L['paper-100']);
    assert.equal(T.monacoPaletteColours(U.uiPalette('dark')).colors['editor.selectionBackground'], D.select);
    assert.notDeepEqual(term, office.term);
    // back to Office: everything as it was
    U.applyThemeUiTokens({ id: 'office' });
    assert.equal(document.documentElement.dataset.floorTheme, undefined);
    assert.equal(styles.size, 0);
    assert.equal(calls, 2);
    assert.deepEqual(T.terminalPaletteColours(U.uiPalette('light')), office.term);
    assert.deepEqual(T.codeMirrorPaletteColours(U.uiPalette('light')), office.cm);
    assert.deepEqual(T.monacoPaletteColours(U.uiPalette('dark')), office.monaco);
    off();
  } finally {
    delete global.document;
  }
});

test('applyFloorUiTokens stamps the root attribute, writes one stylesheet, and notifies on change only', () => {
  const styles = new Map();
  const head = { appendChild: (el) => styles.set(el.id, el) };
  global.document = {
    documentElement: { dataset: {} },
    head,
    getElementById: (id) => styles.get(id) ?? null,
    createElement: () => { const el = { id: '', textContent: '', remove: () => styles.delete(el.id) }; return el; }
  };
  try {
    const U = loadTs('src/renderer/src/design/uiTheme.ts');
    let calls = 0; const off = U.subscribeUiTokens(() => calls++);
    assert.equal(U.uiPalette('light').select, '#FFEC99');
    U.applyFloorUiTokens('command-gold', FIXTURE.uiTokens);
    assert.equal(document.documentElement.dataset.floorTheme, 'command-gold');
    assert.match(styles.get('cth-floor-ui-tokens').textContent, /--cth-select: #F9E39A;/);
    assert.equal(U.uiPalette('light').select, '#F9E39A');
    assert.equal(U.uiPalette('dark').select, '#3E3826');
    assert.equal(U.uiPalette('light'), U.uiPalette('light'), 'the same palette object until the tokens change');
    assert.equal(calls, 1);
    U.applyFloorUiTokens('command-gold', FIXTURE.uiTokens);
    assert.equal(calls, 1, 'the same tokens again: no re-theme');
    U.applyFloorUiTokens(null);
    assert.equal(document.documentElement.dataset.floorTheme, undefined);
    assert.equal(styles.size, 0);
    assert.equal(U.uiPalette('light').select, '#FFEC99');
    assert.equal(calls, 2);
    off();
  } finally {
    delete global.document;
  }
});

// Guppy badge regression (TES plan step 3): the token port must not lose or recolour
// Guppy's agent-card badges. Task chip, mail seal and impact badge all stay; a flagged
// task chip is a warning mark (lemon in Office, so pixel-identical), mail stays coral.
test('Guppy agent-card badges survive the token port', () => {
  const card = read('src/renderer/src/components/AgentCard.tsx');
  assert.match(card, /data-badge="task"/);
  assert.match(card, /data-badge="mail"/);
  assert.match(card, /<PixelBadge status=\{held\.status\} label=\{held\.label\}/);
  assert.match(card, /background: taskFlags\.length \? 'var\(--cth-warn-mark\)' : 'var\(--cth-sky\)'/);
  assert.match(card, /title=\{mailBadgeTitle\(inboxBacklog, inboxHeld, heldUntil\)\}[^]*?background: 'var\(--cth-coral\)'/);
  assert.match(card, /inboxHeld > 0 && heldUntil \? `\$\{MAIL_GLYPH\}\$\{inboxBacklog\} held \$\{heldUntilText\(heldUntil\)\}`/, 'held-mail label remains conditional on a real held deadline');
  assert.doesNotMatch(card, /var\(--cth-lemon\)/, 'no warning mark reads the raw accent');
});

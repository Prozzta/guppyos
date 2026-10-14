'use strict';

// TES plan step 5 (the join) in Guppy, end to end with the neutral-deck fixture (invented art,
// no TES data): main registers the bundled packs before any config is read, so a pack id
// survives config normalization and the theme switch; onboarding into a blank folder seeds the
// pack's orchestrator; the pack's UI tokens and seed travel through the renderer catalogue;
// the assistant's enrich prompt names god by its display name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource: read } = require('./read-source.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const PT = loadTs('src/shared/projectTheme.ts');
const P = loadTs('src/renderer/src/scene/themes/packs.ts');
const MANIFEST = JSON.parse(H.readPackDir(H.NEUTRAL)['theme.json']);
const TOKENS = { light: { 'paper-100': '#EEF2F5', 'warn-mark': '#8F6200' }, dark: { 'paper-100': '#141A20' } };

test('Jim MUST 1: main registers the packs as its FIRST import, before normalizeStoredHomes and setProjectTheme', () => {
  const index = read('src/main/index.ts');
  assert.ok(index.startsWith("import './packThemes';"), 'the first statement of the main entry');
  const packThemes = read('src/main/packThemes.ts');
  assert.match(packThemes, /import\.meta\.glob\('\.\.\/\.\.\/themes\/\*\/theme\.json', \{ eager: true, import: 'default' \}\)/);
  assert.match(packThemes, /registerPackThemes\(packThemeEntries\(MANIFESTS\)\);/);
});

test('with the neutral deck registered, main keeps its id through config normalization and the theme switch', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-tes-join-'));
  const electron = require.resolve('electron');
  const prev = require.cache[electron];
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => tmp } } };
  try {
    const C = loadTs('src/main/config.ts');
    const home = path.join(tmp, 'deck-project');
    const key = PT.projectThemeHomeKey(home);
    // Before registration an unknown id is dropped (the step-3 hazard this join closes).
    C.writeConfig({ harnessHome: home, officeThemeByHive: { [key]: 'neutral-deck' } });
    assert.equal(C.readConfig().officeThemeByHive?.[key], undefined, 'unregistered: dropped');
    // What main/packThemes.ts does with the bundled manifests.
    PT.registerPackThemes(PT.packThemeEntries({ '../../themes/neutral-deck/theme.json': MANIFEST }));
    assert.equal(PT.isPackProjectTheme('neutral-deck'), true);
    C.writeConfig({ harnessHome: home, officeThemeByHive: { [key]: 'neutral-deck', [PT.projectThemeHomeKey(path.join(tmp, 'x'))]: 'ghost-deck' } });
    assert.deepEqual(C.readConfig().officeThemeByHive, { [key]: 'neutral-deck' }, 'registered: kept; unknown: still dropped');
    C.setProjectThemeForHome(home, 'office');
    assert.equal(C.readConfig().officeThemeByHive?.[key], 'office');
    C.setProjectThemeForHome(home, 'neutral-deck');
    assert.equal(PT.resolveProjectTheme(C.readConfig(), home), 'neutral-deck', 'the switch accepts the pack');
    assert.equal(PT.floorSceneTheme('neutral-deck', false), 'neutral-deck', 'a pack is not behind the TV-show flag');
    // Onboarding into a blank folder: main saw it blank, so the first choice creates the project with the seed.
    const fresh = path.join(tmp, 'onboard');
    const ensured = C.ensureHarnessHome(fresh);
    assert.equal(ensured.blank, true);
    assert.equal(C.homeHasNoProject(fresh), true);
    const made = PT.applyProjectHomeChange(C.readConfig(), { mode: 'fresh', newHome: ensured.home, blankProject: true, theme: 'neutral-deck' });
    assert.deepEqual(made.projectThemeSeedByHive[PT.projectThemeHomeKey(fresh)], { name: 'Lead', appearance: { bodyId: 'light' } });
  } finally {
    if (prev) require.cache[electron] = prev; else delete require.cache[electron];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the renderer catalogue carries the deck\'s seed and UI tokens; the App applies a pack\'s tokens first', () => {
  const files = H.readPackDir(H.NEUTRAL);
  files['theme.json'] = JSON.stringify({ ...MANIFEST, uiTokens: { ...TOKENS, light: { ...TOKENS.light, 'not-a-role': '#000000' } } });
  const res = P.catalogue([{ dir: 'neutral-deck', files: P.memoryFiles(files) }]);
  assert.equal(res.packs.length, 1);
  assert.deepEqual(res.packs[0].uiTokens, TOKENS, 'whitelisted roles only');
  assert.deepEqual(res.packs[0].projectDefaults, { orchestrator: { name: 'Lead', appearance: { bodyId: 'light' } } });
  const plain = P.catalogue([{ dir: 'neutral-deck', files: P.memoryFiles(H.readPackDir(H.NEUTRAL)) }]);
  assert.equal(plain.packs[0].uiTokens, undefined, 'a pack without uiTokens validates as before');
  // The agreed interface (conv-69d7ff): one registerPackThemes line inside summaries(), themeUiTokens(id) beside it.
  const catalog = read('src/renderer/src/scene/themes/themeCatalog.ts');
  assert.match(catalog, /packs = res\.packs;\n\s*registerPackThemes\(packs\.map\(\(p\) => \(\{ id: p\.id, label: p\.label, orchestrator: p\.projectDefaults\?\.orchestrator \}\)\)\);\n/);
  assert.equal(catalog.split('registerPackThemes(').length - 1, 1, 'registered in one place');
  assert.match(catalog, /export function themeUiTokens\(id: string\): UiTokenOverrides \| undefined \{\n\s*return summaries\(\)\.find\(\(p\) => p\.id === id\)\?\.uiTokens;/);
  assert.match(read('src/renderer/src/main.tsx'), /\nlistThemes\(\);\n/, 'the catalogue loads (and registers) before first render');
});

test('Jim MUST 2: the assistant\'s enrich prompt is templated with god\'s display name', () => {
  const hive = read('src/renderer/src/hooks/useHive.ts');
  assert.match(hive, /function enrichTaskPrompt\(text: string, godName: string = DEFAULT_GOD_NAME\): string \{/);
  assert.match(hive, /`self-contained prompt to \$\{godName\} via an outbox message/);
  assert.doesNotMatch(hive, /prompt to Michael via/);
});

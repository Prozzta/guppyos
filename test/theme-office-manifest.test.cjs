'use strict';

// The Office stays Guppy's own floor. Upstream (MunderDev f6532e5b) moved the
// office's layout into office.layout.json; the Guppy port keeps Guppy's inline
// OFFICE_THEME (TES-GUPPY-PORT-PLAN: "Keep Guppy's Office values") and pins it
// against the same frozen fixture, which was extracted from the former inline
// literal upstream. Any drift in seats, café, coffee, anchors, errands,
// monitor, note colours or tileset metadata fails here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Evaluate Guppy's OFFICE_THEME literal with its imports stubbed. */
function guppyOffice() {
  const src = read('src/renderer/src/scene/office/themeRegistry.ts').replace(/\r\n/g, '\n');
  const a = src.indexOf('export const OFFICE_THEME: ThemeConfig = {');
  const b = src.indexOf('\n};\n', a);
  assert.ok(a >= 0 && b > a, 'OFFICE_THEME is an inline literal in themeRegistry.ts');
  const literal = src.slice(a + 'export const OFFICE_THEME: ThemeConfig = '.length, b + 2);
  const js = ts.transpileModule('module.exports = ' + literal + ';', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  const stubs = { officeTilesetUrl: 'u:office', a5FloorsWallsUrl: 'u:a5', interiorsUrl: 'u:interiors', officeMapRaw: '{}',
    colors: { ink: { 900: 0x101010 } }, CAST_BY_NAME: {}, DEFAULT_CHARACTER: 'x' };
  new Function('module', 'exports', ...Object.keys(stubs), js)(mod, mod.exports, ...Object.values(stubs));
  return mod.exports;
}

test("Guppy's inline OFFICE_THEME is value-equivalent to the frozen office layout", () => {
  const o = guppyOffice();
  const frozen = JSON.parse(read('test/fixtures/themes/office-upstream-layout.json'));
  const live = {
    primarySeatNames: o.primarySeatNames, cafeSeatNames: o.cafeSeatNames, cafeStands: o.cafeStands,
    coffee: o.coffee, anchors: o.anchors, errandSpots: o.errandSpots, monitor: o.monitor,
    noteColors: o.palette.noteColors,
    tilesets: o.tilesets.map(({ url, ...t }) => t),
  };
  assert.deepEqual(live, frozen);
  assert.deepEqual(o.tilesets.map((t) => t.url), ['u:office', 'u:a5', 'u:interiors'], 'tileset textures in their order');
  assert.equal(o.id, 'office');
  assert.equal(o.primarySeatNames[0], 'desk-ceo'); // seat 0 is still the orchestrator's
  assert.equal(o.palette.background, 0x101010, 'background is colors.ink[900]');
});

test('the office stays the built-in fallback: a pack can never take its id', () => {
  const Mf = loadTs('src/renderer/src/scene/themes/manifest.ts');
  assert.equal(Mf.OFFICE_THEME_ID, 'office');
  const r = Mf.validateManifest({ schema: 1, id: 'office' });
  assert.equal(r.manifest, null);
  // the floor shows the office for anything that is not a usable stations pack
  const floor = read('src/renderer/src/scene/office/OfficeFloor.tsx');
  assert.match(floor, /const wantsPack = isStationPack\(officeTheme\);/);
  assert.match(floor, /if \(state\?\.pack\) return <StationFloor pack=\{state\.pack\} \/>;/);
  assert.match(floor, /<OfficeScene \/>/);
  assert.match(floor, /\nfunction OfficeScene\(\) \{/, "Guppy's office floor is wrapped, not replaced");
  // and the office loader still falls back to the office for any unknown id
  assert.match(read('src/renderer/src/scene/office/themeRegistry.ts'), /return THEMES\[id\] \?\? OFFICE_THEME;/);
});

test('the pack floor is Guppy-native: no i18n library, no init retries, Guppy GPU wording', () => {
  const sf = read('src/renderer/src/scene/themes/StationFloor.tsx');
  assert.doesNotMatch(sf, /react-i18next|useTranslation/, 'Guppy has no react-i18next');
  assert.match(sf, /import \{ installContextLossRecovery \} from '\.\.\/office\/glRecovery';/);
  assert.doesNotMatch(sf, /planInitFailure|DEFAULT_MAX_INIT_RETRIES/, "Guppy's glRecovery has no init-retry plan");
  assert.match(sf, /onGiveUp: \(\) => \{ if \(mountIdRef\.current === mountId\) host\.appendChild\(floorNote\(GPU_LOST\)\); \}/);
  const floor = read('src/renderer/src/scene/office/OfficeFloor.tsx');
  const gpu = /'The office floor lost its GPU context\.\\n\\n'/;
  assert.match(floor, gpu); assert.match(sf, gpu);
  // ThemeId admits pack ids; the built-in union survives for Guppy's own users.
  const reg = read('src/renderer/src/scene/office/themeRegistry.ts');
  assert.match(reg, /export type ThemeId = BuiltinThemeId \| \(string & \{\}\);/);
  assert.match(reg, /export type BuiltinThemeId =\s*\n\s*\| 'office'/);
});

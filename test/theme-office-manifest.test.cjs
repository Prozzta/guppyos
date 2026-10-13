'use strict';

// The Office through the manifest path: its layout data now lives in
// office.layout.json. The fixture beside this test was extracted from the
// former inline OFFICE_THEME literal (upstream themeRegistry.ts), so any drift
// in seats, café, coffee, anchors, errands, monitor, note colours or tileset
// metadata fails here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('office.layout.json is value-equivalent to the former inline office constants', () => {
  const live = JSON.parse(read('src/renderer/src/scene/office/office.layout.json'));
  const frozen = JSON.parse(read('test/fixtures/themes/office-upstream-layout.json'));
  assert.deepEqual(live, frozen);
  assert.equal(live.primarySeatNames[0], 'desk-ceo'); // seat 0 is still the orchestrator's
  assert.equal(live.errandSpots.length, 14);
  assert.deepEqual(live.monitor, { offTopLeftGid: 365, onGids: [[367, 0, 0], [368, 1, 0], [383, 0, 1], [384, 1, 1]] });
});

test('OFFICE_THEME takes every layout field from office.layout.json', () => {
  const src = read('src/renderer/src/scene/office/themeRegistry.ts');
  const body = src.slice(src.indexOf('export const OFFICE_THEME'), src.indexOf('export const BROOKLYN99_THEME'));
  for (const k of ['primarySeatNames', 'cafeSeatNames', 'cafeStands', 'coffee', 'anchors', 'errandSpots', 'monitor'])
    assert.match(body, new RegExp(`\\b${k}: OFFICE_LAYOUT\\.${k},`), k);
  assert.match(body, /noteColors: OFFICE_LAYOUT\.noteColors/);
  assert.match(body, /tilesets: OFFICE_LAYOUT\.tilesets\.map\(\(t, i\) => \(\{ url: OFFICE_TILESET_URLS\[i\], \.\.\.t \}\)\)/);
  assert.match(src, /const OFFICE_TILESET_URLS = \[officeTilesetUrl, a5FloorsWallsUrl, interiorsUrl\];/);
  assert.match(body, /background: colors\.ink\[900\]/);
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
  // and the office loader still falls back to the office for any unknown id
  assert.match(read('src/renderer/src/scene/office/themeRegistry.ts'), /return THEMES\[id\] \?\? OFFICE_THEME;/);
});

'use strict';
require('./tools/own-job.cjs');
// Jim's two SHOULDs on the TES join (plan step 5):
// (a) normalization keeps a pack-shaped theme id that no registered pack has, so a pack renamed or
//     dropped in a later build does not silently wipe projects' theme entries; the floor falls back
//     at render, and garbage ids are still dropped;
// (b) main registers only the packs the renderer accepts (the renderer's validateManifest, folders in
//     name order, first id wins), so main never accepts a pack id the renderer rejects.
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
const { validatedPackThemeEntries } = loadTs('src/main/packThemeEntries.ts');
const MANIFEST = JSON.parse(H.readPackDir(H.NEUTRAL)['theme.json']);

function withConfig(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-tes-join-should-'));
  const electron = require.resolve('electron');
  const prev = require.cache[electron];
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => tmp } } };
  try {
    return fn(loadTs('src/main/config.ts'), tmp);
  } finally {
    if (prev) require.cache[electron] = prev; else delete require.cache[electron];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('(a) an unregistered pack id survives config normalization; the floor falls back at render; garbage is dropped', () => {
  withConfig((C, tmp) => {
    const home = path.join(tmp, 'gone-project');
    const key = PT.projectThemeHomeKey(home);
    const k = (n) => PT.projectThemeHomeKey(path.join(tmp, n));
    assert.equal(PT.isProjectThemeId('renamed-deck'), false, 'no pack of this id is registered');
    C.writeConfig({
      harnessHome: home,
      officeThemeByHive: { [key]: 'renamed-deck', [k('b')]: 'friends', [k('c')]: 'Not A Pack', [k('d')]: '../x', [k('e')]: 42, [k('f')]: '' },
    });
    const cfg = C.readConfig();
    assert.deepEqual(cfg.officeThemeByHive, { [key]: 'renamed-deck', [k('b')]: 'friends' }, 'pack-shaped and built-in ids kept; garbage dropped');
    assert.equal(PT.resolveProjectTheme(cfg, home), 'office', 'the floor falls back to the office');
    assert.equal(PT.floorSceneTheme(PT.resolveProjectTheme(cfg, home), false), 'office');
    assert.equal(C.resolveProjectThemeForHome(cfg, home), 'office');
    assert.throws(() => C.setProjectThemeForHome(home, 'other-gone-deck'), /invalid project theme/, 'the switch still takes only registered ids');
    // A second read (another normalization) still keeps it, and when the pack is back the entry resolves again.
    assert.equal(C.readConfig().officeThemeByHive[key], 'renamed-deck');
    PT.registerPackThemes([{ id: 'renamed-deck', label: 'Renamed Deck' }]);
    assert.equal(PT.resolveProjectTheme(C.readConfig(), home), 'renamed-deck', 'the pack returns: the project gets its floor back');
  });
});

test('(a) a project move carries an unregistered pack id with it', () => {
  const moved = PT.applyProjectHomeChange({ officeThemeByHive: { 'c:/old': 'dropped-deck' } }, { mode: 'move', oldHome: 'C:/old', newHome: 'C:/new', blankProject: false });
  assert.deepEqual(moved.officeThemeByHive, { 'c:/new': 'dropped-deck' });
});

// Every pack the renderer catalogue would reject, plus a valid deck and a duplicate id.
function manifestsByDir() {
  const clone = () => JSON.parse(JSON.stringify(MANIFEST));
  const shapeOnly = { id: 'shape-only', label: 'Shape Only', projectDefaults: { orchestrator: { name: 'X', appearance: { bodyId: 'light' } } } };
  const badSchema = Object.assign(clone(), { id: 'bad-schema', schema: 2 });
  const noMap = Object.assign(clone(), { id: 'no-map' }); delete noMap.map;
  const office = Object.assign(clone(), { id: 'office' });
  const dupA = Object.assign(clone(), { id: 'dup-deck', label: 'Dup A' });
  const dupB = Object.assign(clone(), { id: 'dup-deck', label: 'Dup B' });
  // A valid pack whose seed the validator drops (a bad colour) though it has the seed's shape.
  const badSeed = Object.assign(clone(), { id: 'bad-seed-deck', projectDefaults: { orchestrator: { name: 'Boss', appearance: { bodyId: 'light', colors: { skin: 'not a colour!' } } } } });
  return { 'neutral-deck': clone(), 'shape-only': shapeOnly, 'bad-schema': badSchema, 'no-map': noMap, 'office-copy': office, 'z-dup': dupB, 'bad-seed': badSeed, 'a-dup': dupA };
}

test('(b) main registers exactly the packs the renderer catalogue accepts', () => {
  const byDir = manifestsByDir();
  // main's glob keys, deliberately not in folder order
  const globbed = Object.fromEntries(Object.entries(byDir).map(([dir, m]) => [`../../themes/${dir}/theme.json`, m]));
  const main = validatedPackThemeEntries(globbed);
  const renderer = P.catalogue(Object.entries(byDir).map(([dir, m]) => ({ dir, files: P.memoryFiles({ 'theme.json': JSON.stringify(m) }) }))).packs;
  assert.deepEqual(main.map((e) => [e.id, e.label]), renderer.map((p) => [p.id, p.label]), 'the same ids and labels, in the same order');
  assert.deepEqual(main.map((e) => e.id), ['dup-deck', 'bad-seed-deck', 'neutral-deck']);
  assert.equal(main[1].orchestrator, undefined, 'a seed the validator drops is not registered');
  assert.equal(main[0].label, 'Dup A', 'the first folder of an id wins, as in the renderer');
  assert.deepEqual(main.map((e) => e.orchestrator), renderer.map((p) => p.projectDefaults?.orchestrator), 'the validated seed');
  assert.ok(!main.some((e) => e.id === 'shape-only'), 'a shape-only manifest the renderer rejects is not registered');
});

test('(b) main/packThemes.ts registers through the validator', () => {
  const src = read('src/main/packThemes.ts');
  assert.match(src, /import \{ validatedPackThemeEntries \} from '\.\/packThemeEntries';/);
  assert.match(src, /registerPackThemes\(validatedPackThemeEntries\(MANIFESTS\)\);/);
  assert.match(read('src/main/packThemeEntries.ts'), /import \{ validateManifest \} from '\.\.\/renderer\/src\/scene\/themes\/manifest';/);
});

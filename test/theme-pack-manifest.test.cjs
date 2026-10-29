'use strict';
require('./tools/own-job.cjs');

// Theme packs, part 2: theme.json validation, the pack catalogue, and the
// fallback guarantee (an unusable pack is a diagnostic, never a crash).

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const Mf = loadTs('src/renderer/src/scene/themes/manifest.ts');
const P = loadTs('src/renderer/src/scene/themes/packs.ts');
const T = loadTs('src/renderer/src/scene/themes/tiled.ts');

const base = () => JSON.parse(H.readPackDir(H.NEUTRAL)['theme.json']);
const errors = (r) => r.diagnostics.filter((d) => d.level === 'error').map((d) => d.message);
const withManifest = (m) => { const e = H.readPackDir(H.NEUTRAL); e['theme.json'] = JSON.stringify(m); return e; };
const load = (entries) => {
  const r = P.readPack(P.memoryFiles(entries));
  if (!r.value) return r;
  return P.finishPack(r.value, H.decodeImages(H.NEUTRAL, T.normPath, r.value.images), r.diagnostics);
};

test('the neutral manifest is valid and keeps every declared section', () => {
  const r = Mf.validateManifest(base());
  assert.deepEqual(errors(r), []);
  assert.equal(r.manifest.id, 'neutral-deck');
  assert.deepEqual(r.manifest.stations.seatOrder, ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(r.manifest.builder.presets, [
    { id: 'pilot', label: 'Pilot', bodyId: 'dark', colors: { skin: '#7b4d34', shirt: '#a07a1c' }, seat: 'Beta' },
    { id: 'medic', label: 'Medic', bodyId: 'light', colors: { shirt: '#285cc4', hair: '#ececec' } },
  ]);
  assert.deepEqual(r.manifest.builder.bodies[0].parts.skin, { main: '#fad6b8', shades: ['#fad6b8', '#e86a73'] });
  assert.deepEqual(r.manifest.builder.bodies[1].parts.hair, { main: '#242234', shades: ['#242234'], byShape: true });
  assert.deepEqual(r.manifest.builder.bodies[0].portrait, { crop: [7, 4, 18, 28] });
  assert.deepEqual(r.manifest.builder.sample, { bodyId: 'light', presetId: 'medic' });
  assert.deepEqual(r.manifest.projectDefaults, { orchestrator: { name: 'Lead', appearance: { bodyId: 'light' } } });
});

const broken = [
  ['schema', (m) => { m.schema = 2; }, /schema/],
  ['id case', (m) => { m.id = 'Neutral'; }, /id/],
  ['id office', (m) => { m.id = 'office'; }, /office/],
  ['sceneKind', (m) => { m.sceneKind = 'isometric'; }, /sceneKind/],
  ['map outside pack', (m) => { m.map = '../x.tmx'; }, /map/],
  ['map type', (m) => { m.map = 'deck.png'; }, /map/],
  ['palette', (m) => { m.palette.background = 'red'; }, /background/],
  ['no seat order', (m) => { m.stations.seatOrder = []; }, /seatOrder/],
  ['duplicate seat', (m) => { m.stations.seatOrder = ['Alpha', 'Alpha']; }, /seatOrder/],
  ['captain not in order', (m) => { m.stations.captain = 'Bridge'; }, /captain/],
  ['bad facing', (m) => { m.stations.seats.Gamma.facing = 'north'; }, /facing/],
  ['walk grid', (m) => { m.navigation.walkGrid = 0; }, /walkGrid/],
  ['sheet kind', (m) => { m.spriteRenderer.kind = 'code'; }, /kind/],
  ['frame size', (m) => { m.spriteRenderer.frameWidth = 0; }, /frame/],
  ['sprite rows', (m) => { delete m.spriteRenderer.rows.sitUp; }, /sitUp/],
  ['preset seat unknown', (m) => { m.builder.presets[0].seat = 'Nowhere'; }, /seat/],
  ['preset seat is captain', (m) => { m.builder.presets[0].seat = 'Alpha'; }, /captain/],
  ['preset body unknown', (m) => { m.builder.presets[0].bodyId = 'ghost'; }, /body/],
  ['preset colour', (m) => { m.builder.presets[0].colors.skin = 'pink'; }, /presets\[0\]\.colors\.skin/],
  ['preset colour part', (m) => { m.builder.presets[0].colors.hat = '#000000'; }, /hat/],
  ['swatch colour', (m) => { m.builder.swatches.hair.black = '#12'; }, /swatches\.hair/],
  ['swatch part', (m) => { m.builder.swatches.boots = { a: '#000000' }; }, /boots/],
  ['part main', (m) => { m.builder.bodies[0].parts.skin.main = 'skin'; }, /parts\.skin/],
  ['byShape on skin', (m) => { m.builder.bodies[0].parts.skin.byShape = true; }, /byShape/],
  ['byShape without outline', (m) => { delete m.builder.outline; }, /outline/],
  ['portrait outside frame', (m) => { m.builder.bodies[0].portrait.crop = [20, 4, 18, 28]; }, /portrait/],
  ['defaults body', (m) => { m.builder.defaults.bodyId = 'ghost'; }, /defaults\.bodyId/],
  ['sample preset', (m) => { m.builder.sample.presetId = 'ghost'; }, /sample\.presetId/],
  ['custom colours flag', (m) => { m.builder.customColours = 'yes'; }, /customColours/],
];
for (const [name, mutate, re] of broken) {
  test(`invalid manifest is rejected: ${name}`, () => {
    const m = base(); mutate(m);
    const r = Mf.validateManifest(m);
    const errs = errors(r);
    assert.ok(errs.some((e) => re.test(e)), `${name}: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.manifest, null, name);
  });
}

test('a bad optional section is dropped with a warning; the pack still loads', () => {
  const m = base();
  m.projectDefaults = { orchestrator: { name: '', appearance: {} } };
  m.uiTokens = { accent: 5 };
  m.surprise = true;
  const r = Mf.validateManifest(m);
  assert.deepEqual(errors(r), []);
  assert.equal(r.manifest.projectDefaults, undefined);
  assert.equal(r.manifest.uiTokens, undefined);
  assert.ok(r.diagnostics.some((d) => d.level === 'warn' && /surprise/.test(d.message)));
});

test('packs never carry code: a function-like value is just an invalid string', () => {
  const m = base(); m.spriteRenderer = { kind: 'sheet', sheet: 'pictures/sheet.png', frameWidth: 32, frameHeight: 32, rows: 'function(){}' };
  assert.equal(Mf.validateManifest(m).manifest, null);
});

test('fallback: invalid manifest, missing picture, malformed map, bad sprite metadata', () => {
  const cases = [
    ['invalid manifest', (() => { const e = H.readPackDir(H.NEUTRAL); e['theme.json'] = '{ not json'; return e; })(), /JSON/],
    ['missing picture', (() => { const e = H.readPackDir(H.NEUTRAL); delete e['tiles/tiles.png']; return e; })(), /tiles\.png/],
    ['missing sheet', (() => { const e = H.readPackDir(H.NEUTRAL); delete e['pictures/sheet.png']; return e; })(), /sheet/],
    ['malformed map', (() => { const e = H.readPackDir(H.NEUTRAL); e['deck.tmx'] = '<map width="x">'; return e; })(), /map/],
    ['missing tileset', (() => { const e = H.readPackDir(H.NEUTRAL); delete e['tiles/tiles.tsx']; return e; })(), /Tileset file not found/],
    ['bad sprite rows', withManifest({ ...base(), spriteRenderer: { ...base().spriteRenderer, rows: { ...base().spriteRenderer.rows, sitRight: 8 } } }), /sitRight/],
    ['bad body column', withManifest({ ...base(), builder: { bodies: [{ id: 'light', label: 'L', column: 7 }] } }), /column/],
    // a wrong seat affinity is not dropped quietly: the pack is refused and says why
    ['preset seat unknown', withManifest({ ...base(), builder: { ...base().builder, presets: [{ id: 'pilot', seat: 'Nowhere' }] } }), /seat/],
    ['no stations layer', withManifest({ ...base(), stations: { ...base().stations, layer: 'Seats' } }), /Seats/],
    ['no entrance', withManifest({ ...base(), stations: { ...base().stations, entrance: 'Door' } }), /Door/],
    ['seat order names a missing point', withManifest({ ...base(), stations: { ...base().stations, seatOrder: ['Alpha', 'Beta', 'Omega'] } }), /Omega/],
  ];
  for (const [name, entries, re] of cases) {
    let r;
    assert.doesNotThrow(() => { r = load(entries); }, name);
    assert.equal(r.value, null, name);
    assert.ok(errors(r).some((e) => re.test(e)), `${name}: ${JSON.stringify(r.diagnostics)}`);
  }
  // and the good pack loads
  assert.ok(load(H.readPackDir(H.NEUTRAL)).value);
});

test('catalogue: office id and duplicate ids are rejected, the rest listed in folder order', () => {
  const good = P.memoryFiles(H.readPackDir(H.NEUTRAL));
  const office = P.memoryFiles(withManifest({ ...base(), id: 'office' }));
  const res = P.catalogue([{ dir: 'b-copy', files: good }, { dir: 'a-deck', files: good }, { dir: 'c-office', files: office }]);
  assert.deepEqual(res.packs.map((p) => [p.id, p.dir, p.sceneKind]), [['neutral-deck', 'a-deck', 'stations']]);
  assert.deepEqual(res.rejected.map((r) => r.dir), ['b-copy', 'c-office']);
  assert.deepEqual(res.packs[0].projectDefaults, { orchestrator: { name: 'Lead', appearance: { bodyId: 'light' } } });
});

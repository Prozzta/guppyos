'use strict';

// The TES bridge pack (themes/tes): data only, on the generic pack mechanisms. These tests hold the pack to its
// acceptance list: it loads clean; the Human's files are verbatim copies (hashes in SOURCES.json); the bridge is 30x20
// tiles of 32 px with nine seat-only stations (Captain first) and the Spawn entrance; every station is reachable with
// the foot box clear; roaming never stops on a seat; depth sorts the props; the builder, presets and orchestrator seed
// are the agreed ones; Palette A passes contrast; and lines.json is plain data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const ROOT = path.join(__dirname, '..', 'themes', 'tes');
const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
const P = loadTs('src/renderer/src/scene/themes/packs.ts');
const N = loadTs('src/renderer/src/scene/themes/stationMap.ts');
const C = loadTs('src/renderer/src/scene/themes/compositor.ts');
const L = loadTs('src/renderer/src/scene/themes/looks.ts');
const U = loadTs('src/renderer/src/design/uiTokens.ts');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'theme.json'), 'utf8'));

let cached;
function pack() {
  if (cached) return cached;
  const r = P.readPack(P.memoryFiles(H.readPackDir(ROOT)));
  assert.ok(r.value, JSON.stringify(r.diagnostics));
  const f = P.finishPack(r.value, H.decodeImages(ROOT, T.normPath, r.value.images), r.diagnostics);
  assert.ok(f.value, JSON.stringify(f.diagnostics));
  return (cached = { ...f.value, diagnostics: f.diagnostics, data: r.value });
}
const rng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

test('the pack loads with no diagnostic at all and joins the catalogue as "tes"', () => {
  assert.deepEqual(pack().diagnostics, []);
  const cat = P.catalogue([{ dir: 'tes', files: P.memoryFiles(H.readPackDir(ROOT)) }]);
  assert.deepEqual(cat.rejected, []);
  assert.deepEqual(cat.packs.map((p) => [p.id, p.label, p.sceneKind]), [['tes', 'TES', 'stations']]);
  assert.equal(cat.packs[0].projectDefaults.orchestrator.name, 'Cpt Kerk');
  assert.deepEqual(cat.packs[0].uiTokens, U.sanitizeUiTokens(manifest.uiTokens));
});

test('provenance: every copied file is byte-identical to the Human\'s original (SOURCES.json), with licence and attribution', () => {
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'SOURCES.json'), 'utf8'));
  assert.equal(src.copied.length, 11);
  for (const c of src.copied) {
    const buf = fs.readFileSync(path.join(ROOT, c.path));
    assert.equal(buf.length, c.bytes, c.path);
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), c.sha256, `${c.path} is not the verbatim copy`);
  }
  assert.deepEqual(src.generated.map((g) => g.path), ['lines.json']);
  assert.equal(manifest.assets.attribution, 'Artwork by Prozzta');
  assert.ok(fs.existsSync(path.join(ROOT, 'LICENSE-ARTWORK.md')));
});

test('the bridge: 30x20 tiles of 32 px, nine stations in seat order (Captain first), the Spawn entrance left out', () => {
  const S = pack().scene;
  assert.deepEqual([S.PW, S.PH], [960, 640]);
  assert.deepEqual(S.seatOrder.map((s) => s.name), ['Captain', 'Speck1', 'Speck2', 'Chair1', 'Chair2', 'Chair3', 'Chair4', 'Chair5', 'Chair6']);
  assert.equal(S.captain.name, 'Captain');
  assert.equal(S.stations.length, 9);
  assert.ok(!S.stations.some((s) => s.name === 'Spawn'));
  assert.deepEqual(S.stations.filter((s) => s.role).map((s) => [s.name, s.facing, s.role]),
    [['Captain', 'down', 'command'], ['Speck1', 'down', 'helm'], ['Speck2', 'down', 'navigation']]);
});

test('every station is reachable from the entrance with the foot box clear, and is seat-only', () => {
  const S = pack().scene;
  for (const st of S.stations) {
    const Z = S.seatZones.get(st);
    assert.ok(Z, `${st.name} has a seat zone`);
    const route = N.route(S, S.entrance[0], S.entrance[1], st.x, st.y, Z, true);
    assert.ok(route && route.length, `${st.name} is reachable`);
    assert.deepEqual(route[route.length - 1], [st.x, st.y], `${st.name} ends exactly on its seat`);
    let cur = S.entrance;
    for (const p of route) { assert.ok(N.segClear(S, cur, p, Z), `${st.name}: ${cur} -> ${p}`); cur = p; }
    assert.equal(N.inSeatZone(S, st.x, st.y), true, `${st.name} lies in a seat zone (nobody roams onto it)`);
  }
});

test('coffee, inline (the map has no Coffee point or mug layer): two reachable brew spots behind the lower wall, a parked mug per station', () => {
  const S = pack().scene, C = pack().data.manifest.coffee;
  assert.deepEqual(C.cooldown, [180, 300]);
  assert.equal(S.brew.length, 2);
  S.brew.forEach((b, i) => {
    assert.ok(Math.hypot(b[0] - C.brewAt[i][0], b[1] - C.brewAt[i][1]) <= 3 * Math.SQRT2 * 4 + 2, `brew ${b} is within 3 cells of ${C.brewAt[i]}`);
    const route = N.route(S, S.entrance[0], S.entrance[1], b[0], b[1], undefined, true);
    assert.ok(route && route.length, `brew ${b} is reachable from the entrance`);
  });
  assert.deepEqual(S.seatOrder.map((s) => [s.name, S.mugSpots.get(s)]), S.seatOrder.map((s) => [s.name, C.mugs[s.name]]));
});

test('roaming never stops on a seat zone and only on open floor', () => {
  const S = pack().scene, rand = rng(11);
  for (let i = 0; i < 400; i++) {
    const t = N.wanderTarget(S, rand);
    assert.ok(t);
    assert.equal(N.inSeatZone(S, t[0], t[1]), false, `stop ${t} lies on a seat`);
    assert.equal(N.footHits(S, t[0], t[1]), 0, `stop ${t} touches a solid`);
  }
});

test('depth: the props stand up from their feet and a person sorts in front of / behind them by foot line', () => {
  const pk = pack();
  const plan = C.buildScenePlan({ ...pk.scene, store: pk.store });
  const chairs = plan.sorted.filter((i) => i.chair).map((i) => i.chair.o.name).sort();
  assert.deepEqual(chairs, ['Chair1', 'Chair2', 'Chair3', 'Chair4', 'Chair5', 'Chair6', 'CptChair', 'Speck1', 'Speck2'], 'one chair per station');
  assert.ok(plan.sorted.length > chairs.length, 'the rails and consoles are sorted pieces too, not floor');
  for (const it of plan.sorted) {
    const items = [{ foot: it.foot, rank: it.rank, k: 'prop' }];
    const order = (y) => [...items, { ...C.personKey(y, null, null), k: 'person' }].sort(C.byDepth).map((i) => i.k);
    assert.deepEqual(order(it.foot - 4), ['person', 'prop'], 'north of the foot line: drawn first');
    assert.deepEqual(order(it.foot + 4), ['prop', 'person'], 'south of the foot line: drawn after');
  }
});

test('builder: the three bodies, the nine premades (Sele and Jackov hold the Speck seats), and the Kerk seed', () => {
  const b = manifest.builder;
  assert.deepEqual(b.bodies.map((x) => x.id), ['velcan-male', 'human-male', 'human-female']);
  assert.deepEqual(b.presets.map((x) => x.label),
    ['Cpt Kerk', 'Speck', 'McCey', 'UHera', 'Jackov', 'Sele', 'Scetty', 'Nurse Chepel', 'Yeoman Rend']);
  assert.deepEqual(b.presets.filter((x) => x.seat).map((x) => [x.id, x.seat]), [['jackov', 'Speck2'], ['sele', 'Speck1']]);
  const o = manifest.projectDefaults.orchestrator;
  assert.equal(o.name, 'Cpt Kerk');
  assert.equal(o.appearance.bodyId, 'human-male');
  assert.equal(o.appearance.colors.shirt, b.swatches.shirt['command gold']);
  assert.equal(o.appearance.colors.skin, b.swatches.skin.fair, 'the default skin');
  // the seed resolves to the cpt-kerk premade through the generic look path
  const look = L.lookFromRequest(pack().data.manifest.builder, o.appearance);
  assert.equal(look.presetId, 'cpt-kerk');
  assert.equal(look.bodyId, 'human-male');
});

test('Palette A: the pack\'s UI tokens are whitelisted colours and pass every contrast check, light and dark', () => {
  const clean = U.sanitizeUiTokens(manifest.uiTokens);
  assert.deepEqual(clean, manifest.uiTokens);
  for (const mode of ['light', 'dark']) assert.deepEqual(U.contrastFailures(U.resolveUiPalette(mode, clean)), [], mode);
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ui-tokens-command-gold.json'), 'utf8'));
  assert.deepEqual(manifest.uiTokens, fixture.uiTokens, 'the same values as the unbranded Palette A fixture');
});

test('lines.json is plain data: categories of lines (or exchanges of lines)', () => {
  assert.equal(manifest.text.lines, 'lines.json');
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'lines.json'), 'utf8'));
  assert.deepEqual(Object.keys(file).sort(), ['$comment', 'lines']);
  const cats = Object.entries(file.lines);
  assert.ok(cats.length >= 40);
  for (const [k, v] of cats) {
    assert.ok(Array.isArray(v) && v.length, k);
    const line = (s) => typeof s === 'string' && s.trim().length > 0;
    assert.ok(v.every((s) => line(s) || (Array.isArray(s) && s.length >= 2 && s.every(line))), k);   // a line, or an exchange of lines
  }
});

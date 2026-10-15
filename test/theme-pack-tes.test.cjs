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
const Cr = loadTs('src/renderer/src/scene/themes/crew.ts');
const SA = loadTs('src/renderer/src/scene/themes/seatAllocator.ts');
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

// Each station's chair on the bridge (its solid is named after the chair object).
const CHAIR = { Captain: 'CptChair', Speck1: 'Speck1', Speck2: 'Speck2', Chair1: 'Chair1', Chair2: 'Chair2', Chair3: 'Chair3', Chair4: 'Chair4', Chair5: 'Chair5', Chair6: 'Chair6' };
const chairId = (S, st) => S.solidName.indexOf(`"${CHAIR[st.name]}"`);
// The side each seat is entered from: the Captain's chair faces into the bridge; every other one faces a console or wall.
const SIDE = { Captain: 'front', Speck1: 'back', Speck2: 'back', Chair1: 'back', Chair2: 'back', Chair3: 'back', Chair4: 'back', Chair5: 'back', Chair6: 'back' };

test('every station is reached by plain floor to its approach spot, then one leg in from its approach side', () => {
  const S = pack().scene;
  for (const st of S.stations) {
    const own = chairId(S, st);
    assert.ok(own > 0 && S.seatChair.get(st) === own, `${st.name}'s chair is ${CHAIR[st.name]}`);
    const a = S.approach.get(st), route = N.seatRoute(S, S.entrance[0], S.entrance[1], st);
    assert.ok(a && route && route.length >= 2, `${st.name} is reachable`);
    assert.deepEqual(route[route.length - 1], [st.x, st.y], `${st.name} ends exactly on its seat`);
    assert.deepEqual(route[route.length - 2], a, `${st.name} steps in from its approach spot`);
    let cur = S.entrance;
    for (const p of route.slice(0, -1)) { assert.ok(N.segClear(S, cur, p), `${st.name}: ${cur} -> ${p} crosses nothing`); cur = p; }
    assert.ok(N.segClear(S, a, [st.x, st.y], [own]), `${st.name}: the leg in crosses only its own chair`);
    const [vx, vy] = N.sideVector(st.facing, SIDE[st.name]);
    assert.ok((a[0] - st.x) * vx + (a[1] - st.y) * vy > 0, `${st.name} is entered from its ${SIDE[st.name]} (${a})`);
    assert.equal(N.inSeatZone(S, st.x, st.y), true, `${st.name} lies in a seat zone (nobody roams onto it)`);
  }
  const cap = S.stations.find((s) => s.name === 'Captain');
  assert.ok(S.approach.get(cap)[1] > cap.y, 'Cpt Kerk sits down from the front of his chair, not over its back');
});

test('getting up: the first step is back out to the approach spot, then plain floor', () => {
  const pk = pack(), S = pk.scene;
  const crew = new Cr.Crew(S, SA.seatRulesFrom(pk.manifest, S.seatOrder.map((s) => s.name)), rng(5));
  const ids = S.seatOrder.map((s, i) => (i ? `a${i}` : 'god'));
  crew.sync(ids.map((id) => ({ id, status: 'working', orchestrator: id === 'god' })));
  for (let i = 0; i < 2400 && !crew.walkers().every((p) => p.seated); i++) crew.tick(50);
  assert.ok(crew.walkers().every((p) => p.seated), 'everyone sat down');
  for (const p of crew.walkers()) {
    const a = S.approach.get(p.seat);
    assert.ok(crew.goTo(p, 470, 300, true), `${p.id} can leave ${p.seat.name}`);
    assert.deepEqual(p.path[0], a, `${p.id} gets out of ${p.seat.name} by its approach spot`);
    let cur = a;
    for (const q of p.path.slice(1)) { assert.ok(N.segClear(S, cur, q), `${p.id}: ${cur} -> ${q} crosses nothing`); cur = q; }
  }
});

test('walkZones: a walker only crosses a chair it is stuck in that is its own, its last, or untaken', () => {
  const pk = pack(), S = pk.scene, st = (n) => S.stations.find((s) => s.name === n);
  const crew = new Cr.Crew(S, SA.seatRulesFrom(pk.manifest, S.seatOrder.map((s) => s.name)), rng(5));
  // eight on duty: every seat but Chair6 is taken
  crew.sync(S.seatOrder.slice(0, 8).map((s, i) => ({ id: i ? `a${i}` : 'god', status: 'working', orchestrator: !i })));
  const W = crew.walkers(), a1 = W.find((p) => p.id === 'a1');
  assert.equal(a1.seat.name, 'Speck1');
  assert.equal(W.find((p) => p.id === 'a6').seat.name, 'Chair4');
  assert.ok(!W.some((p) => p.seat && p.seat.name === 'Chair6'), 'Chair6 is free');
  // the nearest foot spot by a seat whose foot box is on that seat's chair and nothing else
  const inChair = (n) => {
    const s = st(n), id = S.seatChair.get(s);
    let best = null;
    for (let dy = -16; dy <= 16; dy++) for (let dx = -16; dx <= 16; dx++) {
      const [x0, y0, x1, y1] = N.footBox(s.x + dx, s.y + dy);
      let hits = 0, other = false;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = S.solid[y * S.PW + x]; if (v === id) hits++; else if (v) other = true; }
      if (hits && !other && (!best || Math.abs(dx) + Math.abs(dy) < best[2])) best = [s.x + dx, s.y + dy, Math.abs(dx) + Math.abs(dy)];
    }
    assert.ok(best, `a foot spot on ${n}'s chair`);
    return best;
  };
  const at = ([x, y]) => { a1.x = x; a1.y = y; return crew.walkZones(a1); };
  assert.deepEqual(at(S.entrance), [], 'open floor: nothing is excused, not even its own chair');
  assert.deepEqual(at(inChair('Chair4')), [], 'stuck in a chair someone else has taken: nothing is excused');
  assert.deepEqual(at(inChair('Chair6')), [S.seatChair.get(st('Chair6'))], 'stuck in an untaken chair: that chair, to get out');
  assert.deepEqual(at(inChair('Speck1')), [S.seatChair.get(st('Speck1'))], 'in its own chair: that chair');
});

test('a manifest approach side that is not open floor warns and falls back (Speck1 "front" is entered from the left)', () => {
  const files = H.readPackDir(ROOT), m = JSON.parse(files['theme.json']);
  m.stations.seats.Speck1.approach = 'front';
  const r = P.readPack(P.memoryFiles({ ...files, 'theme.json': JSON.stringify(m) }));
  const f = P.finishPack(r.value, H.decodeImages(ROOT, T.normPath, r.value.images), r.diagnostics);
  assert.deepEqual(f.diagnostics, [{ level: 'warn', message: 'Station "Speck1": its approach side "front" is not open floor; it is entered from the left.' }]);
  const S = f.value.scene, s1 = S.stations.find((s) => s.name === 'Speck1'), a = S.approach.get(s1);
  const [vx, vy] = N.sideVector(s1.facing, 'left');
  assert.ok(a && (a[0] - s1.x) * vx + (a[1] - s1.y) * vy > 0, `Speck1 is entered from its left (${a})`);
  assert.ok(N.seatRoute(S, S.entrance[0], S.entrance[1], s1), 'and is still reachable');
});

test('crew sim: nobody ever walks over the Speck console or any chair but their own', () => {
  const pk = pack(), S = pk.scene, rand = rng(7);
  const crew = new Cr.Crew(S, SA.seatRulesFrom(pk.manifest, S.seatOrder.map((s) => s.name)), rand);
  const ids = S.seatOrder.map((s, i) => (i ? `a${i}` : 'god')), st = {};
  const chairs = new Set(S.stations.map((s) => chairId(S, s)));
  const console = S.solidName.indexOf('"Console"');
  assert.ok(console > 0);
  const bad = new Map();
  for (let t = 0; t < 10 * 60000; t += 50) {
    if (t % 15000 === 0) { for (const id of ids) st[id] = rand() < 0.5 ? 'working' : 'idle'; crew.sync(ids.map((id) => ({ id, status: st[id], orchestrator: id === 'god' }))); }
    crew.tick(50);
    for (const p of crew.walkers()) {
      const own = new Set([p.seat, p.lastSeat].filter(Boolean).map((s) => chairId(S, s)));
      const [x0, y0, x1, y1] = N.footBox(p.x, p.y);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const id = S.solid[y * S.PW + x];
        if (id && (id === console || (chairs.has(id) && !own.has(id)) || (!chairs.has(id) && id !== console))) {
          const k = `${p.id} on ${S.solidName[id]}`;
          if (!bad.has(k)) bad.set(k, `${Math.round(p.x)},${Math.round(p.y)}`);
        }
      }
    }
  }
  assert.deepEqual([...bad], []);
});

test('the walk mask is the audited one: the seat fix changed who may cross it, not what is solid', () => {
  const S = pack().scene;
  const h = (a) => crypto.createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
  assert.equal(h(S.solid), 'fd681fbfc1c14db57039c80f491bed06a3dc885c7ff2d28a241712aabb4a8598');
  assert.equal(h(S.grid.open), '8b4a76fc6343937a8ef47a1a8f1129155e6eea9180de9827a0d390358f08eb06');
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
    const lines = (s) => Array.isArray(s) && s.length >= 2 && s.every(line);
    const roles = (o) => o.roles === undefined || (Array.isArray(o.roles) && o.roles.length === o.lines.length && o.roles.every(line));
    // a line, or an exchange of lines (an array, or {lines, roles?} as TES-EXCHANGES-188 added)
    assert.ok(v.every((s) => line(s) || lines(s) || (s && typeof s === 'object' && lines(s.lines) && roles(s))), k);
  }
});

'use strict';

// Theme packs, part 3: the analysed scene of the neutral fixture pack:
// collision rasterized from polygons, rectangles and visible walls; seat-only
// stations; roaming that never stops on a seat; routes that never cross a
// solid pixel; and depth (people in front of / behind the rail and chairs).

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
const P = loadTs('src/renderer/src/scene/themes/packs.ts');
const N = loadTs('src/renderer/src/scene/themes/stationMap.ts');
const C = loadTs('src/renderer/src/scene/themes/compositor.ts');
const Cr = loadTs('src/renderer/src/scene/themes/crew.ts');
const SA = loadTs('src/renderer/src/scene/themes/seatAllocator.ts');

let cached;
function pack() {
  if (cached) return cached;
  const r = P.readPack(P.memoryFiles(H.readPackDir(H.NEUTRAL)));
  const f = P.finishPack(r.value, H.decodeImages(H.NEUTRAL, T.normPath, r.value.images), r.diagnostics);
  assert.ok(f.value, JSON.stringify(f.diagnostics));
  return (cached = f.value);
}
const solidAt = (S, x, y) => S.solidName[S.solid[y * S.PW + x]];
const rng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

test('stations: from the manifest layer, entrance and excluded points left out, facings from the manifest then the map', () => {
  const S = pack().scene;
  assert.deepEqual(S.stations.map((s) => [s.name, s.x, s.y, s.facing, s.role ?? null]),
    [['Alpha', 40, 58, 'up', null], ['Beta', 120, 58, 'up', null], ['Gamma', 40, 138, 'right', 'ops']]);
  assert.deepEqual(S.seatOrder.map((s) => s.name), ['Alpha', 'Beta', 'Gamma']);
  assert.equal(S.captain.name, 'Alpha');
  assert.deepEqual(S.entrance, [96, 140]);
});

test('collision raster: rectangle and polygon shapes, visible walls, the floor edge, furniture footprints', () => {
  const S = pack().scene;
  assert.equal(solidAt(S, 60, 105), 'collision shape "rail-guard"');
  assert.equal(solidAt(S, 189, 131), 'collision shape "corner"'); // inside the triangle
  assert.equal(solidAt(S, 163, 157), ''); // below its diagonal: open
  assert.equal(solidAt(S, 50, 5), 'the wall "Walls"');
  assert.equal(solidAt(S, 40, 44), '"desk-a"'); // the desk's lower half blocks
  assert.equal(solidAt(S, 40, 36), ''); // its upper half (the far edge) does not
  assert.equal(solidAt(S, 40, 59), '"chair-a"');
  assert.equal(solidAt(S, 40, 52), ''); // between the backrest and the seat
  // hidden collision layers are switched off (Tiled's own convention in the viewer)
  const e = H.readPackDir(H.NEUTRAL);
  e['deck.tmx'] = e['deck.tmx'].replace('name="collision-shapes" visible="1"', 'name="collision-shapes" visible="0"');
  const r = P.readPack(P.memoryFiles(e));
  const S2 = P.finishPack(r.value, H.decodeImages(H.NEUTRAL, T.normPath, r.value.images)).value.scene;
  assert.equal(solidAt(S2, 189, 131), '');
});

test('seat-only stations: the owner reaches a station inside its chair; nobody else can', () => {
  const S = pack().scene, G = S.grid, alpha = S.stations[0], ex = [S.seatChair.get(alpha)];
  const to = [Math.floor(alpha.x / G.g), Math.floor(alpha.y / G.g)];
  assert.ok(ex[0], 'Alpha has a chair');
  assert.equal(N.astar({ S, G }, S.start, to), null);
  assert.ok(N.astar({ S, G }, S.start, to, ex));
  assert.ok(N.footHits(S, alpha.x, alpha.y) > 0);
  assert.equal(N.footHits(S, alpha.x, alpha.y, ex), 0);
  assert.ok(S.approach.get(alpha), 'Alpha has an approach spot');
});

test('an excuse names solids by id: it covers that furniture only, never the map\'s own collision', () => {
  const S = pack().scene;
  const every = S.solidName.map((_, i) => i).filter((i) => i);
  assert.ok(N.footHits(S, 60, 107, every) > 0, 'the rail guard (a collision shape) is never excused');
  const [x0, y0, x1, y1] = N.footBox(40, 47), under = new Set();
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (S.solid[y * S.PW + x]) under.add(S.solid[y * S.PW + x]);
  assert.ok(N.footHits(S, 40, 47) > 0 && under.size > 0);
  assert.equal(N.footHits(S, 40, 47, [...under]), 0, 'the furniture there is excused by its own id');
  assert.ok(N.footHits(S, 40, 47, every.filter((i) => !under.has(i))) > 0, 'excusing other solids does not excuse it');
});

test('segClear also checks the mixed corners of a diagonal step', () => {
  // a 40×40 field with one solid pixel, placed where only the mixed (x, prevY) box reaches
  const PW = 40, PH = 40, a = [10, 20], b = [20, 30];
  const n = Math.ceil(2 * Math.hypot(b[0] - a[0], b[1] - a[1]));
  const pts = Array.from({ length: n + 1 }, (_, t) => [Math.round(a[0] + (b[0] - a[0]) * t / n), Math.round(a[1] + (b[1] - a[1]) * t / n)]);
  const inBox = (x, y, [X, Y]) => x >= X - 6 && x < X + 6 && y >= Y - 5 && y < Y + 1;
  let pixel = null;
  for (let i = 1; i < pts.length && !pixel; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i];
    if (x === px || y === py) continue;
    for (let yy = py - 5; yy < py + 1 && !pixel; yy++) for (let xx = x - 6; xx < x + 6; xx++)
      if (!pts.some((p) => inBox(xx, yy, p))) { pixel = [xx, yy]; break; }
  }
  assert.ok(pixel, 'the line has a diagonal step with an uncovered mixed corner');
  const solid = new Uint16Array(PW * PH); solid[pixel[1] * PW + pixel[0]] = 1;
  const integ = new Uint32Array((PW + 1) * (PH + 1));
  for (let y = 0; y < PH; y++) for (let x = 0, row = 0; x < PW; x++) { row += solid[y * PW + x] ? 1 : 0; integ[(y + 1) * (PW + 1) + x + 1] = integ[y * (PW + 1) + x + 1] + row; }
  const S = { PW, PH, solid, integ, hard: [false, false] };
  assert.ok(pts.every((p) => N.footHits(S, p[0], p[1]) === 0), 'no sampled position touches it');
  assert.equal(N.segClear(S, a, b), false);
});

test('roaming never stops on a seat zone and only on reachable open floor', () => {
  const S = pack().scene, rand = rng(7);
  for (let i = 0; i < 300; i++) {
    const t = N.wanderTarget(S, rand);
    assert.ok(t);
    assert.equal(N.inSeatZone(S, t[0], t[1]), false, `stop ${t} lies on a seat`);
    assert.equal(N.footHits(S, t[0], t[1]), 0);
  }
});

test('routes: plain floor to the approach spot, then one leg in crossing only the owner\'s chair', () => {
  const S = pack().scene;
  for (const st of S.stations) {
    const Z = [S.seatChair.get(st)], a = S.approach.get(st);
    const path = N.seatRoute(S, S.entrance[0], S.entrance[1], st);
    assert.ok(path && path.length >= 2, st.name);
    assert.deepEqual(path[path.length - 1], [st.x, st.y], `${st.name} ends exactly on its seat`);
    assert.deepEqual(path[path.length - 2], a, `${st.name} steps in from its approach spot`);
    let cur = S.entrance;
    for (const p of path.slice(0, -1)) { assert.ok(N.segClear(S, cur, p), `${st.name}: ${cur} -> ${p} on plain floor`); cur = p; }
    assert.ok(N.segClear(S, cur, [st.x, st.y], Z), `${st.name}: the leg in`);
  }
  // the rail is in the way between the entrance and Alpha: the route goes round its end
  const path = N.route(S, 96, 140, 40, 58, [S.seatChair.get(S.stations[0])], true);
  assert.ok(path.some(([x]) => x < 32 || x > 160), JSON.stringify(path));
});

test('routes from a wall pocket: the first leg is checked too, and rerouted via a cell in clear sight', () => {
  const S = pack().scene, G = S.grid;
  const targets = [...S.stations.map((st) => [st.x, st.y, [S.seatChair.get(st)]]), [S.entrance[0], S.entrance[1], undefined]];
  let pockets = 0, routed = 0;
  for (let y = 0; y < G.H * G.g; y++) for (let x = 0; x < G.W * G.g; x++) {
    const c = [Math.floor(x / G.g), Math.floor(y / G.g)];
    if (!G.open[c[1] * G.W + c[0]]) continue;
    const p = [x + 0.37, y + 0.61];
    if (N.footHits(S, p[0], p[1]) || N.segClear(S, p, N.cellCentre(G, c))) continue;
    pockets++;
    for (const [tx, ty, Z] of targets) {
      const path = N.route(S, p[0], p[1], tx, ty, Z, true);
      if (!path) continue;
      routed++;
      let cur = p;
      for (const q of path) { assert.ok(N.segClear(S, cur, q, Z), `from ${p} to ${tx},${ty}: ${cur} -> ${q}`); cur = q; }
    }
  }
  assert.ok(pockets > 0 && routed > 0, `the fixture has wall pockets to start from (${pockets}, ${routed} routes)`);
});

test('routes with exact: the target is appended only when the foot box is clear there', () => {
  const S = pack().scene, G = S.grid;
  let tried = 0;
  for (let y = 0; y < G.H * G.g && tried < 60; y += 3) for (let x = 0; x < G.W * G.g && tried < 60; x += 3) {
    const c = [Math.floor(x / G.g), Math.floor(y / G.g)];
    if (!G.open[c[1] * G.W + c[0]] || !N.footHits(S, x, y)) continue; // an open cell, but the foot box would touch a solid here
    const path = N.route(S, S.entrance[0], S.entrance[1], x, y, undefined, true);
    if (!path) continue;
    tried++;
    assert.notDeepEqual(path[path.length - 1], [x, y], `${x},${y}: stops on the last open cell instead`);
    let cur = S.entrance;
    for (const q of path) { assert.ok(N.segClear(S, cur, q), `to ${x},${y}: ${cur} -> ${q}`); cur = q; }
  }
  assert.ok(tried > 0, 'the fixture has blocked targets on open cells');
});

test('depth: the rail stands up from its foot; people behind it are covered, people in front are not', () => {
  const pk = pack(), S = pk.scene;
  const plan = C.buildScenePlan({ ...S, store: pk.store });
  const rail = plan.sorted.find((i) => !i.chair);
  assert.ok(rail, 'the rail is a sorted piece, not floor');
  assert.equal(rail.foot, 108);
  assert.deepEqual([rail.x, rail.y, rail.px.width, rail.px.height], [32, 104, 128, 4]);
  const order = (y) => {
    const items = [...plan.sorted.map((it, i) => ({ foot: it.foot, rank: it.rank, k: it.chair ? it.chair.o.name : 'rail' })), { ...C.personKey(y, null, null), k: 'person' }];
    return items.sort(C.byDepth).map((i) => i.k);
  };
  const behind = order(100), front = order(120);
  assert.ok(behind.indexOf('person') < behind.indexOf('rail'), 'north of the rail: drawn before it');
  assert.ok(front.indexOf('person') > front.indexOf('rail'), 'south of the rail: drawn after it');
  // the rail's pixels are not in the "below" buffer, the floor's are
  const at = (px, x, y) => px.data[(y * px.width + x) * 4 + 3];
  assert.equal(at(plan.below, 60, 105), 255);
  const below = plan.below.data.slice((105 * plan.below.width + 60) * 4, (105 * plan.below.width + 60) * 4 + 3);
  assert.deepEqual(Array.from(below), [100, 100, 110], 'under the rail: floor colour');
});

test('depth: a seated person is drawn with their chair (facing away: just behind it)', () => {
  const pk = pack(), plan = C.buildScenePlan({ ...pk.scene, store: pk.store });
  const alpha = pk.scene.stations[0], ch = C.chairOf(alpha, plan.sorted);
  assert.equal(ch.chair.o.name, 'chair-a');
  const up = C.seatPose(ch, 'up', 32, 32, null), down = C.seatPose(ch, 'down', 32, 32, null);
  // a side sitter's frame centre is half a frame WIDTH past the fitted left edge (it matters for non-square frames)
  assert.equal(C.seatPose(ch, 'left', 24, 32, 5).x, ch.chair.x0 + 5 + 12);
  assert.equal(C.seatPose(ch, 'right', 32, 48, 5).x, ch.chair.x0 + 5 + 16);
  assert.deepEqual([up.x, up.y, up.behind], [40, 32, true]);
  assert.deepEqual([down.x, down.y, down.behind], [40, 42, false]);
  const kUp = C.personKey(alpha.y, ch, up), kDown = C.personKey(alpha.y, ch, down);
  assert.deepEqual([kUp.foot, kUp.rank], [ch.foot, ch.rank - 0.5]);
  assert.deepEqual([kDown.foot, kDown.rank], [ch.foot, ch.rank + 0.5]);
  // a side-facing sitter rests their back on the backrest (the chair's highest pixels)
  const sheet = pk.store.get(pk.sheet);
  const fit = C.sideFit(pk.store, ch.chair.B, { sheet, sx: 0, sy: 7 * 32, fw: 32, fh: 32 }, 'right');
  assert.equal(fit, 11 - 10); // backrest's right edge (x 11) minus the body's rearmost column (x 10)
});

test('crew: arrivals walk from the entrance, sit at their stations and face the way the pack says', () => {
  const pk = pack(), S = pk.scene;
  const crew = new Cr.Crew(S, SA.seatRulesFrom(pk.manifest, S.seatOrder.map((s) => s.name)), rng(3));
  crew.sync([{ id: 'lead', status: 'working', orchestrator: true }, { id: 'a', status: 'working' }, { id: 'b', status: 'idle' }]);
  for (let i = 0; i < 600; i++) {
    crew.tick(50);
    for (const p of crew.walkers()) if (!p.seated) assert.equal(N.footHits(S, p.x, p.y, crew.walkZones(p)), 0, `${p.id} at ${p.x},${p.y}`);
  }
  for (const p of crew.walkers()) if (p.seated) assert.ok(Math.hypot(p.x - p.seat.x, p.y - p.seat.y) < 1, `${p.id} sits at ${p.x},${p.y}, not on ${p.seat.name}`);
  const at = Object.fromEntries(crew.walkers().map((p) => [p.id, [p.seat && p.seat.name, p.seated, p.dir]]));
  assert.deepEqual(at.lead, ['Alpha', true, 'up']);
  assert.deepEqual(at.a, ['Beta', true, 'up']);
  assert.equal(at.b[0], 'Gamma'); // holds a station, but idle: wanders instead of sitting
  assert.equal(at.b[1], false);
});

test('crew: a walker with no way to its station keeps trying and never sits away from it', () => {
  const pk = pack(), S = pk.scene;
  const crew = new Cr.Crew(S, SA.seatRulesFrom(pk.manifest, S.seatOrder.map((s) => s.name)), rng(5));
  let tries = 0;
  crew.goTo = crew.goSeat = () => { tries++; return false; };
  crew.sync([{ id: 'a', status: 'working' }]);
  for (let i = 0; i < 200; i++) crew.tick(50);
  const p = crew.get('a');
  assert.equal(p.seat.name, 'Beta');
  assert.equal(p.seated, false);
  assert.ok(tries >= 3, `retried ${tries} times`);
});

test('pack pictures decode through an image element, never fetch(): the CSP allows data: for img-src only', () => {
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/src/scene/themes/themeCatalog.ts'), 'utf8');
  const decode = src.slice(src.indexOf('async function decode('), src.indexOf('\n}\n', src.indexOf('async function decode(')));
  assert.match(decode, /new Image\(\)[\s\S]*await img\.decode\(\)[\s\S]*createImageBitmap\(img,/);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /\bfetch\(/,'Vite inlines small pictures as data: URLs, and connect-src refuses them');
  const csp = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8').match(/img-src ([^;]*);/);
  assert.ok(csp && /\bdata:/.test(csp[1]) && /\bblob:/.test(csp[1]), 'img-src allows inlined and emitted pictures');
});

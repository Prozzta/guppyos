'use strict';

// Theme packs, part 5: idle people's coffee runs and wander-stop chats on the
// neutral fixture pack. The brew spot and the mug spots come from the pack;
// each agent waits the pack's cooldown between runs; a full mug parked at
// their station is drunk before another run; a run that cannot finish gives up.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
const P = loadTs('src/renderer/src/scene/themes/packs.ts');
const N = loadTs('src/renderer/src/scene/themes/stationMap.ts');
const Mf = loadTs('src/renderer/src/scene/themes/manifest.ts');
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
const rng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const crewOf = (seed, opts) => { const pk = pack(), S = pk.scene; return new Cr.Crew(S, SA.seatRulesFrom(pk.manifest, S.seatOrder.map((s) => s.name)), rng(seed), opts); };
const run = (crew, ms, each) => { for (let t = 0; t < ms; t += 50) { crew.tick(50); if (each) each(); } };

test('coffee pack data: the brew point is a spot, never a station; mug points by station name', () => {
  const pk = pack(), S = pk.scene;
  assert.deepEqual(pk.manifest.coffee, { brew: ['Coffee'], mugLayer: 'Mugs', cooldown: [180, 300] });
  assert.deepEqual(S.brew, [[168, 80]]);
  assert.ok(!S.stations.some((s) => s.name === 'Coffee'));
  assert.deepEqual([...S.mugSpots].map(([s, p]) => [s.name, ...p]), [['Alpha', 44, 52], ['Beta', 124, 52], ['Gamma', 52, 146]]);
});

test('coffee manifest: malformed sections warn and are dropped; a brew point named as a seat is refused', () => {
  const base = JSON.parse(require('node:fs').readFileSync(require('node:path').join(H.NEUTRAL, 'theme.json'), 'utf8'));
  const check = (coffee) => Mf.validateManifest({ ...base, coffee });
  for (const bad of [[], { brew: [] }, { brew: 'Coffee' }, { brew: ['Coffee'], cooldown: [300, 180] }, { brew: ['Coffee'], cooldown: [1, 5] }, { brew: ['Coffee'], mugLayer: 3 }]) {
    const r = check(bad);
    assert.ok(r.manifest, JSON.stringify(bad));
    assert.equal(r.manifest.coffee, undefined, JSON.stringify(bad));
    assert.ok(r.diagnostics.some((d) => d.level === 'warn' && /coffee/.test(d.message)), JSON.stringify(bad));
  }
  const seat = check({ brew: ['Beta'] });
  assert.equal(seat.manifest.coffee, undefined);
  assert.ok(seat.diagnostics.some((d) => /never a seat/.test(d.message)));
  assert.deepEqual(check({ brew: ['Coffee'] }).manifest.coffee, { brew: ['Coffee'] }); // the cooldown default is the crew's
});

test('coffee map data: an unknown or walled-in brew point is reported and left out', () => {
  const pk = pack();
  const a = N.analyseStationMap(pk.map, pk.store, { stations: pk.manifest.stations, navigation: pk.manifest.navigation, coffee: { brew: ['Nowhere', 'Lounge'], mugLayer: 'Cups' } });
  assert.deepEqual(a.brew, [[150, 90]]);
  assert.ok(a.diagnostics.some((d) => d.level === 'warn' && /"Nowhere"/.test(d.message)));
  assert.ok(a.diagnostics.some((d) => d.level === 'warn' && /"Cups"/.test(d.message)));
  assert.equal(a.mugSpots.size, 0);
  const walled = N.analyseStationMap(pk.map, pk.store, { stations: pk.manifest.stations, coffee: { brew: ['Gamma'] } });
  // a point in the top wall: no reachable open floor within 3 cells
  pk.map.layers.find((l) => l.name === 'Stations').objects.push({ ...pk.map.layers.find((l) => l.name === 'Stations').objects[0], name: 'InCorner', x: 96, y: 2 });
  const corner = N.analyseStationMap(pk.map, pk.store, { stations: pk.manifest.stations, coffee: { brew: ['InCorner'] } });
  pk.map.layers.find((l) => l.name === 'Stations').objects.pop();
  assert.deepEqual(corner.brew, []);
  assert.ok(corner.diagnostics.some((d) => /"InCorner" is not on open floor/.test(d.message)));
  assert.ok(walled.stations.every((s) => s.name !== 'Gamma')); // a brew point is excluded from the stations
});

for (const n of [1, 5]) test(`coffee probe: ${n} idle agent(s) for 30 minutes, three seeds: the cooldown holds and every run finishes`, () => {
  const pk = pack(), S = pk.scene;
  for (const seed of [1, 2, 3]) {
    const crew = crewOf(seed, { coffeeGap: [180000, 300000] });
    crew.sync(Array.from({ length: n }, (_, i) => ({ id: 'a' + i, status: 'idle' })));
    const starts = new Map(), was = new Map(), chats = [];
    let solid = 0, fetched = 0, parked = 0, gaveUp = 0;
    const ev = crew.event.bind(crew);
    crew.event = (kind, id, other) => { ev(kind, id, other); if (kind === 'gaveUp') gaveUp++; if (kind === 'chat') chats.push(crew.events.at(-1)); };
    run(crew, 30 * 60000, () => {
      for (const p of crew.walkers()) {
        const w = was.get(p.id) || {};
        if (p.coffee && !w.coffee) {
          assert.ok(!(w.full > crew.t), `${p.id} went for coffee with a full mug parked`);
          (starts.get(p.id) || starts.set(p.id, []).get(p.id)).push(crew.t);
        }
        if (p.coffee && p.coffee.phase === 'fetch' && w.phase !== 'fetch') fetched++;
        if (p.mug && w.mug !== p.mug) parked++;
        const last = chats.at(-1);
        if (last && last.at === crew.t && last.id === p.id) {
          const q = crew.get(last.with), dx = q.x - p.x, dy = q.y - p.y;
          assert.equal(p.dir, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'), 'a chat faces the other');
        }
        if (!p.seated && N.footHits(S, p.x, p.y, crew.walkZones(p))) solid++;
        was.set(p.id, { coffee: !!p.coffee, phase: p.coffee && p.coffee.phase, mug: p.mug, full: p.mug ? p.mug.full : 0 });
      }
    });
    assert.equal(starts.size, n, `seed ${seed}: everyone has coffee`);
    for (const [id, ts] of starts) {
      assert.ok(ts.length >= 5 && ts.length <= 10, `seed ${seed} ${id}: ${ts.length} runs in 30 min (expected about 7.5)`);
      for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 180000, `seed ${seed} ${id}: runs ${Math.round((ts[i] - ts[i - 1]) / 1000)} s apart`);
    }
    assert.equal(solid, 0);
    assert.equal(gaveUp, 0, `seed ${seed}: a run gave up`);
    assert.ok(parked >= 3, `seed ${seed}: mugs parked ${parked}`);
    assert.ok(fetched >= 2, `seed ${seed}: parked mugs fetched for a refill ${fetched}`);
    if (n === 5) assert.ok(chats.length > 0, `seed ${seed}: idle neighbours never chatted`);
  }
});

test('coffee: a lone agent goes from the entrance to the brew spot, then home to sit, park the mug and sip', () => {
  const pk = pack(), S = pk.scene, crew = crewOf(4);
  crew.sync([{ id: 'a', status: 'idle' }]);
  const p = crew.get('a');
  let brewedAt = null;
  for (let i = 0; i < 2400 && !(p.seated && p.homeSit); i++) { crew.tick(50); if (p.coffee && p.coffee.phase === 'brewing' && !brewedAt) brewedAt = [p.x, p.y]; }
  assert.ok(brewedAt, 'reached the brew spot');
  assert.ok(Math.hypot(brewedAt[0] - S.brew[0][0], brewedAt[1] - S.brew[0][1]) < 1, `brewed at ${brewedAt}`);
  assert.equal(p.seat.name, 'Beta');
  assert.ok(p.seated && p.homeSit && p.sip > crew.t, 'sits at home and sips');
  assert.equal(p.cup, false);
  assert.equal(p.mug.seat.name, 'Beta');
  assert.ok(p.mug.full > crew.t, 'the parked mug is full');
  assert.ok(p.coffeeNext >= crew.t + 180000 - 60000, 'the next run waits the cooldown');
  for (let i = 0; i < 400 && p.sip; i++) crew.tick(50);
  assert.equal(p.sip, 0);
  assert.equal(p.mug.full, 0, 'the sip drinks the parked mug');
});

test('coffee: a full parked mug blocks the next run until it is drunk', () => {
  const crew = crewOf(6);
  crew.sync([{ id: 'a', status: 'idle' }]);
  const p = crew.get('a');
  run(crew, 2000);
  p.mug = { seat: p.seat, full: crew.t + 1e9 };
  p.coffeeNext = 0;
  run(crew, 120000, () => assert.equal(p.coffee, null, 'went for coffee with a full mug'));
  p.mug.full = 0;
  let went = false;
  run(crew, 60000, () => { went = went || !!p.coffee; });
  assert.ok(went, 'an empty mug lets them go');
});

test('coffee: the per-agent cooldown comes from the pack (or the default) and counts from the start of a run', () => {
  const crew = crewOf(8, { coffeeGap: [40000, 40000] });
  crew.sync([{ id: 'a', status: 'idle' }]);
  const p = crew.get('a'), starts = [];
  let had = false;
  run(crew, 10 * 60000, () => { if (p.coffee && !had) starts.push(crew.t); had = !!p.coffee; });
  assert.ok(starts.length >= 6, `${starts.length} runs in 10 min with a 40 s cooldown`);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 40000);
  assert.deepEqual(Cr.COFFEE_GAP, [180000, 300000]);
});

test('coffee: a walk that never ends gives up after 20 s, and a mug in hand still goes home', () => {
  const crew = crewOf(9);
  crew.sync([{ id: 'a', status: 'idle' }]);
  const p = crew.get('a');
  for (let i = 0; i < 2000 && !(p.coffee && p.coffee.phase === 'walking'); i++) crew.tick(50);
  assert.ok(p.coffee, 'a run started');
  p.cup = true; // carrying the mug (a refill)
  const start = crew.t;
  p.path = Array.from({ length: 2000 }, (_, i) => [p.x + (i % 2) * 2, p.y]); // wanders on the spot for 100 s
  for (let i = 0; i < 1000 && p.coffee; i++) crew.tick(50);
  assert.equal(p.coffee, null);
  assert.ok(crew.t - start > 20000 && crew.t - start < 21000, `gave up after ${crew.t - start} ms`);
  assert.equal(crew.events.at(-1).kind, 'gaveUp');
  assert.ok(p.homeSit && p.cup, 'the mug goes home');
});

test('coffee: back to work mid-run sits at the station and parks the mug; an idle sitter gives a moved seat up', () => {
  const crew = crewOf(10);
  crew.sync([{ id: 'a', status: 'idle' }]);
  const p = crew.get('a');
  for (let i = 0; i < 4000 && !(p.coffee && p.coffee.phase === 'walking'); i++) crew.tick(50);
  p.cup = true; // on the way for a refill
  crew.sync([{ id: 'a', status: 'working' }]);
  assert.equal(p.coffee, null);
  for (let i = 0; i < 1000 && !p.seated; i++) crew.tick(50);
  assert.ok(p.seated && !p.homeSit);
  assert.equal(p.mug && p.mug.seat.name, 'Beta');
  // idle again, home with a coffee at Beta; a pilot arrives and takes Beta (their preset's seat)
  crew.sync([{ id: 'a', status: 'idle' }]);
  p.coffeeNext = 0; p.mug = null;
  for (let i = 0; i < 4000 && !(p.seated && p.homeSit); i++) crew.tick(50);
  assert.ok(p.seated && p.homeSit && p.seat.name === 'Beta');
  crew.sync([{ id: 'a', status: 'idle' }, { id: 'pl', status: 'working', presetId: 'pilot' }]);
  assert.equal(crew.get('pl').seat.name, 'Beta');
  assert.ok(!p.seated && !p.homeSit && p.seat.name !== 'Beta', 'the idle sitter gave the seat up');
  assert.equal(p.mug.seat.name, 'Beta'); // the mug stays where it was parked
});

test('crew clock: a negative or huge frame time never flings anyone', () => {
  const crew = crewOf(11);
  crew.sync([{ id: 'a', status: 'working' }]);
  run(crew, 1000);
  const p = crew.get('a'), x = p.x, y = p.y, t = crew.t;
  crew.tick(-1e6);
  assert.deepEqual([p.x, p.y, crew.t], [x, y, t]);
  crew.tick(1e6);
  assert.ok(Math.hypot(p.x - x, p.y - y) <= 80 * Cr.WALK_SPEED + 1e-9);
  assert.equal(crew.t, t + 80);
});

test('coffee inline points: brewAt and mugs serve a map without coffee points; with both, inline mugs win per station', () => {
  const pk = pack(), an = (coffee) => N.analyseStationMap(pk.map, pk.store, { stations: pk.manifest.stations, navigation: pk.manifest.navigation, coffee });
  // inline only (the map's Coffee point and Mugs layer are not named)
  const inl = an({ brewAt: [[100, 100], [96, 2]], mugs: { alpha: [10, 12], Nope: [1, 1] } });
  assert.deepEqual(inl.brew, [[100, 100]]);
  assert.ok(inl.diagnostics.some((d) => d.level === 'warn' && /coffee spot \(96, 2\) is not on open floor/.test(d.message)));
  assert.deepEqual([...inl.mugSpots].map(([s, p]) => [s.name, ...p]), [['Alpha', 10, 12]]);
  assert.ok(inl.diagnostics.some((d) => d.level === 'info' && /"Nope" names no station/.test(d.message)));
  // layer only, as in the fixture
  assert.deepEqual([...pk.scene.mugSpots].map(([s]) => s.name), ['Alpha', 'Beta', 'Gamma']);
  // both: named points first, then inline; the layer's mugs, overridden by inline ones for the stations they name
  const both = an({ brew: ['Coffee'], brewAt: [[150, 90]], mugLayer: 'Mugs', mugs: { Beta: [1, 2] } });
  assert.deepEqual(both.brew, [[168, 80], [150, 90]]);
  assert.deepEqual([...both.mugSpots].map(([s, p]) => [s.name, ...p]), [['Alpha', 44, 52], ['Beta', 1, 2], ['Gamma', 52, 146]]);
  // no usable brew spot: a diagnostic, and idle people only wander
  const none = an({ brewAt: [[-40, -40]] });
  assert.deepEqual(none.brew, []);
  assert.ok(none.diagnostics.some((d) => /No usable coffee point/.test(d.message)));
  const crew = new Cr.Crew(none, SA.seatRulesFrom(pk.manifest, none.seatOrder.map((s) => s.name)), rng(12));
  crew.sync([{ id: 'a', status: 'idle' }]);
  run(crew, 120000, () => assert.equal(crew.get('a').coffee, null));
  // inline only runs coffee at the inline spot
  const crew2 = new Cr.Crew(inl, SA.seatRulesFrom(pk.manifest, inl.seatOrder.map((s) => s.name)), rng(13));
  crew2.sync([{ id: 'a', status: 'idle' }]);
  let spot = null;
  run(crew2, 120000, () => { const c = crew2.get('a').coffee; if (c && !spot) spot = c.spot; });
  assert.deepEqual(spot, [100, 100]);
});

test('coffee inline manifest: brewAt or brew is needed; bad points or mug entries drop the section with a warning', () => {
  const base = JSON.parse(require('node:fs').readFileSync(require('node:path').join(H.NEUTRAL, 'theme.json'), 'utf8'));
  const check = (coffee) => Mf.validateManifest({ ...base, coffee });
  assert.deepEqual(check({ brewAt: [[462, 366], [478, 366]], mugs: { Alpha: [474, 176] }, cooldown: [180, 300] }).manifest.coffee,
    { brewAt: [[462, 366], [478, 366]], mugs: { Alpha: [474, 176] }, cooldown: [180, 300] });
  for (const bad of [{ mugLayer: 'Mugs' }, { brewAt: [] }, { brewAt: [[1]] }, { brewAt: [[1, 'a']] }, { brewAt: [[1, Infinity]] }, { brewAt: [[1, 2]], mugs: { Alpha: [1] } }, { brewAt: [[1, 2]], mugs: [[1, 2]] }]) {
    const r = check(bad);
    assert.equal(r.manifest.coffee, undefined, JSON.stringify(bad));
    assert.ok(r.diagnostics.some((d) => d.level === 'warn' && /coffee/.test(d.message)), JSON.stringify(bad));
  }
});

const crewOn = (S, rand, opts) => new Cr.Crew(S, SA.seatRulesFrom(pack().manifest, S.seatOrder.map((s) => s.name)), rand, opts);
const stall = (p) => Array.from({ length: 2000 }, (_, i) => [p.x + (i % 2) * 2, p.y]); // walks on the spot for 100 s

test('coffee spots: an off-floor point snaps to the nearest open cell; one landing in a seat zone or on a station is dropped', () => {
  const pk = pack(), stL = pk.map.layers.find((l) => l.name === 'Stations');
  stL.objects.push({ ...stL.objects[0], name: 'AtBeta', x: 124, y: 60 }); // a named point on Beta's square
  const a = N.analyseStationMap(pk.map, pk.store, { stations: pk.manifest.stations, navigation: pk.manifest.navigation, coffee: { brew: ['AtBeta'], brewAt: [[44, 66], [125, 60], [42, 140], [168, 100]] } });
  stL.objects.pop();
  assert.deepEqual(a.brew, [[46, 70]]); // (44, 66) is off the floor: the centre of the nearest open cell
  for (const [what, st] of [['point "AtBeta"', 'Beta'], ['spot (125, 60)', 'Beta'], ['spot (42, 140)', 'Gamma'], ['spot (168, 100)', 'Coffee']])
    assert.ok(a.diagnostics.some((d) => d.level === 'warn' && d.message.includes(`coffee ${what} is inside the seat zone of "${st}"`)), what);
});

test('coffee: a mug parked by a back-to-work sit is full for 60 s, then lets them go again', () => {
  const crew = crewOf(10);
  crew.sync([{ id: 'a', status: 'idle' }]);
  const p = crew.get('a');
  for (let i = 0; i < 4000 && !(p.coffee && p.coffee.phase === 'walking'); i++) crew.tick(50);
  p.cup = true; p.fresh = true; // a finished brew in hand (an empty refill mug parks empty: tes-idle-means-idle-187)
  crew.sync([{ id: 'a', status: 'working' }]);
  for (let i = 0; i < 1000 && !p.seated; i++) crew.tick(50);
  assert.equal(p.mug.full, crew.t + 60000, 'parked full, for 60 s');
  const parked = crew.t;
  crew.sync([{ id: 'a', status: 'idle' }]);
  p.coffeeNext = 0;
  let went = 0;
  run(crew, 120000, () => { if (p.coffee && !went) went = crew.t; });
  assert.ok(went >= parked + 60000, `went ${went - parked} ms after parking`);
});

test('coffee: a busy brew spot is never shared; a second spot serves a second agent at once', () => {
  const S = pack().scene;
  for (const brew of [[S.brew[0]], [S.brew[0], [100, 100]]]) {
    const crew = crewOn({ ...S, brew }, rng(21));
    crew.sync([{ id: 'a', status: 'idle' }, { id: 'b', status: 'idle' }]);
    let both = false;
    run(crew, 120000, () => {
      crew.cool = 0; // the picker runs every frame
      const spots = crew.walkers().filter((p) => p.coffee).map((p) => p.coffee.spot);
      assert.equal(new Set(spots).size, spots.length, 'two runs at one spot');
      both = both || spots.length === 2;
    });
    assert.equal(both, brew.length === 2, `${brew.length} spot(s)`);
  }
});

test('coffee: fetching a parked mug has the 20 s watchdog too, and a mug out of reach is never picked up', () => {
  const crew = crewOf(14);
  crew.sync([{ id: 'a', status: 'idle' }]);
  const p = crew.get('a'), gamma = crew.SM.stations.find((s) => s.name === 'Gamma');
  const kinds = [];
  const ev = crew.event.bind(crew);
  crew.event = (kind, id, other) => { ev(kind, id, other); kinds.push(kind); };
  const toFetch = () => { // from the brew spot, far from the mug parked at Gamma
    Object.assign(p, { mug: { seat: gamma, full: 0 }, coffee: null, path: [], wait: 0, seated: false, homeSit: false, cup: false });
    [p.x, p.y] = crew.SM.brew[0];
    assert.ok(crew.startCoffee(p, crew.SM.brew[0]));
    assert.equal(p.coffee.phase, 'fetch');
  };
  toFetch();
  const start = crew.t;
  p.path = stall(p);
  for (let i = 0; i < 1000 && p.coffee; i++) crew.tick(50);
  assert.ok(crew.t - start > 20000 && crew.t - start < 21000, `gave up after ${crew.t - start} ms`);
  assert.equal(kinds.at(-1), 'gaveUp');
  assert.ok(p.mug && p.mug.seat === gamma && !p.cup, 'the mug stays parked');
  // the fetch walk ends far from the mug (it could not get closer): no pickup, no coffee
  toFetch();
  p.path = []; [p.x, p.y] = crew.SM.brew[0];
  crew.tick(50);
  assert.equal(p.coffee, null);
  assert.equal(kinds.at(-1), 'gaveUp');
  assert.ok(p.mug && p.mug.seat === gamma && !p.cup, 'a mug out of reach is not picked up');
});

test('chat: an idle neighbour within 40 px who is not seated; both stay quiet for 3 s after', () => {
  const crew = crewOf(15);
  crew.sync([{ id: 'a', status: 'idle' }, { id: 'b', status: 'idle' }]);
  run(crew, 3000);
  const p = crew.get('a'), q = crew.get('b');
  let chats = 0;
  const ev = crew.event.bind(crew);
  crew.event = (kind, id, other) => { ev(kind, id, other); if (kind === 'chat') chats++; };
  crew.rand = () => 0;
  const place = (dx) => {
    for (const w of [p, q]) { w.path = []; w.coffee = null; w.wait = 0; w.seated = false; w.talk = 0; w.idle = 0; }
    [p.x, p.y, q.x, q.y] = [100, 100, 100 + dx, 100];
  };
  place(40); crew.atStop(p); assert.equal(chats, 0, 'too far');
  place(39); q.seated = true; crew.atStop(p); assert.equal(chats, 0, 'the partner is seated');
  place(39); crew.atStop(p); assert.equal(chats, 1);
  assert.deepEqual([p.dir, q.dir, p.talk, q.talk], ['right', 'left', crew.t + 3000, crew.t + 3000]);
  assert.ok(p.idle >= 3000 && q.idle >= 3000);
  crew.atStop(p); crew.atStop(q); assert.equal(chats, 1, 'quiet for 3 s');
  q.talk = 0; crew.atStop(p); assert.equal(chats, 1, 'the speaker is still quiet');
  p.talk = 0; q.talk = crew.t + 1; crew.atStop(p); assert.equal(chats, 1, 'the partner is still quiet');
  q.talk = crew.t; crew.atStop(p); assert.equal(chats, 2, 'then they talk again');
});

test('coffee picker: it looks every 6-12 s', () => {
  const crew = crewOf(16);
  crew.sync([{ id: 'a', status: 'idle' }]);
  const looks = [];
  let last = crew.cool;
  run(crew, 10 * 60000, () => { if (crew.cool > last) looks.push(crew.cool); last = crew.cool; });
  assert.ok(looks.length >= 50 && looks.length <= 100, `${looks.length} looks in 10 min`);
  for (const c of looks) assert.ok(c >= 6000 && c <= 12000, `next look in ${c} ms`);
});

test('coffee: nobody starts a run while walking home with a cup, even with a short pack cooldown', () => {
  const crew = crewOf(17, { coffeeGap: [10000, 10000] });
  crew.sync([{ id: 'a', status: 'idle' }]);
  const p = crew.get('a');
  run(crew, 2000);
  Object.assign(p, { homeSit: true, seated: false, coffee: null, coffeeNext: 0, mug: null, cup: true, wait: 0 });
  p.path = stall(p);
  for (let i = 0; i < 400; i++) { crew.cool = 0; crew.tick(50); assert.equal(p.coffee, null, 'started a run on the way home'); }
  Object.assign(p, { homeSit: false, cup: false });
  let went = false;
  for (let i = 0; i < 400 && !went; i++) { crew.cool = 0; crew.tick(50); went = !!p.coffee; }
  assert.ok(went, 'free again, they go');
});

test('coffee timing: the brew takes 2.6 s; with no station to go home to, they sip 8-16 s at the spot', () => {
  const crew = crewOf(31);
  crew.sync([{ id: 'a', status: 'idle' }]);
  const p = crew.get('a');
  for (let i = 0; i < 4000 && !(p.coffee && p.coffee.phase === 'brewing'); i++) crew.tick(50);
  const brewed = crew.t;
  p.seat = null; // nowhere to sit: the viewer's sip-at-the-spot branch
  for (let i = 0; i < 200 && !p.cup; i++) crew.tick(50);
  assert.ok(p.cup && crew.t - brewed > 2600 && crew.t - brewed <= 2650, `brewed in ${crew.t - brewed} ms`);
  assert.equal(p.coffee.phase, 'sipping');
  const until = p.coffee.until, sipFrom = crew.t;
  assert.ok(until >= 8000 && until <= 16000, `sips for ${until} ms`);
  for (let i = 0; i < 400 && p.coffee.phase === 'sipping'; i++) crew.tick(50);
  assert.equal(p.coffee.phase, 'back');
  assert.ok(crew.t - sipFrom > until && crew.t - sipFrom <= until + 50, `sipped ${crew.t - sipFrom} ms`);
});

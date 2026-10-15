'use strict';

// TES-FLOOR-COLLISION-188: sitters never walk through any chair, their own included. Chairs are solid for every
// walk; a seat is reached by plain floor to its approach spot (outside the chair, on the manifest's side), then a
// short seat step in, drawn seated and depth-sorted with the chair. Getting up is the reverse step, then plain
// floor. The step is the only time feet are in a chair. No sitting by proximity. A chair is its solid footprint
// (what blocks feet; Jim's probe counts the same): the sprite's upper half is backrest art that people pass behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const ROOT = path.join(__dirname, '..', 'themes', 'tes');
const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
const P = loadTs('src/renderer/src/scene/themes/packs.ts');
const N = loadTs('src/renderer/src/scene/themes/stationMap.ts');
const C = loadTs('src/renderer/src/scene/themes/compositor.ts');
const Cr = loadTs('src/renderer/src/scene/themes/crew.ts');
const SA = loadTs('src/renderer/src/scene/themes/seatAllocator.ts');

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
const SIDE = { Captain: 'front', Speck1: 'back', Speck2: 'back', Chair1: 'back', Chair2: 'back', Chair3: 'back', Chair4: 'back', Chair5: 'back', Chair6: 'back' };
const segDist = ([px, py], [ax, ay], [bx, by]) => {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};

/** The chair stations whose chair solid lies under the foot box at (x, y). */
function chairsUnder(S, x, y) {
  const byId = new Map([...S.seatChair].map(([s, id]) => [id, s]));
  const [x0, y0, x1, y1] = N.footBox(x, y), out = new Set();
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const s = byId.get(S.solid[yy * S.PW + xx]); if (s) out.add(s); }
  return [...out];
}
/** Every 0.5 px foot sample of a -> b (rounded as segClear rounds) is off every chair. */
function legOffChairs(S, a, b) {
  const n = Math.ceil(2 * Math.hypot(b[0] - a[0], b[1] - a[1]));
  for (let t = 0; t <= n; t++) {
    const x = Math.round(a[0] + (b[0] - a[0]) * t / (n || 1)), y = Math.round(a[1] + (b[1] - a[1]) * t / (n || 1));
    const on = chairsUnder(S, x, y);
    if (on.length) return `(${x},${y}) on ${on.map((s) => s.name).join('+')}'s chair`;
  }
  return null;
}
/** Feet in a chair are legal only seated in it or mid seat step of that (its own) seat, on the step's line. */
function illegal(S, p) {
  for (const cs of chairsUnder(S, p.x, p.y)) {
    const a = S.approach.get(cs);
    const ok = p.chair === cs && (p.seated || !!p.step) && a && segDist([p.x, p.y], a, [cs.x, cs.y]) <= 1.5;
    if (!ok) return `${p.id} (seat ${p.seat && p.seat.name}, seated ${p.seated}, step ${!!p.step}) in ${cs.name}'s chair at (${p.x.toFixed(1)},${p.y.toFixed(1)})`;
  }
  return null;
}
const crewOf = (pk, rand) => new Cr.Crew(pk.scene, SA.seatRulesFrom(pk.manifest, pk.scene.seatOrder.map((s) => s.name)), rand);
const allSeated = (pk) => {
  const crew = crewOf(pk, rng(5)), S = pk.scene;
  crew.sync(S.seatOrder.map((s, i) => ({ id: i ? `a${i}` : 'god', status: 'working', orchestrator: !i })));
  for (let i = 0; i < 4000 && !crew.walkers().every((p) => p.seated); i++) crew.tick(30);
  assert.ok(crew.walkers().every((p) => p.seated), 'everyone sat down');
  return crew;
};

test('T1 every seat: the approach spot is outside every chair, on the manifest side; the way in crosses no chair', () => {
  const pk = pack(), S = pk.scene;
  assert.equal(pk.manifest.stations.seats.Captain.approach, 'front', 'the manifest names the Captain\'s front');
  assert.deepEqual(pk.diagnostics, [], 'every manifest approach side is honoured');
  for (const st of S.stations) {
    const a = S.approach.get(st);
    assert.ok(a, `${st.name} has an approach spot`);
    const [vx, vy] = N.sideVector(st.facing, SIDE[st.name]);
    assert.ok((a[0] - st.x) * vx + (a[1] - st.y) * vy > 0, `${st.name} is entered from its ${SIDE[st.name]} (${a})`);
    assert.equal(N.footHits(S, a[0], a[1]), 0, `${st.name}: the approach spot's foot box is clear of every solid`);
    assert.deepEqual(chairsUnder(S, a[0], a[1]), [], `${st.name}: approach ${a} is off every chair`);
    const r = N.seatRoute(S, S.entrance[0], S.entrance[1], st);
    assert.ok(r && r.length >= 2, `${st.name} is reachable`);
    assert.deepEqual(r[r.length - 2], a);
    assert.deepEqual(r[r.length - 1], [st.x, st.y]);
    let cur = S.entrance;
    for (const q of r.slice(0, -1)) { assert.equal(legOffChairs(S, cur, q), null, `${st.name}: ${cur} -> ${q}`); assert.ok(N.segClear(S, cur, q)); cur = q; }
  }
});

test('T2 getting up: a step out to the own approach spot, then plain floor clear of every chair', () => {
  const pk = pack(), S = pk.scene;
  const targets = (p) => [...S.brew, N.wanderTarget(S, rng(11)), ...S.stations.filter((s) => s !== p.seat).map((s) => S.approach.get(s))];
  const n = S.seatOrder.length;
  for (let k = 0; k < n; k++) for (const tg of targets(allSeated(pk).walkers()[k])) {
    const crew = allSeated(pk), p = crew.walkers()[k], seat = p.seat, a = S.approach.get(seat);
    assert.ok(crew.goTo(p, tg[0], tg[1], true), `${p.id} can leave ${seat.name} for ${tg}`);
    assert.ok(p.step && p.step.to[0] === a[0] && p.step.to[1] === a[1] && !p.step.sit, `${p.id} first steps out of ${seat.name} to its approach spot`);
    let cur = a;
    for (const q of p.path) { assert.equal(legOffChairs(S, cur, q), null, `${p.id} from ${seat.name}: ${cur} -> ${q}`); cur = q; }
    for (let i = 0; i < 2000 && (p.step || p.path.length); i++) { crew.tick(30); for (const w of crew.walkers()) assert.equal(illegal(S, w), null); }
  }
});

test('T2b a seated agent the allocator moves (Sele\'s preset claims Speck1) steps out of its old chair first', () => {
  const pk = pack(), S = pk.scene, crew = crewOf(pk, rng(6));
  const roster = ['god', 'a1', 'a2'].map((id) => ({ id, status: 'working', orchestrator: id === 'god' }));
  crew.sync(roster);
  for (let i = 0; i < 4000 && !crew.walkers().every((p) => p.seated); i++) crew.tick(30);
  const a1 = crew.get('a1'), old = a1.seat;
  assert.ok(a1.seated && old.name === 'Speck1', `a1 sits at ${old && old.name}`);
  crew.sync([...roster, { id: 'sele', status: 'working', presetId: 'sele' }]);
  assert.notEqual(a1.seat, old, `the allocator moves a1 off Speck1 (to ${a1.seat && a1.seat.name})`);
  assert.equal(illegal(S, a1), null, 'right after the move: stepping out, not standing in the old chair');
  assert.deepEqual(a1.step && a1.step.to, S.approach.get(old), 'the step out goes to the old seat\'s approach spot');
  for (let i = 0; i < 4000 && !a1.seated; i++) { crew.tick(30); for (const w of crew.walkers()) assert.equal(illegal(S, w), null); }
  assert.ok(a1.seated && a1.seat !== old, `a1 sits in its new chair (${a1.seat.name})`);
});

test('T3 sim: every walker, every tick, every chair: feet in a chair only seated in it or stepping into or out of its own seat', () => {
  const pk = pack(), S = pk.scene, STAT = ['working', 'idle', 'thinking', 'waiting'];
  const bad = new Map();
  let steps = 0;
  for (const roster of [1, 3, 5, 9]) for (const seed of [1, 2, 3]) {
    const rand = rng(seed * 7919 + roster), crew = crewOf(pk, rand);
    let ids = Array.from({ length: roster }, (_, i) => (i ? `a${i}` : 'god')), next = roster;
    const st = {};
    for (let t = 0, sync = 0; t < 4 * 60000;) {
      if (t >= sync) {
        if (roster > 1 && rand() < 0.4) ids = ids.filter((id) => id === 'god' || rand() > 0.3); // leaves
        while (ids.length < roster && rand() < 0.7) ids.push(`a${next++}`); // joins
        for (const id of ids) st[id] = STAT[Math.floor(rand() * STAT.length)];
        crew.sync(ids.map((id) => ({ id, status: st[id], orchestrator: id === 'god' })));
        sync = t + 3000 + rand() * 12000;
        for (const p of crew.walkers()) { // standing up or moved seats: out of the chair by the step at once
          const e = illegal(S, p);
          if (e) { const k = `sync ${e.replace(/ at .*/, '')}`; if (!bad.has(k)) bad.set(k, `after sync: ${e} (roster ${roster}, seed ${seed}, t ${t})`); }
        }
      }
      const dt = rand() < 0.02 ? 250 : 16 + Math.floor(rand() * 25);
      crew.tick(dt); t += dt;
      for (const p of crew.walkers()) {
        if (p.step) steps++;
        const e = illegal(S, p);
        if (e) { const k = e.replace(/ at .*/, ''); if (!bad.has(k)) bad.set(k, `${e} (roster ${roster}, seed ${seed}, t ${t})`); }
      }
    }
  }
  assert.deepEqual([...bad.values()].slice(0, 12), [], 'walkers in chairs off the seat step');
  assert.ok(steps > 0, 'seat steps happened');
});

test('T4 no proximity sit: behind the Captain\'s chair or at Chair6\'s front, a walker goes round by plain floor and steps in', () => {
  const pk = pack(), S = pk.scene;
  for (const [name, at] of [['Captain', [464, 169]], ['Chair6', [569, 258]]]) {
    const crew = crewOf(pk, rng(3));
    crew.sync(S.seatOrder.map((s, i) => ({ id: i ? `a${i}` : 'god', status: 'idle', orchestrator: !i })));
    const p = crew.walkers().find((w) => w.seat && w.seat.name === name), seat = p.seat, a = S.approach.get(seat);
    assert.ok(p, `someone holds ${name}`);
    Object.assign(p, { x: at[0], y: at[1], path: [], seated: false, tried: true, step: null, chair: null, status: 'working' });
    assert.equal(chairsUnder(S, p.x, p.y).length, 0, `${at} is off every chair`);
    assert.ok(crew.goSeat(p), `${name}: a way in`);
    assert.ok(!(p.path.length === 1 && p.path[0][0] === seat.x && p.path[0][1] === seat.y), `${name}: never path [[seat]] from ${at}`);
    assert.deepEqual(p.path[p.path.length - 1], a, `${name}: the walk ends at the approach spot`);
    let cur = at;
    for (const q of p.path) { assert.equal(legOffChairs(S, cur, q), null, `${name}: ${cur} -> ${q}`); cur = q; }
    let stepped = false;
    for (let i = 0; i < 3000 && !p.seated; i++) {
      crew.tick(30);
      if (p.step) { stepped = true; assert.deepEqual(p.step.from, a, `${name}: the step in starts at the approach spot`); }
      assert.equal(illegal(S, p), null);
    }
    assert.ok(p.seated && stepped, `${name}: seated by the step`);
  }
  // a walker whose route ran out next to its seat (not on the approach spot) never steps in from there
  const crew = crewOf(pk, rng(4));
  crew.sync(S.seatOrder.map((s, i) => ({ id: i ? `a${i}` : 'god', status: 'idle', orchestrator: !i })));
  const p = crew.walkers().find((w) => w.seat && w.seat.name === 'Chair6'), a = S.approach.get(p.seat);
  Object.assign(p, { x: 569, y: 258, path: [], seated: false, tried: true, step: null, chair: null, status: 'working', wait: 0, idle: 0 });
  for (let i = 0; i < 3000 && !p.seated; i++) {
    crew.tick(30);
    if (p.step) assert.deepEqual(p.step.from, a, 'Chair6: steps in only from its approach spot, never from (569,258)');
    assert.equal(illegal(S, p), null);
  }
  assert.ok(p.seated, 'Chair6: sat down in the end');
});

test('T5 depth: stepping and seated, the walker sorts with its own chair, on every seat', () => {
  const pk = pack(), S = pk.scene, plan = C.buildScenePlan({ ...S, store: pk.store });
  const crew = crewOf(pk, rng(9));
  crew.sync(S.seatOrder.map((s, i) => ({ id: i ? `a${i}` : 'god', status: 'working', orchestrator: !i })));
  const seen = new Map();
  for (let i = 0; i < 4000 && !crew.walkers().every((p) => p.seated); i++) {
    crew.tick(30);
    for (const p of crew.walkers()) {
      const inStep = !!p.step, onChair = chairsUnder(S, p.x, p.y).length > 0;
      if (!inStep && !p.seated && !onChair) continue;
      const d = Cr.sitDraw(p);
      assert.ok(d && d.seat === p.seat, `${p.id} (${p.seat.name}) draws with its own seat while stepping or seated`);
      const ch = C.chairOf(d.seat, plan.sorted);
      assert.ok(ch, `${p.seat.name} has a chair in the plan`);
      const key = C.personKey(p.y, ch, C.seatPose(ch, p.seat.facing, 32, 32, null));
      assert.equal(key.foot, ch.foot, `${p.id} sorts on ${p.seat.name}'s chair, not its foot line ${p.y}`);
      if (inStep) seen.set(p.seat.name, true);
    }
  }
  assert.deepEqual([...seen.keys()].sort(), S.stations.map((s) => s.name).sort(), 'every seat was stepped into');
});

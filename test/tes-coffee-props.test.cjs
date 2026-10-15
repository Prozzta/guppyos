'use strict';

// COFFEE-NEVER-186: on the TES floor nobody seemed to go for coffee. The crew model (crew.ts) ran
// coffee all along, but StationFloor drew only the people, so a run looked like a wander stop.
// coffeeProps.ts is the bridge viewer's draw half as data: a mug in the hand, a mug parked at a
// station, and the viewer's lines while brewing and when the sip starts.
//
// 1. coffeeProps on hand-made crews: each prop, and nothing for an agent at work.
// 2. A seeded sim on the REAL TES pack (the app's crew code and pack data): idle agents reach
//    coffee within minutes, no one loops, a mostly-busy floor still gets coffee, agents at work
//    never do, and every run shows (a brew line, then a cup in hand, then a parked mug).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
const P = loadTs('src/renderer/src/scene/themes/packs.ts');
const Cr = loadTs('src/renderer/src/scene/themes/crew.ts');
const SA = loadTs('src/renderer/src/scene/themes/seatAllocator.ts');
const C = loadTs('src/renderer/src/scene/themes/coffeeProps.ts');

// ── 1. coffeeProps on hand-made crews ────────────────────────────────────────

const seatA = { name: 'A', x: 10, y: 20 };
const walker = (o) => ({ id: 'a', x: 50, y: 60, dir: 'down', seated: false, cup: false, mug: null, coffee: null, homeSit: false, sip: 0, status: 'idle', ...o });
const fake = (people, { t = 1000, events = [] } = {}) => ({
  t, events, walkers: () => people, mugAt: (m) => [m.seat.x + 1, m.seat.y + 2],
});

test('a cup in the hand while one is carried; none once seated (the mug is parked then)', () => {
  assert.deepEqual(C.coffeeProps(fake([walker({ cup: true, dir: 'left' })])), [{ kind: 'cup', id: 'a', x: 50, y: 60, dir: 'left' }]);
  assert.deepEqual(C.coffeeProps(fake([walker({ cup: true, seated: true })])), []);
});

test('a parked mug at the pack\'s mug point, steaming until it is drunk', () => {
  const mug = { seat: seatA, full: 5000 };
  assert.deepEqual(C.coffeeProps(fake([walker({ mug })], { t: 4999 })), [{ kind: 'mug', owner: 'a', x: 11, y: 22, full: true }]);
  assert.deepEqual(C.coffeeProps(fake([walker({ mug })], { t: 5000 })), [{ kind: 'mug', owner: 'a', x: 11, y: 22, full: false }]);
});

test('brewing says the viewer\'s line: a fresh one, or a refill when they brought their own mug', () => {
  const brewing = { spot: [1, 1], phase: 'brewing', t: 0, until: 0 };
  assert.deepEqual(C.coffeeProps(fake([walker({ coffee: brewing })])), [{ kind: 'say', id: 'a', text: 'brewing a fresh one ☕' }]);
  assert.deepEqual(C.coffeeProps(fake([walker({ coffee: brewing, cup: true })])),
    [{ kind: 'cup', id: 'a', x: 50, y: 60, dir: 'down' }, { kind: 'say', id: 'a', text: 'a quick refill ☕' }]);
  for (const phase of ['fetch', 'walking', 'back']) {
    assert.deepEqual(C.coffeeProps(fake([walker({ coffee: { spot: [1, 1], phase, t: 0, until: 0 } })])), [], phase);
  }
});

test('the sip line shows for 3 s from the sip, at home or standing; it is stable from frame to frame', () => {
  const ev = [{ kind: 'sip', id: 'a', at: 1000 }];
  const home = walker({ seated: true, homeSit: true, sip: 12000 });
  const said = C.coffeeProps(fake([home], { t: 1000, events: ev }));
  assert.equal(said.length, 1);
  assert.equal(said[0].kind, 'say');
  assert.ok(C.COFFEE_LINES.coffee.includes(said[0].text), said[0].text);
  assert.deepEqual(C.coffeeProps(fake([home], { t: 3999, events: ev })), said, 'the same line on a later frame');
  assert.deepEqual(C.coffeeProps(fake([home], { t: 4000, events: ev })), [], 'gone after SIP_LINE_MS');
  const standing = walker({ cup: true, coffee: { spot: [1, 1], phase: 'sipping', t: 0, until: 9000 } });
  assert.deepEqual(C.coffeeProps(fake([standing], { t: 2000, events: ev })).map((p) => p.kind), ['cup', 'say']);
  assert.deepEqual(C.coffeeProps(fake([walker({ seated: true })], { t: 1000, events: ev })), [], 'no sip under way: no line');
  assert.equal(C.SIP_LINE_MS, 3000);
});

test('an agent at work, or idle with no coffee, shows nothing', () => {
  assert.deepEqual(C.coffeeProps(fake([walker({ status: 'working', seated: true }), walker({ id: 'b' })])), []);
});

// ── 2. the seeded sim on the real TES pack ───────────────────────────────────

const ROOT = path.join(__dirname, '..', 'themes', 'tes');
let cached;
function tes() {
  if (cached) return cached;
  const r = P.readPack(P.memoryFiles(H.readPackDir(ROOT)));
  const f = P.finishPack(r.value, H.decodeImages(ROOT, T.normPath, r.value.images), r.diagnostics);
  assert.ok(f.value, JSON.stringify(f.diagnostics));
  return (cached = f.value);
}
const rng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
/** The crew exactly as StationFloor builds it (StationFloor.tsx: the pack's cooldown, in ms). */
function crewOf(seed) {
  const pk = tes(), S = pk.scene, cd = pk.manifest.coffee.cooldown;
  return new Cr.Crew(S, SA.seatRulesFrom(pk.manifest, S.seatOrder.map((s) => s.name)), rng(seed), { coffeeGap: [cd[0] * 1000, cd[1] * 1000] });
}
/** Run `ms` of crew time at 50 ms ticks; statuses(t) re-synced each second; props sampled each tick. */
function simulate(seed, ms, statuses) {
  const crew = crewOf(seed);
  crew.sync(statuses(0));
  const brews = new Map(), seen = { say: new Set(), cup: new Set(), mug: new Set() };
  const ev = crew.event.bind(crew);
  crew.event = (kind, id, o) => { ev(kind, id, o); if (kind === 'brew') (brews.get(id) || brews.set(id, []).get(id)).push(crew.t); };
  for (let t = 0; t < ms; t += 50) {
    if (t % 1000 === 0) crew.sync(statuses(t));
    crew.tick(50);
    for (const p of C.coffeeProps(crew)) seen[p.kind].add(p.kind === 'mug' ? p.owner : p.id);
  }
  return { crew, brews, seen };
}
const team = (n, status) => Array.from({ length: n }, (_, i) => ({ id: 'a' + i, status: typeof status === 'function' ? status(i) : status }));

test('the TES pack has coffee: two brew points and the 3-5 min cooldown', () => {
  const pk = tes();
  assert.deepEqual(pk.manifest.coffee.cooldown, [180, 300]);
  assert.equal(pk.scene.brew.length, 2);
});

for (const seed of [1, 2, 3]) test(`TES sim, seed ${seed}: 6 idle agents each reach coffee within 6 min, no loop, and every run shows`, () => {
  const { brews, seen } = simulate(seed, 6 * 60000, () => team(6, 'idle'));
  for (let i = 0; i < 6; i++) assert.ok((brews.get('a' + i) || []).length >= 1, `a${i} brewed: ${JSON.stringify([...brews])}`);
  for (const [id, at] of brews) {
    for (let k = 1; k < at.length; k++) assert.ok(at[k] - at[k - 1] >= 160000, `${id} brewed again after ${at[k] - at[k - 1]} ms (cooldown 180 s, a walk takes up to 20 s)`);
  }
  for (const id of brews.keys()) {
    assert.ok(seen.say.has(id), `${id}: a brew line`);
    assert.ok(seen.cup.has(id), `${id}: a cup in hand`);
    assert.ok(seen.mug.has(id), `${id}: a parked mug`);
  }
});

test('TES sim: a mostly-busy floor still gets coffee; agents at work never do and show nothing', () => {
  // a0-a3 are idle 30 s in every 5 min (staggered); a4 and a5 work the whole time.
  const statuses = (t) => team(6, (i) => (i >= 4 ? 'working' : ((t / 1000 + i * 75) % 300) < 30 ? 'idle' : 'working'));
  for (const seed of [1, 2, 3]) {
    const { brews, seen } = simulate(seed, 20 * 60000, statuses);
    const busyTotal = [...brews].filter(([id]) => id < 'a4').reduce((n, [, at]) => n + at.length, 0);
    assert.ok(busyTotal >= 2, `seed ${seed}: ${busyTotal} coffee runs in 20 min`);
    for (const id of ['a4', 'a5']) {
      assert.equal(brews.has(id), false, `${id} works and never brews`);
      for (const k of ['say', 'cup', 'mug']) assert.equal(seen[k].has(id), false, `${id}: no ${k}`);
    }
  }
});

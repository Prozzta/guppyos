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
const Co = loadTs('src/renderer/src/scene/themes/compositor.ts');

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
  const brewing = { spot: [1, 1], phase: 'brewing', t: 600, until: 0 };
  const ev = { events: [{ kind: 'brew', id: 'a', at: 400 }] };
  assert.deepEqual(C.coffeeProps(fake([walker({ coffee: brewing })], ev)), [{ kind: 'say', id: 'a', text: 'brewing a fresh one ☕', key: 'brew:a:400', ttl: 2000 }]);
  assert.deepEqual(C.coffeeProps(fake([walker({ coffee: brewing, cup: true })], ev)),
    [{ kind: 'cup', id: 'a', x: 50, y: 60, dir: 'down' }, { kind: 'say', id: 'a', text: 'a quick refill ☕', key: 'brew:a:400', ttl: 2000 }]);
  assert.equal(C.BREW_MS, 2600);
  // The key is the coffee run (its brew start), not the brew event: it holds once the event has
  // scrolled out of crew.events, stays put as the clocks drift, and differs for the next run.
  const run = { spot: [1, 1], phase: 'brewing', t: 600, until: 0 };
  assert.equal(C.coffeeProps(fake([walker({ coffee: run })]))[0].key, 'brew:a:400', 'no brew event');
  run.t = 600.4;
  assert.equal(C.coffeeProps(fake([walker({ coffee: run })], { t: 1000.9 }))[0].key, 'brew:a:400', 'the same run on a later frame');
  const odd = { spot: [1, 1], phase: 'brewing', t: 600.25, until: 0 };
  assert.equal(C.coffeeProps(fake([walker({ coffee: odd })], { t: 1000.5 }))[0].key, 'brew:a:400', 'whole ms');
  const next = { spot: [1, 1], phase: 'brewing', t: 0, until: 0 };
  assert.equal(C.coffeeProps(fake([walker({ coffee: next })], { t: 9000 }))[0].key, 'brew:a:9000', 'the next run');
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
  assert.equal(said[0].key, 'sip:a:1000');
  assert.equal(said[0].ttl, 3000);
  assert.equal(C.coffeeProps(fake([home], { t: 2500, events: ev }))[0].ttl, 1500, 'what is left of the line');
  assert.ok(C.COFFEE_LINES.coffee.includes(said[0].text), said[0].text);
  assert.deepEqual(C.coffeeProps(fake([home], { t: 3999, events: ev })), [{ ...said[0], ttl: 1 }], 'the same line (and key) on a later frame');
  const once = new Map();
  assert.equal(C.freshSays(said, once).length, 1, 'said once');
  assert.equal(C.freshSays(C.coffeeProps(fake([home], { t: 3999, events: ev })), once).length, 0, 'not again on a later frame');
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
  const brews = new Map(), sips = new Map(), seen = { say: new Set(), cup: new Set(), mug: new Set() };
  const said = new Map(), says = [];
  const ev = crew.event.bind(crew);
  crew.event = (kind, id, o) => {
    ev(kind, id, o);
    if (kind === 'brew' || kind === 'sip') { const m = kind === 'brew' ? brews : sips; (m.get(id) || m.set(id, []).get(id)).push(crew.t); }
  };
  for (let t = 0; t < ms; t += 50) {
    if (t % 1000 === 0) crew.sync(statuses(t));
    crew.tick(50);
    const props = C.coffeeProps(crew);
    for (const p of props) seen[p.kind].add(p.kind === 'mug' ? p.owner : p.id);
    // What StationFloor hands the bubble layer: each coffee state once.
    for (const s of C.freshSays(props, said)) says.push({ ...s, t: crew.t });
  }
  return { crew, brews, sips, seen, says };
}
const team = (n, status) => Array.from({ length: n }, (_, i) => ({ id: 'a' + i, status: typeof status === 'function' ? status(i) : status }));

test('the TES pack has coffee: two brew points and the 3-5 min cooldown', () => {
  const pk = tes();
  assert.deepEqual(pk.manifest.coffee.cooldown, [180, 300]);
  assert.equal(pk.scene.brew.length, 2);
});

for (const seed of [1, 2, 3]) test(`TES sim, seed ${seed}: 6 idle agents each reach coffee within 6 min, no loop, and every run shows`, () => {
  const { brews, sips, seen, says } = simulate(seed, 6 * 60000, () => team(6, 'idle'));
  // The bubble layer is told each coffee state exactly once: one brew line per brew, at most one sip line per sip.
  const keys = says.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, 'no key said twice');
  for (const [id, at] of brews) assert.equal(says.filter((s) => s.id === id && s.key.startsWith('brew:')).length, at.length, `${id}: one brew line per brew`);
  for (const s of says) {
    assert.ok(s.ttl > 0 && s.ttl <= (s.key.startsWith('brew:') ? C.BREW_MS : C.SIP_LINE_MS), `${s.key} ttl ${s.ttl}`);
    if (s.key.startsWith('sip:')) assert.ok((sips.get(s.id) || []).includes(Number(s.key.split(':')[2])), `${s.key} is a real sip`);
  }
  assert.ok(says.some((s) => s.key.startsWith('sip:')), 'some sip line was said');
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

// ── 3. drawing: the viewer's mug, the hand it sits in, and where a parked mug sorts ──────────

test('the mug is the viewer\'s paintCup: white rim, cream body, yellow stripe, the handle on either side', () => {
  const rows = (px) => Array.from({ length: px.height }, (_, y) => Array.from({ length: px.width }, (_, x) => {
    const i = (y * px.width + x) * 4;
    if (!px.data[i + 3]) return '.';
    return { 'ffffff': 'W', 'f2ede2': 'c', 'e8c14d': 'Y', 'd9d2c4': 'h' }[[0, 1, 2].map((k) => px.data[i + k].toString(16).padStart(2, '0')).join('')] || '?';
  }).join(''));
  assert.deepEqual(rows(C.mugPixels(false)), ['WWWWW.', 'ccccch', 'YYYYYh', 'ccccc.']);
  assert.deepEqual(rows(C.mugPixels(true)), ['.WWWWW', 'hccccc', 'hYYYYY', '.ccccc']);
  assert.equal(C.mugDx(false), 0);
  assert.equal(C.mugDx(true), -1);
  assert.equal(C.MUG_H, 4);
});

test('the mug in the hand is found on every TES body and facing, inside the frame; away it goes behind', () => {
  const pk = tes(), R = pk.manifest.spriteRenderer, sheet = pk.store.get(pk.sheet), fw = R.frameWidth, fh = R.frameHeight;
  const cols = pk.manifest.builder.bodies.map((b) => b.column);
  assert.ok(cols.length >= 3);
  for (const col of cols) for (const dir of ['down', 'up', 'left', 'right']) {
    const c = C.cupInHand(sheet, col * fw, R.rows[dir] * fh, fw, fh, dir);
    assert.ok(c, `column ${col} ${dir}: a hand`);
    const x0 = c.x + C.mugDx(c.left);
    assert.ok(x0 >= 0 && x0 + C.MUG_W <= fw && c.y - C.MUG_H >= fh / 2 && c.y <= fh, `column ${col} ${dir}: in the lower body ${JSON.stringify(c)}`);
    assert.equal(c.back, dir === 'up', `${dir}: behind the body only facing away`);
    assert.equal(c.left, dir === 'right', `${dir}: the handle side`);
  }
  // One body exactly (the first, velcan-male): the hand's anchor pixel per facing, as the viewer finds it.
  const col0 = cols[0], pose = (dir) => C.cupInHand(sheet, col0 * fw, R.rows[dir] * fh, fw, fh, dir);
  assert.equal(pk.manifest.builder.bodies[0].id, 'velcan-male');
  assert.deepEqual(pose('down'), { x: 15, y: 27, left: false, back: false });
  assert.deepEqual(pose('up'), { x: 6, y: 27, left: false, back: true });
  assert.deepEqual(pose('left'), { x: 9, y: 27, left: false, back: false });
  assert.deepEqual(pose('right'), { x: 18, y: 27, left: true, back: false });
  // A frame with no skin low on the body has no hand: no mug drawn.
  const blank = { width: fw, height: fh, data: new Uint8ClampedArray(fw * fh * 4) };
  assert.equal(C.cupInHand(blank, 0, 0, fw, fh, 'down'), null);
});

test('pruneSaid forgets the agents who left the floor, and only them', () => {
  const said = new Map([['a', 'brew:a:400'], ['b', 'sip:b:900'], ['c', 'brew:c:10']]);
  C.pruneSaid(said, ['a', 'c', 'z']);
  assert.deepEqual([...said], [['a', 'brew:a:400'], ['c', 'brew:c:10']]);
  C.pruneSaid(said, []);
  assert.equal(said.size, 0);
});

test('handsOf finds 4-connected skin blobs below the neck', () => {
  const W = 32, data = new Uint8ClampedArray(W * W * 4);
  const set = (x, y, rgb) => { const i = (y * W + x) * 4; data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255; };
  set(10, 0, [0, 0, 0]); // the outline: the darkest pixel, the top row
  set(12, 8, [220, 170, 140]); // skin in the face rows
  for (const [x, y] of [[5, 22], [6, 22], [6, 23], [25, 24]]) set(x, y, [220, 170, 140]);
  set(15, 22, [40, 40, 200]); // not skin
  set(20, 18, [220, 170, 140]); // the neck row (top + 18): not a hand
  set(28, 19, [220, 170, 140]); // the first hand row (top + 19), as the viewer
  const h = C.handsOf({ width: W, height: W, data }, 0, 0, W, W);
  assert.deepEqual(h.map((q) => [q.x0, q.x1, q.y0, q.y1, q.n]).sort((a, b) => a[0] - b[0]), [[5, 6, 22, 23, 3], [25, 25, 24, 24, 1], [28, 28, 19, 19, 1]]);
});

test('a parked mug sorts just after what it stands on; on flat art, by its own base line', () => {
  const px = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) });
  const items = [
    { x: 0, y: 0, px: px(20, 20), foot: 30, rank: 2 },
    { x: 0, y: 10, px: px(20, 5), foot: 40, rank: 1 },
    { x: 100, y: 100, px: px(5, 5), foot: 200, rank: 9 },
  ];
  assert.deepEqual(C.mugDepth(2, 12, items), { foot: 40, rank: 1.25 }, 'the topmost of the two it stands on');
  assert.deepEqual(C.mugDepth(2, 5, items), { foot: 30, rank: 2.25 });
  assert.deepEqual(C.mugDepth(50, 50, items), { foot: 50, rank: 1e9 - 0.5 }, 'flat art: before anyone standing on that line');
  // TES: the Captain's and the Speck consoles' mugs stand on their sorted consoles, so the console never hides them.
  const pk = tes(), plan = Co.buildScenePlan({ ...pk.scene, store: pk.store });
  const on = [...pk.scene.mugSpots].filter(([, [x, y]]) => C.mugDepth(x, y, plan.sorted).rank < 1e9 - 1).map(([s]) => s.name).sort();
  assert.deepEqual(on, ['Captain', 'Speck1', 'Speck2']);
});

// ── 4. StationFloor draws it (source pins; the draw itself needs a GPU) ─────────────────────

test('StationFloor draws the coffee each tick: cups in hand, parked mugs, and each line once through the bubble layer', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'scene', 'themes', 'StationFloor.tsx'), 'utf8');
  const tick = src.slice(src.indexOf('const onTick ='), src.indexOf('app.ticker.add(onTick)'));
  assert.ok(tick.length > 0);
  assert.match(tick, /const coffee = coffeeProps\(crew\);/);
  assert.match(tick, /pruneSaid\(said, crew\.walkers\(\)\.map\(\(p\) => p\.id\)\);\s*for \(const item of freshSays\(coffee, said\)\) bubbles\.say\(item\.id, item\.text, \{ ttl: item\.ttl, key: item\.key \}\);/);
  // the cup: at the hand of the person's frame, the viewer's mug, kept with that person
  assert.match(tick, /item\.kind === 'cup'[\s\S]*handOf\(s\.col, item\.dir\)[\s\S]*c\.sprite\.position\.set\(s\.sprite\.x \+ pose\.x \+ mugDx\(pose\.left\), s\.sprite\.y \+ pose\.y - MUG_H\);[\s\S]*holding\.add\(item\.id\);/);
  assert.match(src, /cupInHand\(sheetPx, col \* fw, stand\[dir\] \* fh, fw, fh, dir\)/);
  // the parked mug: at the pack's mug point, sorted with what it stands on
  assert.match(tick, /m\.sprite\.position\.set\(item\.x \+ mugDx\(false\), item\.y - MUG_H\);\s*Object\.assign\(m, mugDepth\(item\.x, item\.y, plan\.sorted\)\);[\s\S]*parked\.add\(item\.owner\);/);
  assert.match(tick, /for \(const \[id, c\] of cups\) if \(!holding\.has\(id\)\) \{ c\.sprite\.destroy\(\); cups\.delete\(id\); \}/);
  assert.match(tick, /for \(const \[id, m\] of mugs\) if \(!parked\.has\(id\)\) \{ m\.sprite\.destroy\(\); mugs\.delete\(id\); \}/);
  // depth: mugs sort with the map, a cup just in front of (or, facing away, behind) its person
  assert.match(tick, /for \(const m of mugs\.values\(\)\) items\.push\(m\);/);
  assert.match(tick, /c\.sprite\.zIndex = i \+ \(c\.back \? -0\.5 : 0\.5\);/);
  // with the map cached, the cups in hand and the parked mugs are boxes for frontPicker, as the
  // people are: a static in front of one is drawn again over it in the scene
  assert.match(src, /for \(const c of cups\.values\(\)\) near\.push\(\{ x: c\.sprite\.x, y: c\.sprite\.y, w: MUG_W, h: MUG_H \}\);\s*for \(const m of mugs\.values\(\)\) near\.push\(\{ x: m\.sprite\.x, y: m\.sprite\.y, w: MUG_W, h: MUG_H \}\);/);
  assert.doesNotMatch(src, /\.visible = !useCache/);
  // the coffee lines come from coffeeProps only: the generic crew lines carry no brew or sip
  const lines = src.match(/const lines: Record<string, string> = \{([^}]*)\}/)[1];
  assert.doesNotMatch(lines, /\b(brew|sip):/);
});

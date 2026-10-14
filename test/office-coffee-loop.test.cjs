/**
 * The Office-floor coffee loop.
 *
 * An idle agent's café break ends in a refill (or a fresh mug), the mug is
 * carried home, and the moment the courier sits down updateDeskLife sends a
 * still-idle agent wandering. A wandering agent is not sitting, so it was
 * break-eligible again at once, and the café director (a window every 6-12 s,
 * taken 70% of the time) sent it straight back: a lone idle agent spent its
 * whole idle life walking to coffee and back.
 *
 * The fix gives each agent a 3-5 minute rest after a break (coffeeGap.ts). The
 * simulation below replays the floor's idle cycle with the director's own
 * timing: the same cycle with no rest is the loop (control), and with the rest
 * a lone idle agent takes a few coffees per 10 minutes. The source pins check
 * that OfficeFloor starts the rest whenever a break is released, counts it
 * down every frame, and uses it for the café only (errands are unchanged).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = require('./load-ts.cjs');

const gap = load('src/renderer/src/scene/office/coffeeGap.ts');
const floor = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/scene/office/OfficeFloor.tsx'), 'utf8');

/** A seeded PRNG so every run replays the same floor. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/**
 * Replay `minutes` of one idle agent on the floor at 10 fps. The phases and
 * their lengths follow OfficeFloor: walk to the café (~5 s), linger 8-16 s,
 * endBreak -> releaseBreak -> a refill run at the machine (~10 s), carry the
 * mug home (~6 s), sit, and updateDeskLife sends it wandering.
 * `releaseBreak(rt)` is the floor's hook at the end of every break.
 */
function simulate({ minutes, seed, releaseBreak }) {
  const rand = rng(seed);
  const agent = { status: 'idle' };
  let sitting = false;
  const rt = { character: { isSitting: () => sitting } };
  let phase = 'wander', left = 0, cafeCooldown = 5, breaks = 0;
  const dt = 0.1;
  for (let t = 0; t < minutes * 60; t += dt) {
    // updateCafeteria: advance the rests, then the director's window.
    gap.tickCoffeeRest(rt, dt);
    cafeCooldown -= dt;
    if (cafeCooldown <= 0) {
      cafeCooldown = 6 + rand() * 6;
      if (rand() < 0.7 && gap.cafeEligible(agent, rt)) {
        rt.brk = {}; phase = 'toCafe'; left = 5; breaks++;
      }
    }
    // The agent's own legs.
    if (phase === 'wander') continue;
    left -= dt;
    if (left > 0) continue;
    if (phase === 'toCafe') { phase = 'linger'; left = 8 + rand() * 8; }
    else if (phase === 'linger') { releaseBreak(rt); rt.brk = undefined; rt.run = {}; phase = 'refill'; left = 10; }
    else if (phase === 'refill') { rt.run = undefined; rt.cupCarryHome = true; phase = 'home'; left = 6; }
    else if (phase === 'home') {
      // updateDeskLife: seated at home with the mug -> park it -> wander off.
      rt.cupCarryHome = false; sitting = true; sitting = false; phase = 'wander';
    }
  }
  return breaks;
}

test('control: with no rest after a break the floor loops an idle agent back to coffee', () => {
  const runs = [1, 2, 3].map((seed) => simulate({ minutes: 10, seed, releaseBreak: () => {} }));
  for (const n of runs) assert.ok(n >= 12, `the replay reproduces the loop (${n} coffees in 10 min)`);
});

test('a lone idle agent rests 3-5 minutes between coffee breaks', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const n = simulate({ minutes: 10, seed, releaseBreak: (rt) => gap.startCoffeeRest(rt) });
    assert.ok(n >= 2 && n <= 3, `seed ${seed}: ${n} coffees in 10 min (want 2-3)`);
  }
  const rt = { character: { isSitting: () => false } };
  gap.startCoffeeRest(rt, () => 0); assert.equal(rt.coffeeRest, 180);
  gap.startCoffeeRest(rt, () => 0.999999); assert.ok(rt.coffeeRest > 299 && rt.coffeeRest <= 300);
});

test('the rest gates the café only; the rest of the eligibility rule is unchanged', () => {
  const idle = { status: 'idle' }, rt = { character: { isSitting: () => false } };
  assert.ok(gap.breakEligible(idle, rt) && gap.cafeEligible(idle, rt), 'a rested, standing idle agent');
  rt.coffeeRest = 1;
  assert.ok(gap.breakEligible(idle, rt), 'resting from coffee still allows an errand');
  assert.ok(!gap.cafeEligible(idle, rt), 'but not another café break');
  gap.tickCoffeeRest(rt, 2);
  assert.equal(rt.coffeeRest, 0);
  assert.ok(gap.cafeEligible(idle, rt), 'rested again');
  for (const [why, a, r] of [
    ['god', { isGod: true, status: 'idle' }, {}],
    ['working', { status: 'working' }, {}],
    ['on a break', idle, { brk: {} }], ['on an errand', idle, { err: {} }],
    ['on a coffee run', idle, { run: {} }], ['carrying a mug home', idle, { cupCarryHome: true }],
  ]) assert.ok(!gap.breakEligible(a, { character: { isSitting: () => false }, ...r }), why);
  assert.ok(!gap.breakEligible(idle, { character: { isSitting: () => true } }), 'seated at a desk');
  assert.ok(gap.breakEligible({ status: 'success' }, { character: { isSitting: () => false } }), 'success counts as idle');
});

test('OfficeFloor wires the rest into the café director', () => {
  const src = floor.replace(/\r\n/g, '\n');
  assert.match(src, /import \{ breakEligible, cafeEligible, startCoffeeRest, tickCoffeeRest \} from '\.\/coffeeGap';/);
  assert.match(src, /const releaseBreak = \(rt: Runtime\): void => \{\n\s+if \(!rt\.brk\) return;\n\s+startCoffeeRest\(rt\);/,
    'every released break starts the rest');
  assert.match(src, /\/\/ Advance every in-progress break\.\n\s+for \(const \[id, rt\] of runtimes\) \{\n\s+tickCoffeeRest\(rt, dt\);/,
    'every runtime counts its rest down each frame');
  const cafe = src.slice(src.indexOf('const updateCafeteria'), src.indexOf('startBreak(agent.id, rt);'));
  assert.match(cafe, /if \(rt && cafeEligible\(agent, rt\)\) candidates\.push/, 'the café picks from rested agents');
  assert.match(src, /if \(r && breakEligible\(a, r\)\) candidates\.push/, 'errands keep the plain rule');
  assert.doesNotMatch(src, /const breakEligible = /, 'one eligibility rule, in coffeeGap.ts');
});

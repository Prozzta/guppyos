'use strict';

/**
 * TEST-FLAKE-RENDERER-PROFILE: the probe names where a busy renderer is stuck from the paused stacks
 * (exact), not from the CPU profile, whose sampler can charge a JIT-compiled loop's ticks to its caller
 * under load. `stuckInOf` (src/main/rendererRecovery.ts) chooses: stacks win; the profile answers only
 * when no stack was captured; a profile that names a different function (or none) is flagged.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { stuckInOf } = loadTs('src/main/rendererRecovery.ts');

// A loop `spin` called from an anonymous timer arrow; its current line moves between pauses.
const loopStacks = [
  ['spin app.js:5:5', '(anonymous) app.js:8:54'],
  ['spin app.js:6:9', '(anonymous) app.js:8:54'],
  ['spin app.js:5:5', '(anonymous) app.js:8:54'],
];

test('stuckIn: the paused stacks win over a profile that charged the caller (the loaded full-suite case)', () => {
  const r = stuckInOf(loopStacks, []); // the profile's only frame was (anonymous), so its top app list is empty
  assert.equal(r.stuckIn.source, 'stacks');
  assert.ok(r.stuckIn.fn.startsWith('spin app.js:'), JSON.stringify(r));
  assert.equal(r.profileDisagrees, true, 'an empty profile top app is a disagreement');
});

test('stuckIn: the stacks win over a profile naming a different app function, and it is flagged', () => {
  const r = stuckInOf(loopStacks, [{ fn: 'render app.js:40:1', pct: 70 }, { fn: 'spin app.js:3:1', pct: 30 }]);
  assert.equal(r.stuckIn.source, 'stacks');
  assert.ok(r.stuckIn.fn.startsWith('spin '));
  assert.equal(r.profileDisagrees, true);
});

test('stuckIn: a profile that agrees by function is not flagged (definition vs current position differ)', () => {
  const r = stuckInOf(loopStacks, [{ fn: 'spin app.js:3:1', pct: 60 }]);
  assert.equal(r.stuckIn.source, 'stacks');
  assert.equal(r.profileDisagrees, false);
});

test('stuckIn: the INNERMOST app function wins even when a named caller sits at a fixed line in every stack', () => {
  // The loop's line differs in each pause; its named caller's line never moves. Counting exact frames
  // would pick the caller; the innermost function is where the renderer is stuck.
  const stacks = [
    ['inner app.js:2:1', 'outer app.js:9:1'],
    ['inner app.js:3:7', 'outer app.js:9:1'],
    ['inner app.js:4:2', 'outer app.js:9:1'],
  ];
  const r = stuckInOf(stacks, [{ fn: 'outer app.js:8:1', pct: 80 }]);
  assert.equal(r.stuckIn.source, 'stacks');
  assert.equal(r.stuckIn.fn.split(' ')[0], 'inner', JSON.stringify(r));
  assert.equal(r.profileDisagrees, true, 'the profile named the caller');
});

test('stuckIn: vendor and React-internal frames are skipped to the innermost APP frame', () => {
  const stacks = [['workLoopSync app.js:900:1', 'myComponent app.js:20:3'], ['performUnitOfWork app.js:880:1', 'myComponent app.js:21:3']];
  const r = stuckInOf(stacks, []);
  assert.equal(r.stuckIn.fn.split(' ')[0], 'myComponent', JSON.stringify(r));
});

test('stuckIn: with no stack (an idle page) the profile answers; with neither, null', () => {
  assert.deepEqual(stuckInOf([], [{ fn: 'tick app.js:1:1', pct: 90 }]), { stuckIn: { fn: 'tick app.js:1:1', source: 'profile' }, profileDisagrees: false });
  assert.deepEqual(stuckInOf([], []), { stuckIn: null, profileDisagrees: false });
});

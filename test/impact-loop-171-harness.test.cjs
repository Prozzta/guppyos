'use strict';
/**
 * IMPACT-LOOP-171, RENDERED on the REAL App (a hidden Electron window, sandboxed by run.cjs +
 * isolateAppPaths): with an agent card whose impact is non-null - a 100% capacity HOLD on one
 * agent, or the floor-wide auto-delivery PAUSE - the renderer must stay flat.
 *
 * v1.1.70 fails both: control:snapshot is re-issued thousands of times a second and the renderer's
 * private memory climbs (the 2026-09-27 22:03Z and 2026-09-28 01:06Z white screens; MEMSPIKE-WHY).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

function check(r, label) {
  assert.equal(r.ok, true, r.error);
  assert.equal(r.shown, true, `${label}: the floor shows the agents`);
  const s = r.samples;
  assert.equal(r.stoppedEarly, false, `${label}: control:snapshot was re-issued without bound (${r.totalCalls} calls in ${r.msToCap} ms) - the impact loop`);
  // After the first 5 s (mount-time reads), the rate must be ~0.
  const late = s.filter((x) => x.t > 5).reduce((a, x) => a + x.calls, 0);
  assert.ok(late <= 5, `${label}: ${late} control:snapshot calls in the last ${s.length - 5} s (want ~0); samples ${JSON.stringify(s)}`);
  assert.ok(r.totalCalls <= 40, `${label}: ${r.totalCalls} control:snapshot calls in total (want one per agent card mount)`);
  const priv = s.map((x) => x.privateMb).filter((x) => typeof x === 'number');
  const first = priv[Math.min(4, priv.length - 1)];
  const peak = Math.max(...priv.slice(4));
  assert.ok(peak - first < 80, `${label}: renderer private ${first} -> ${peak} MB (want flat); samples ${JSON.stringify(s)}`);
}

test('RENDERED (real App): a 100% capacity HOLD on one agent -> no re-read loop, renderer flat', { timeout: 180_000 }, async () => {
  const r = await runScenario(join(__dirname, 'electron-harness', 'scenarios', 'impact-loop-hold.tsx'), { timeoutMs: 150_000 });
  check(r, 'hold');
});

test('RENDERED (real App): the floor-wide auto-delivery PAUSE -> no re-read loop, renderer flat', { timeout: 180_000 }, async () => {
  const r = await runScenario(join(__dirname, 'electron-harness', 'scenarios', 'impact-loop-pause.tsx'), { timeoutMs: 150_000 });
  check(r, 'pause');
});

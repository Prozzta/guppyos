'use strict';
require('./tools/own-job.cjs');
/**
 * TES-SCENE-BOUNCE-188, RENDERED (a hidden Electron window, the REAL App on a TES project): the
 * Human saw the whole map scene jump up and settle back when they selected an agent card in the
 * bottom roster. A select nudges the camera toward that agent (StationFloor), and since
 * TES-FLOOR-WHOLE-188 the frame overflowed a pane at its whole n, so the camera followed the nudge
 * up to 44 device px. Here (scenarios/tes-scene-bounce.tsx: 1265x790, sidebar 720), the semantic
 * lip-to-lip box is a fractional height-limited fit; each roster card is clicked by
 * a DOM click, and on every rendered frame from before the click until 2.5 s after it:
 * - the floor's scale and origin (device px) are those of the frame before the click;
 * - the floor pane's and the canvas's boxes did not move either.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario, harnessTestTimeout } = require('./electron-harness/run.cjs');

const TES = join(__dirname, '..', 'themes', 'tes');
const SCENARIO = join(__dirname, 'electron-harness', 'scenarios', 'tes-scene-bounce.tsx');

test('RENDERED (DPR 1): clicking an agent card in the roster leaves the TES scene where it stands', { timeout: harnessTestTimeout(120_000) }, async (t) => {
  const r = await runScenario(SCENARIO, { timeoutMs: 120_000, env: { HARNESS_DPR: '1', HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]) } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.dpr, 1, 'the window has DPR 1');
  const ids = { Jim: 'jim', Creed: 'creed', Andy: 'andy', Dwight: 'dwight' };
  assert.deepEqual(r.clicks.map((c) => c.who), Object.keys(ids));
  for (const { who, found, selected, frames } of r.clicks) {
    assert.equal(found, true, `${who}'s card is in the roster`);
    assert.equal(selected, ids[who], `the click selected ${who}`);
    assert.ok(frames.length >= 30, `${who}: ${frames.length} frames recorded`);
    const f0 = frames[0];
    // Not vacuous: the 336-row semantic box gets the expected fractional height-limited fit.
    assert.ok(Math.abs(f0.n - 1.8020833333333333) < 1e-9, `${who}: fractional semantic-fit scale (${f0.n})`);
    const moved = frames.filter((f) => f.n !== f0.n || f.ox !== f0.ox || f.oy !== f0.oy);
    const reflowed = frames.filter((f) => f.paneTop !== f0.paneTop || f.paneH !== f0.paneH || f.canvasTop !== f0.canvasTop || f.canvasH !== f0.canvasH);
    t.diagnostic(`${who}: rest n=${f0.n} ox=${f0.ox} oy=${f0.oy}; moved frames ${moved.length}, most up ${Math.max(0, ...frames.map((f) => f0.oy - f.oy))} px`);
    assert.deepEqual(moved.slice(0, 3), [], `${who}: the scene moved on ${moved.length} of ${frames.length} frames`);
    assert.deepEqual(reflowed.slice(0, 3), [], `${who}: the pane moved on ${reflowed.length} frames`);
  }
});

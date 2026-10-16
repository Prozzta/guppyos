'use strict';
/**
 * TES-FLOOR-WHOLE-188, RENDERED (a hidden Electron window, the real OfficeFloor, the bundled tes pack
 * with a crew): the semantic lip-to-lip box uses the largest uniform device scale and stays centred
 * on every frame. Its floor uses a cached ceil(scale) source then one sharp nearest resample. Over
 * the run (scenarios/tes-floor-whole.tsx: 576x587, the Human's pane with its
 * padding, then 960x640, 700x470 and 1200x900, with crew members selected), at DPR 1 and 1.25:
 * - TES-SCENE-BOUNCE-188: in an unchanged pane the scene never moves: a select's nudge lifted it
 *   (this test used to require that motion, as texelEasing >= 5);
 * - every frame: the box fills its limiting axis, fits its other axis and is centred within one
 *   device px; cache scale is integral and is the one sharp-resample source scale;
 * - the pane's edges are never blank; when a pane is taller than the supplied art, its palette
 *   backdrop occupies the rest instead of stretching the hull.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario, harnessTestTimeout } = require('./electron-harness/run.cjs');

const TES = join(__dirname, '..', 'themes', 'tes');
const SCENARIO = join(__dirname, 'electron-harness', 'scenarios', 'tes-floor-whole.tsx');

for (const dpr of ['1', '1.25']) {
  test(`RENDERED (DPR ${dpr}): semantic fit stays centred and uses one sharp cached resample`, { timeout: harnessTestTimeout(300_000) }, async (t) => {
    const r = await runScenario(SCENARIO, { width: 1240, height: 940, timeoutMs: 300_000, env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]), HARNESS_DPR: dpr } });
    assert.equal(r.ok, true, r.error);
    t.diagnostic(JSON.stringify({ frames: r.frames, fitBad: r.fitBad, fitAt: r.fitAt, cacheBad: r.cacheBad, builds: r.builds, blank: r.edgeBlank, configs: r.configs }));
    assert.deepEqual(r.errors, []);
    assert.equal(r.dpr, Number(dpr), 'the window has the DPR asked for');
    assert.ok(r.frames >= 600, `${r.frames} frames`);
    assert.equal(r.fitBad, 0, 'the lip-to-lip box is uniformly scaled, centred and maximally fitted');
    assert.equal(r.cacheBad, 0, 'cache scale is an integer ceil(scale), allowing one sharp resample');
    assert.ok(r.builds >= 1 && r.builds <= r.configs.length, `bounded cache builds: ${r.builds}`);
    assert.equal(r.configs.length, 4, 'the four panes were checked');
    // TES-SCENE-BOUNCE-188: selects do not move a settled semantic-fit frame.
    assert.equal(r.selects, 12, `every select ran (${r.selects})`);
    assert.equal(r.panned, 0, `the scene never moved in an unchanged pane (first: ${r.panAt})`);
    assert.equal(r.edgeBlank, 0, 'no blank px on the pane edges');
  });
}

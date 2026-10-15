'use strict';
/**
 * TES-FLOOR-EASE-188, RENDERED (a hidden Electron window, the real OfficeFloor, the bundled tes pack
 * with a crew): the floor is composed in map space at an integer scale k and shown by one quad, in
 * every frame, the camera easing after a resize or settled. Over the run
 * (scenarios/tes-floor-ease.tsx), at DPR 1 and 1.25:
 * - the composed scene is exactly the full depth sort at scale k ('below', the people and every
 *   static sorted together, 'above'), while a draw with the people over every static is not: a
 *   person behind a chair or console is hidden by it (Jim, FLOOR-FILL MUST-1 / SHOULD-2);
 * - on screen the people add nothing beyond the scene quad, which covers the scene's bounds
 *   through the world; the sort layer is unseen (alpha 0) in every frame;
 * - k follows the device scale, and the floor RT is built once per change of k (NIT-2);
 * - 'above' is drawn after the people (SHOULD-3).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario, harnessTestTimeout } = require('./electron-harness/run.cjs');

const TES = join(__dirname, '..', 'themes', 'tes');
const SCENARIO = join(__dirname, 'electron-harness', 'scenarios', 'tes-floor-ease.tsx');

// At DPR 1 the three boxes all take k = 2; at 1.25 the resizes move k (3, then 2).
for (const [dpr, kMoves] of [['1', false], ['1.25', true]]) {
  test(`RENDERED (DPR ${dpr}): easing or settled, the TES scene is the depth-sorted draw at scale k, people hidden behind statics, shown by one quad`, { timeout: harnessTestTimeout(180_000) }, async (t) => {
    const r = await runScenario(SCENARIO, { timeoutMs: 180_000, env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]), HARNESS_DPR: dpr } });
    assert.equal(r.ok, true, r.error);
    t.diagnostic(JSON.stringify({ checks: r.checks, easing: r.easingChecks, teethMin: r.teethMin, teethLast: r.teethLast, k: r.kSeen, builds: r.builds, above: r.aboveChecks }));
    assert.deepEqual(r.errors, []);
    assert.equal(r.dpr, Number(dpr), 'the window has the DPR asked for, not its square');
    assert.ok(r.checks >= 100, `checked ${r.checks} frames`);
    assert.ok(r.easingChecks >= 20, `of them ${r.easingChecks} while the camera eased`);
    assert.equal(r.sceneDiffMax, 0, 'the scene RT is the full depth sort, texel for texel, in every checked frame');
    assert.ok(r.teethLast > 50, `with the people drawn over every static, ${r.teethLast} texels differ: someone is behind a static`);
    assert.equal(r.screenDiffMax, 0, 'on screen, the sort layer adds nothing to the scene quad');
    assert.equal(r.alphaBad, 0, 'the sort layer is unseen in every frame');
    assert.equal(r.sceneFirst, true, 'the quad is under the sort layer in the world');
    assert.ok(r.quadErrMax < 1e-6, `the quad covers the scene bounds through the world (error ${r.quadErrMax})`);
    assert.equal(r.kBad, 0, 'k is sceneScale of the device scale');
    assert.equal(r.rtBad, 0, 'the RT is the bounds at k texels per map px, and the quad shows it');
    if (kMoves) assert.ok(r.kSeen.length >= 2, `k changed while resizing (${r.kSeen.join(' -> ')})`);
    assert.equal(r.leaked, 0, `each of the ${r.rebuilds} rebuilds freed both RTs it replaced`);
    assert.equal(r.builds, r.kSeen.length, `one floor build per k (${r.kSeen.join(' -> ')})`);
    assert.ok(r.aboveChecks >= 5, `'above' checked ${r.aboveChecks} times`);
    assert.equal(r.aboveBad, 0, "'above' is drawn over the person under it");
  });
}

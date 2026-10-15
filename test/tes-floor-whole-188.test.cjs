'use strict';
/**
 * TES-FLOOR-WHOLE-188, RENDERED (a hidden Electron window, the real OfficeFloor, the bundled tes pack
 * with a crew): the floor is drawn at a whole number n of device px per map px, on whole device px,
 * on every frame, the camera easing after a resize or settled. Over the run
 * (scenarios/tes-floor-whole.tsx: 576x587, the Human's pane with its padding, then 960x640, 700x470
 * and 1200x900, with crew members selected so the camera eases), at DPR 1 and 1.25:
 * - every frame: n, and the world's origin in device px, are whole; n is wholeScale of the pane;
 *   the floor texture's k is n, built once per n;
 * - every frame, the texel check: device px (X, Y) is map px (floor((X - ox) / n),
 *   floor((Y - oy) / n)) of the full depth sort drawn at one px per map px (people hidden behind
 *   statics, the hull, 'above'), the backdrop off the map: every art px n x n device px, no seam,
 *   the depth order right; a draw with the people over every static differs (teeth);
 * - the pane's edges are never blank, and below the ship the bottom row is its hull, not a band.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario, harnessTestTimeout } = require('./electron-harness/run.cjs');

const TES = join(__dirname, '..', 'themes', 'tes');
const SCENARIO = join(__dirname, 'electron-harness', 'scenarios', 'tes-floor-whole.tsx');

// DPR 1: n 2, 2, 1, 3. DPR 1.25: n 2, 2, 2, 3.
for (const [dpr, ns] of [['1', [2, 1, 3]], ['1.25', [2, 3]]]) {
  test(`RENDERED (DPR ${dpr}): every frame, easing or settled, every TES art px is n x n device px of the depth-sorted scene; no blank edge, no band`, { timeout: harnessTestTimeout(300_000) }, async (t) => {
    const r = await runScenario(SCENARIO, { width: 1240, height: 940, timeoutMs: 300_000, env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]), HARNESS_DPR: dpr } });
    assert.equal(r.ok, true, r.error);
    t.diagnostic(JSON.stringify({ frames: r.frames, texel: r.texelChecks, easing: r.texelEasing, n: r.nSeen, builds: r.builds, teethMax: r.teethMax, bad: r.texelBadMax, at: r.texelBadAt, wholeBad: r.wholeBad, nBad: r.nBad, kBad: r.kBad, blank: r.edgeBlank, band: r.bottomBand, configs: r.configs }));
    assert.deepEqual(r.errors, []);
    assert.equal(r.dpr, Number(dpr), 'the window has the DPR asked for');
    assert.ok(r.frames >= 600, `${r.frames} frames`);
    assert.equal(r.wholeBad, 0, 'n and the origin are whole device px on every frame');
    assert.equal(r.nBad, 0, 'n is the largest whole scale at which the keep box fits');
    assert.equal(r.kBad, 0, 'the floor texture has one texel per device px');
    assert.deepEqual(r.nSeen, ns, 'n steps with the pane');
    assert.equal(r.builds, ns.length, 'one floor build per n');
    assert.equal(r.configs.length, 4, 'the four panes were checked');
    assert.ok(r.texelChecks >= r.frames - 3, `the texel check ran on every frame (${r.texelChecks} of ${r.frames})`);
    // The keep box pins the view: a nudge pans at most the frame's overhang (a few dozen device px).
    assert.ok(r.texelEasing >= 5, `of them ${r.texelEasing} while the camera eased`);
    assert.equal(r.texelBadMax, 0, `every device px is its map px of the depth sort (worst: ${r.texelBadAt})`);
    assert.ok(r.teethChecks >= 10 && r.teethMax > 0, `with the people over every static the picture differs (${r.teethMax} px)`);
    assert.equal(r.edgeBlank, 0, 'no blank px on the pane edges');
    assert.equal(r.bottomBand, 0, 'below the ship, the bottom row is hull: no band');
  });
}

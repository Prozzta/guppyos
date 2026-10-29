'use strict';
require('./tools/own-job.cjs');
/**
 * TES-FLOOR-WHOLE-188, RENDERED (a hidden Electron window, the real OfficeFloor, the bundled tes pack
 * with a crew): the semantic lip-to-lip box uses the largest uniform device scale and stays centred
 * on every frame. Its floor uses a cached ceil(scale) source, then one linear (smooth) downscale, the
 * Human's choice. Over the run (scenarios/tes-floor-whole.tsx: 576x587, the Human's pane with its
 * padding, then 960x640, 700x470 and 1200x900, with crew members selected), at DPR 1 and 1.25:
 * - TES-SCENE-BOUNCE-188: in an unchanged pane the scene never moves: a select's nudge used to
 *   lift it;
 * - every frame: the box fills its limiting axis, fits its other axis and is centred within one
 *   device px; the cache scale is integral, the source of the one linear downscale;
 * - TES-HULL M1, every frame: over each person's device rect the stage equals the same frame drawn
 *   again with every static in depth order, and differs from a crew-top draw of it (the teeth);
 * - TES-HULL M2: a static drawn again over a person is filtered as the floor's own linear copy of it,
 *   so it looks the same whether or not someone walks behind it; drawn nearest it would not;
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
  test(`RENDERED (DPR ${dpr}): semantic fit stays centred, one linear cached downscale, people in depth order`, { timeout: harnessTestTimeout(300_000) }, async (t) => {
    const r = await runScenario(SCENARIO, { width: 1240, height: 940, timeoutMs: 300_000, env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]), HARNESS_DPR: dpr } });
    assert.equal(r.ok, true, r.error);
    t.diagnostic(JSON.stringify({ frames: r.frames, fitBad: r.fitBad, fitAt: r.fitAt, cacheBad: r.cacheBad, builds: r.builds, blank: r.edgeBlank, texelBadMax: r.texelBadMax, badFrames: r.badFrames?.slice(0, 2), configs: r.configs }));
    t.diagnostic(JSON.stringify({ depthChecks: r.depthChecks, depthBadMax: r.depthBadMax, depthBadAt: r.depthBadAt, depthArea: r.depthArea, depthPixels: r.depthPixels, depthSamples: r.depthSamples, teethChecks: r.teethChecks, teethMax: r.teethMax }));
    t.diagnostic(JSON.stringify({ frames: r.frames, frontPlaced: r.frontPlaced, frontStale: r.frontStale, frontMovedSameK: r.frontMovedSameK }));
    t.diagnostic(JSON.stringify({ frontChecks: r.frontChecks, frontStatics: r.frontStatics, frontCovered: r.frontCovered, frontDiff: r.frontDiff, frontMaxDelta: r.frontMaxDelta, frontTeeth: r.frontTeeth, frontSamples: r.frontSamples, frontLog: r.frontLog }));
    assert.deepEqual(r.errors, []);
    assert.equal(r.dpr, Number(dpr), 'the window has the DPR asked for');
    assert.ok(r.frames >= 600, `${r.frames} frames`);
    assert.equal(r.fitBad, 0, 'the lip-to-lip box is uniformly scaled, centred and maximally fitted');
    assert.equal(r.cacheBad, 0, 'cache scale is an integer ceil(scale), the source of one linear downscale');
    assert.ok(r.texelChecks >= r.frames - 3, `fit texel checks ran every frame (checks ${r.texelChecks}, frames ${r.frames})`);
    assert.equal(r.texelBadMax, 0, `fit texel check is exact under its shared integer-cache + linear-downscale reference (${r.texelBadAt})`);
    // TES-HULL M1: the people against the statics in front of them, every frame, in the shot's own layout.
    assert.ok(r.depthChecks >= r.frames - 3, `depth checks ran every frame (checks ${r.depthChecks}, frames ${r.frames})`);
    assert.equal(r.depthBadMax, 0, `over the people's rects the stage is this frame drawn again in depth order (${r.depthBadAt} ${JSON.stringify(r.depthSamples)})`);
    assert.ok(r.depthPixels > 0, `a static stood in front of a person during the run (${r.depthPixels} px where depth order shows)`);
    assert.equal(r.teethChecks, r.depthChecks);
    assert.ok(r.teethMax > 0, `the depth check has teeth: a crew-top draw differs on the same px (max ${r.teethMax})`);
    // TES-HULL M2: a static drawn again over a person matches the floor's linear copy of it.
    assert.ok(r.frontChecks >= 10 && r.frontStatics >= 150, `front-static checks ran (${r.frontChecks} checks, ${r.frontStatics} statics)`);
    assert.ok(r.frontCovered > 10_000, `the statics checked cover px (${r.frontCovered})`);
    // Exact but for the GPU's own rounding of the two interpolated texture coordinates: 1 level at most.
    assert.ok(r.frontMaxDelta <= 1, `a static drawn again is the floor's own linear sampling of it, on every px (max ${r.frontMaxDelta}, ${r.frontDiff} px off by 1: ${JSON.stringify(r.frontSamples)})`);
    assert.ok(r.frontDiff * 100 < r.frontCovered, `few px off by 1 (${r.frontDiff} of ${r.frontCovered})`);
    assert.ok(r.frontTeeth > 1000, `teeth: the old nearest front sprite differs from the floor's copy by more than 1 (${r.frontTeeth} px)`);
    // Jim S1 (mutant F): compose re-places the front statics for every view, a same-k one too.
    assert.equal(r.frontPlaced, r.frames, `the placement was compared on every frame (${r.frontPlaced} of ${r.frames})`);
    assert.equal(r.frontStale, 0, `COMPOSE PLACED THE FRONT STATICS FOR THE VIEW ON SCREEN (${r.frontStale} stale frames, first: ${r.frontStaleAt})`);
    assert.ok(r.frontMovedSameK >= 1, `a pane or camera change kept k, so the re-place was exercised (${r.frontMovedSameK} frames)`);
    assert.ok(r.builds >= 1 && r.builds <= r.configs.length, `bounded cache builds: ${r.builds}`);
    assert.equal(r.configs.length, 4, 'the four panes were checked');
    // TES-SCENE-BOUNCE-188: selects do not move a settled semantic-fit frame.
    assert.equal(r.selects, 12, `every select ran (${r.selects})`);
    assert.equal(r.panned, 0, `the scene never moved in an unchanged pane (first: ${r.panAt})`);
    assert.equal(r.edgeBlank, 0, 'no blank px on the pane edges');
  });
}

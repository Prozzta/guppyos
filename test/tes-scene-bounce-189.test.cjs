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
/** Camera.nudgeToward's default duration: the window in which a select could move the scene. */
const NUDGE_MS = 1200;

test('NUDGE_MS is the camera nudge\'s real duration (the frame-coverage window, LOAD-FLAKES-105)', () => {
  const cam = require('node:fs').readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'scene', 'office', 'Camera.ts'), 'utf8');
  assert.ok(cam.includes(`nudgeToward(worldX: number, worldY: number, duration = ${NUDGE_MS})`), 'Camera.nudgeToward defaults to NUDGE_MS');
  const floor = require('node:fs').readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'scene', 'themes', 'StationFloor.tsx'), 'utf8');
  assert.match(floor, /camera\.nudgeToward\(p\.x, p\.y\)/, 'the select nudge uses the default duration');
});

test('RENDERED (DPR 1): clicking an agent card in the roster leaves the TES scene where it stands', { timeout: harnessTestTimeout(120_000) }, async (t) => {
  const r = await runScenario(SCENARIO, { timeoutMs: 120_000, env: { HARNESS_DPR: '1', HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]) } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.dpr, 1, 'the window has DPR 1');
  const ids = { Jim: 'jim', Creed: 'creed', Andy: 'andy', Dwight: 'dwight' };
  assert.deepEqual(r.clicks.map((c) => c.who), Object.keys(ids));
  for (const { who, found, selected, clickAt, frames } of r.clicks) {
    assert.equal(found, true, `${who}'s card is in the roster`);
    assert.equal(selected, ids[who], `the click selected ${who}`);
    // Not vacuous (LOAD-FLAKES-105): the frames must COVER the nudge, not number 30. A select's
    // camera nudge (Camera.nudgeToward) eases over NUDGE_MS of wall time, so a bounce shows on any
    // frame drawn in that window. The rest frame is from before the click, every quarter of the
    // nudge holds a frame, and a frame lands after it. A count assumed a 60 fps timer, which a
    // loaded machine does not give a hidden window (24 frames in g5, the window still covered).
    const at = frames.map((f) => f.t);
    const cover = `${who}: click at ${clickAt}, frames at ${JSON.stringify(at)}`;
    assert.ok(at[0] < clickAt, `the rest frame is from before the click: ${cover}`);
    for (let q = 0; q < 4; q++) {
      const from = clickAt + (q * NUDGE_MS) / 4, to = clickAt + ((q + 1) * NUDGE_MS) / 4;
      assert.ok(at.some((t) => t >= from && t < to), `a frame in nudge quarter ${q + 1} (${from}-${to} ms): ${cover}`);
    }
    assert.ok(at[at.length - 1] >= clickAt + NUDGE_MS, `a frame after the nudge ended: ${cover}`);
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

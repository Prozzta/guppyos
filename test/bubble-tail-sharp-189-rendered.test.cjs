'use strict';
require('./tools/own-job.cjs');
/**
 * TES-BUBBLE-TAIL-SHARP-189, RENDERED (a hidden Electron window, the REAL OfficeFloor): on the tes
 * pack and on the plain office, in the Human's 575x612 pane, a tall 360x760 and a wide 960x500, on
 * the camera's own fit, at DPR 1 and 1.25 (scenarios/bubble-tail-sharp-189.tsx). Every person holds
 * a cloud, and for every cloud drawn:
 * - its tail's tip is within 2 device px of the head it hangs over (1.1.88: 21-41 px left of it);
 * - its text is one texel per device px, from a whole device px, never blended (1.1.88: 0.5 x the
 *   world scale, so 0.911 at a fractional origin on the hull branch's smooth fit).
 * Not vacuous: the TES fit and the office camera put the world at scales that are not 2 x DPR.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario, harnessTestTimeout } = require('./electron-harness/run.cjs');

const TES = join(__dirname, '..', 'themes', 'tes');
const SCENARIO = join(__dirname, 'electron-harness', 'scenarios', 'bubble-tail-sharp-189.tsx');
const CREW = ['andy', 'dwight', 'god', 'jim'];

for (const dpr of [1, 1.25]) {
  test(`RENDERED (DPR ${dpr}): on both floors, in every pane, each cloud's tail points at its head and its text is drawn 1:1`, { timeout: harnessTestTimeout(180_000) }, async (t) => {
    const r = await runScenario(SCENARIO, { timeoutMs: 180_000, env: { HARNESS_DPR: String(dpr), HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]) } });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.dpr, dpr, `the window has DPR ${dpr}`);
    assert.deepEqual(r.errors.filter((e) => !/ResizeObserver loop/.test(e)), [], 'no page errors');
    for (const floor of ['tes', 'office']) {
      assert.deepEqual(r[floor].map((p) => `${p.w}x${p.h}`), ['575x612', '360x760', '960x500']);
      for (const p of r[floor]) {
        const where = `${floor} ${p.w}x${p.h} DPR ${dpr} (world scale ${p.worldScale.toFixed(4)}, resolution ${p.resolution})`;
        t.diagnostic(`${where}: tip - head ${p.clouds.map((c) => `${c.id} ${(c.tailTip.x - c.head.x).toFixed(2)}`).join(', ')}`);
        assert.deepEqual(p.clouds.map((c) => c.id).sort(), CREW, `${where}: every person's cloud is drawn`);
        assert.ok(Math.abs(p.worldScale - Math.round(p.worldScale)) > 0.01, `${where}: the fit is fractional (not vacuous)`);
        for (const c of p.clouds) {
          assert.ok(Math.abs(c.tailTip.x - c.head.x) <= 2, `${where}: ${c.id}'s tail tip ${c.tailTip.x.toFixed(2)} vs head ${c.head.x.toFixed(2)} device px`);
          assert.ok(c.tailTip.y > c.body.y + c.body.h, `${where}: ${c.id}'s tip hangs below the cloud`);
          assert.ok(Math.abs(c.textInfo.devPerTexel - 1) < 1e-9, `${where}: ${c.id}'s text is ${c.textInfo.devPerTexel} device px per texel`);
          for (const v of [c.textInfo.originDev.x, c.textInfo.originDev.y]) assert.ok(Math.abs(v - Math.round(v)) < 1e-6, `${where}: ${c.id}'s text starts at ${v}, off the device px grid`);
          assert.equal(c.textInfo.scaleMode, 'nearest', `${where}: ${c.id}'s text is sampled nearest`);
        }
      }
    }
    // The office camera eases its zoom: its world scale is not 2 x DPR (1.1.88's only sharp case).
    assert.ok(r.office.every((p) => Math.abs(p.worldScale - 2 * dpr) > 0.01), 'the office world is never at the one scale 1.1.88 drew sharp');
  });
}

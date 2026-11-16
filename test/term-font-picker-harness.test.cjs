'use strict';
require('./tools/own-job.cjs');

/**
 * TERM-FONT-JETBRAINS, RENDERED: the terminal font selector on a real xterm with the real
 * bundled faces, at 100%, 125% and 150% display scale.
 *
 * The scenario (electron-harness/scenarios/term-font-picker.tsx) mounts a PtyTerminalView and
 * one more pooled terminal that no view shows, then drives the header's <select> and the zoom
 * store. Each row is what xterm measured (device cell width) beside what the face needs (its
 * advance), so a cell narrower than its glyph (clipped or overlapping text) fails here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = path.join(__dirname, 'electron-harness', 'scenarios', 'term-font-picker.tsx');
const SIZES = [10, 12, 14, 16];
const FACES = ['JetBrains Mono', 'Martian Mono'];
const EM = { 'JetBrains Mono': 0.6, 'Martian Mono': 0.7 };
const runs = new Map();
const result = (dpr) => {
  if (!runs.has(dpr)) runs.set(dpr, runScenario(scenario, { timeoutMs: 300_000, env: { HARNESS_DPR: String(dpr) } }));
  return runs.get(dpr);
};
const family = (face) => `"${face}", Consolas, monospace`;

for (const dpr of [1, 1.25, 1.5]) {
  test(`dpr ${dpr}: JetBrains Mono by default, the selector sits beside the size buttons`, async () => {
    const r = await result(dpr);
    assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
    assert.equal(r.dpr, dpr, 'the page really runs at this scale');
    assert.deepEqual(r.faces, FACES);
    assert.equal(r.initialStored, null, 'nothing picked yet');
    assert.equal(r.initialFace, 'JetBrains Mono');
    assert.deepEqual(r.selector.options, FACES);
    assert.equal(r.selector.beforeZoomButtons, true);
    assert.equal(r.selector.sameRow, true, 'same row and height as the size buttons');
    assert.ok(r.selector.gapPx >= 0 && r.selector.gapPx <= 12, `right beside them (${r.selector.gapPx}px)`);
    const first = r.rows.filter((x) => x.step === 'default');
    assert.deepEqual(first.map((x) => x.size), SIZES);
    for (const x of first) {
      assert.equal(x.face, 'JetBrains Mono');
      assert.equal(x.selectValue, 'JetBrains Mono');
      assert.equal(x.stored, null, 'showing the default stores nothing');
    }
  });

  test(`dpr ${dpr}: every face and size has a cell wider than its glyph, floor(advance x dpr) + 1 device px`, async () => {
    const r = await result(dpr);
    assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
    assert.equal(r.rows.length, 14, 'three sweeps of four sizes and the two rows right after a pick');
    for (const x of r.rows) {
      const where = `${x.step} ${x.face} ${x.size}px`;
      assert.equal(x.ready, true, `${where}: the bundled face is loaded`);
      assert.ok(Math.abs(x.advance - EM[x.face] * x.size) < 0.001, `${where}: measured with the face itself (${x.advance}), not a fallback`);
      assert.equal(x.cell, Math.floor(x.advance * dpr) + 1, `${where}: cell`);
      assert.ok(x.cell > x.advance * dpr, `${where}: cell ${x.cell} is wider than the glyph ${x.advance * dpr}`);
      assert.equal(x.letterSpacing, 1, `${where}: pad`);
      assert.equal(x.pooledLetterSpacing, 1, `${where}: pad on the terminal no view shows`);
      assert.equal(x.family, family(x.face), where);
      assert.equal(x.pooledFamily, family(x.face), `${where}: the terminal no view shows follows too`);
      assert.equal(x.selectValue, x.face, where);
    }
    for (const face of FACES) {
      assert.deepEqual(r.rows.filter((x) => x.step === `picked ${face}`).map((x) => x.size), SIZES, `${face} swept`);
    }
  });

  test(`dpr ${dpr}: a pick applies live (re-measured, refitted, pty told), is stored, and switching back restores the first grid`, async () => {
    const r = await result(dpr);
    assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
    const by = (step) => r.rows.filter((x) => x.step === step);
    const before = by('default')[3];
    const [picked] = by('picked at 16px, no size change');
    assert.equal(before.size, 16);
    assert.equal(picked.size, 16);
    assert.equal(picked.face, 'Martian Mono');
    assert.equal(picked.stored, 'Martian Mono');
    assert.ok(picked.cell > before.cell, `the wider face got a wider cell with no size change (${before.cell} -> ${picked.cell})`);
    assert.ok(picked.cols < before.cols, `and the grid was refitted (${before.cols} -> ${picked.cols} cols)`);
    assert.equal(picked.resizes, before.resizes + 1, 'the pty heard the new grid once');
    const [back] = by('picked back at 16px, no size change');
    assert.equal(back.face, 'JetBrains Mono');
    assert.equal(back.stored, 'JetBrains Mono');
    assert.equal(back.cell, before.cell);
    assert.equal(back.cols, before.cols);
    const grid = (rows) => rows.map((x) => [x.size, x.cell, x.cols]);
    assert.deepEqual(grid(by('picked JetBrains Mono')), grid(by('default')), 'the round trip leaves nothing behind');
    assert.notDeepEqual(grid(by('picked Martian Mono')), grid(by('default')));
  });
}

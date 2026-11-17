'use strict';
require('./tools/own-job.cjs');

/**
 * TERM-FONT-LATE-OPEN-COVERAGE-108, RENDERED: a terminal opened after the starting font load
 * has ended, on a real xterm with the real bundled faces, at 100%, 150% and 200% display scale.
 *
 * term-font-picker-harness covers the terminals that exist at startup (opened before the face
 * loaded, measured again when it did). The scenario here (electron-harness/scenarios/
 * term-font-late-open.tsx) opens terminals later, one in a view and one no view shows:
 *   LOADED  the face is already loaded at open(): the first measurement is the only one.
 *   HELD    a picked face is still loading at open() (its load is held shut for 1.5 s): the
 *           terminal must be measured again when the load ends.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = path.join(__dirname, 'electron-harness', 'scenarios', 'term-font-late-open.tsx');
const EM = { 'JetBrains Mono': 0.6, 'Martian Mono': 0.7 };
const family = (face) => `"${face}", Consolas, monospace`;
const runs = new Map();
const result = (dpr) => {
  if (!runs.has(dpr)) runs.set(dpr, runScenario(scenario, { timeoutMs: 180_000, env: { HARNESS_DPR: String(dpr) } }));
  return runs.get(dpr);
};

function common(x, where) {
  assert.equal(x.family, family(x.face), `${where}: family`);
  assert.equal(x.letterSpacing, 1, `${where}: pad`);
  assert.ok(Math.abs(x.advance - EM[x.face] * x.size) < 0.001, `${where}: the face itself is usable (advance ${x.advance} at ${x.size}px), not a fallback`);
}

/** A terminal in a view: the cell is floor(advance x dpr) + 1 device px, measured with the face itself. */
function attachedCell(x, dpr, where) {
  common(x, where);
  assert.equal(x.cell, Math.floor(x.advance * dpr) + 1, `${where}: CELL MEASURED WITH THE LOADED FACE, PAD INCLUDED`);
  assert.equal(x.ptyCols, x.cols, `${where}: the pty was told the grid xterm has`);
}

/** A terminal no view shows has no WebGL renderer yet, so its cell is not floored (as in
 *  term-font-picker-harness): wider than the glyph, and by no more than the pad. */
function pooledCell(x, dpr, where) {
  const need = x.advance * dpr;
  common(x, where);
  assert.ok(x.cell > need, `${where}: CELL ${x.cell} IS WIDER THAN THE LOADED FACE'S GLYPH ${need}`);
  assert.ok(x.cell <= need + Math.max(1, dpr) + 0.001, `${where}: and not one measured with another face (${x.cell} for ${need})`);
}

for (const dpr of [1, 1.5, 2]) {
  test(`dpr ${dpr}: a terminal opened after the starting face has loaded has that face's cell from its first measurement (MUTANT: no cell pad at creation)`, async () => {
    const r = await result(dpr);
    assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
    assert.equal(r.dpr, dpr, 'the page really runs at this scale');
    assert.equal(r.initialFace, 'JetBrains Mono');
    assert.equal(r.loaded.readyAtOpen, true, 'the starting face was loaded before the late terminals opened');
    attachedCell(r.loaded.start, dpr, 'the terminal from startup');
    attachedCell(r.loaded.view, dpr, 'LATE, in a view');
    assert.equal(r.loaded.view.cell, r.loaded.start.cell, 'LATE, in a view: the same cell as the terminal from startup');
    pooledCell(r.loaded.pooled, dpr, 'LATE, no view');
  });

  test(`dpr ${dpr}: a terminal opened while a picked face is still loading is measured again when the load ends (MUTANT: no re-measure after the load for a terminal created meanwhile)`, async () => {
    const r = await result(dpr);
    assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
    const d = r.held.during;
    assert.deepEqual({ before: d.readyAtOpen, after: d.readyAfterOpen }, { before: false, after: false }, 'HELD: the picked face was not loaded when the terminals opened');
    assert.equal(d.startFamily, family('JetBrains Mono'), 'HELD: the terminal from startup is still on the old face');
    assert.equal(d.pooledFamily, family('Martian Mono'), 'HELD: a terminal created now is created on the picked face');
    assert.ok(d.pooledCellAtOpen < EM['Martian Mono'] * d.pooledSize * dpr,
      `HELD: at open() the terminal no view shows was measured with a fallback (cell ${d.pooledCellAtOpen} at ${d.pooledSize}px), so the cell checked below comes from a second measurement`);
    assert.ok(r.held.landedMs >= 1400, `the pick landed after the held load ended (${r.held.landedMs} ms)`);
    assert.deepEqual(r.held.after.map((x) => x.id), ['pty-start', 'pty-late', 'pty-late-pooled', 'pty-held', 'pty-held-pooled']);
    for (const x of r.held.after) {
      const where = `after the load, ${x.id}`;
      assert.equal(x.face, 'Martian Mono');
      if (x.attached) attachedCell(x, dpr, where); else pooledCell(x, dpr, where);
    }
  });
}

'use strict';
require('./tools/own-job.cjs');

/**
 * TERM-FONT-SETTINGS-107 (was TERM-FONT-JETBRAINS), RENDERED: the terminal font list in
 * Settings on a real xterm with the real bundled faces, at 100%, 125% and 150% display scale.
 *
 * The scenario (electron-harness/scenarios/term-font-picker.tsx) mounts the Settings Terminal
 * section, a PtyTerminalView and one more pooled terminal that no view shows, then drives the
 * section's <select> and the zoom store. Each row is what xterm measured (device cell width)
 * beside what the face needs (its advance), so a cell narrower than its glyph (clipped or
 * overlapping text) fails here. window.cth is a double whose config is an object in the page.
 *
 * TERM-FONT-PICKER-DPR15-RACE: the scenario holds the first pick's font load shut for 1.5 s and
 * waits for a pick on the load itself, never on a fixed delay (the old 700 ms was shorter than
 * a first load under a full suite: 'the bundled face is loaded' false, cell 15 -> 15).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = path.join(__dirname, 'electron-harness', 'scenarios', 'term-font-picker.tsx');
const SIZES = [10, 12, 14, 16];
const FACES = ['JetBrains Mono', 'Martian Mono', 'Cascadia Mono', 'Atkinson Hyperlegible Mono'];
const EM = { 'JetBrains Mono': 0.6, 'Martian Mono': 0.7, 'Cascadia Mono': 1200 / 2048, 'Atkinson Hyperlegible Mono': 0.632 };
const runs = new Map();
const result = (dpr) => {
  if (!runs.has(dpr)) runs.set(dpr, runScenario(scenario, { timeoutMs: 300_000, env: { HARNESS_DPR: String(dpr) } }));
  return runs.get(dpr);
};
const family = (face) => `"${face}", Consolas, monospace`;

for (const dpr of [1, 1.25, 1.5]) {
  test(`dpr ${dpr}: JetBrains Mono by default; the list is in Settings with the colours toggle under it, and the terminal header has none`, async () => {
    const r = await result(dpr);
    assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
    assert.equal(r.dpr, dpr, 'the page really runs at this scale');
    assert.deepEqual(r.faces, FACES);
    assert.equal(r.initialFace, 'JetBrains Mono');
    assert.deepEqual(r.selector.options, FACES);
    assert.equal(r.selector.label, 'Terminal font');
    assert.equal(r.selector.heading, 'Terminal');
    assert.equal(r.selector.settingsSelects, 1, 'one list in the section');
    assert.equal(r.selector.headerSelects, 0, 'no font list in the terminal header');
    assert.equal(r.selector.headerZoomButtons, 2, 'the size buttons are still there');
    assert.equal(r.selector.coloringUnderFont, true, 'the colours toggle is directly under the font list');
    assert.equal(r.selector.coloringLabel, 'on');
    const first = r.rows.filter((x) => x.step === 'default');
    assert.deepEqual(first.map((x) => x.size), SIZES);
    for (const x of first) {
      assert.equal(x.face, 'JetBrains Mono');
      assert.equal(x.selectValue, 'JetBrains Mono');
      assert.equal(x.stored, null, 'showing the default saves nothing');
    }
  });

  test(`dpr ${dpr}: every face and size has a cell wider than its glyph, floor(advance x dpr) + 1 device px`, async () => {
    const r = await result(dpr);
    assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
    assert.equal(r.rows.length, 24, 'five sweeps of four sizes and the four rows right after a pick');
    for (const x of r.rows) {
      const where = `${x.step} ${x.face} ${x.size}px`;
      assert.equal(x.ready, true, `${where}: the bundled face is loaded`);
      assert.ok(Math.abs(x.advance - EM[x.face] * x.size) < 0.001, `${where}: measured with the face itself (${x.advance}), not a fallback`);
      assert.equal(x.cell, Math.floor(x.advance * dpr) + 1, `${where}: cell`);
      assert.ok(x.cell > x.advance * dpr, `${where}: cell ${x.cell} is wider than the glyph ${x.advance * dpr}`);
      // The terminal no view shows has its own size and no WebGL renderer yet, so its cell is
      // not floored: pin that it was measured with the picked face at that size, pad included.
      const need = x.pooledAdvance * dpr;
      assert.ok(Math.abs(x.pooledAdvance - EM[x.face] * x.pooledSize) < 0.001, `${where}: pooled advance ${x.pooledAdvance} at ${x.pooledSize}px`);
      assert.ok(x.pooledCell > need, `${where}: the terminal no view shows has a cell ${x.pooledCell} wider than its glyph ${need}`);
      assert.ok(x.pooledCell <= need + Math.max(1, dpr) + 0.001, `${where}: and not one measured with another face (${x.pooledCell} for ${need})`);
      assert.equal(x.letterSpacing, 1, `${where}: pad`);
      assert.equal(x.pooledLetterSpacing, 1, `${where}: pad on the terminal no view shows`);
      assert.equal(x.family, family(x.face), where);
      assert.equal(x.pooledFamily, family(x.face), `${where}: the terminal no view shows follows too`);
      assert.equal(x.selectValue, x.face, where);
      assert.equal(x.ptyCols, x.cols, `${where}: the pty was told the grid xterm has`);
    }
    for (const face of FACES) {
      assert.deepEqual(r.rows.filter((x) => x.step === `picked ${face}`).map((x) => x.size), SIZES, `${face} swept`);
    }
  });

  test(`dpr ${dpr}: a pick applies live to every terminal (re-measured, refitted, pty told), is saved to the config, and switching back restores the first grid`, async () => {
    const r = await result(dpr);
    assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
    const by = (step) => r.rows.filter((x) => x.step === step);
    const before = by('default')[3];
    assert.equal(before.size, 16);
    for (const face of FACES.slice(1)) {
      const [picked] = by(`picked ${face} at 16px, no size change`);
      assert.equal(picked.size, 16, face);
      assert.equal(picked.face, face);
      assert.equal(picked.stored, face, `${face}: the config holds the pick`);
      assert.equal(picked.ptyCols, picked.cols, `${face}: the pty was told the new grid`);
      if (EM[face] > EM['JetBrains Mono']) {
        assert.ok(picked.cell > before.cell, `${face}: the wider face got a wider cell with no size change (${before.cell} -> ${picked.cell})`);
        assert.ok(picked.cols < before.cols, `${face}: and the grid was refitted (${before.cols} -> ${picked.cols} cols)`);
      } else {
        assert.ok(picked.advance < before.advance, `${face}: a narrower glyph (${picked.advance} < ${before.advance})`);
        assert.ok(picked.cell <= before.cell && picked.cols >= before.cols, `${face}: never a wider cell or a smaller grid`);
      }
    }
    const [back] = by('picked back at 16px, no size change');
    assert.equal(back.face, 'JetBrains Mono');
    assert.equal(back.stored, 'JetBrains Mono');
    assert.equal(back.cell, before.cell);
    assert.equal(back.cols, before.cols);
    const grid = (rows) => rows.map((x) => [x.size, x.cell, x.cols]);
    assert.deepEqual(grid(by('picked JetBrains Mono')), grid(by('default')), 'the round trip leaves nothing behind');
    for (const face of FACES.filter((f) => EM[f] > EM['JetBrains Mono'])) assert.notDeepEqual(grid(by(`picked ${face}`)), grid(by('default')), face);
    assert.deepEqual(r.saves, [...FACES.slice(1), FACES[0]].map((terminalFont) => ({ terminalFont })),
      'one save per pick, of the font key only; a size change saves nothing');
  });

  test(`dpr ${dpr}: a pick whose face is still loading leaves every terminal on the old face and cell, and lands when the load ends (MUTANT: the face set before it is loaded; MUTANT: the scenario measures after a fixed delay)`, async () => {
    const r = await result(dpr);
    assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
    const h = r.held;
    assert.ok(h, 'the first pick ran with its load held');
    assert.ok(h.heldMs >= 1500, `HELD: the load was held ${h.heldMs} ms, longer than any delay the scenario used to wait`);
    assert.equal(h.picked, 'Martian Mono');
    assert.equal(h.face, 'Martian Mono', 'HELD: the pick is taken at once');
    assert.equal(h.selectValue, 'Martian Mono');
    assert.equal(h.stored, 'Martian Mono', 'HELD: and saved at once');
    assert.equal(h.ready, false, 'HELD: the face is not loaded yet');
    assert.equal(h.family, family('JetBrains Mono'), 'HELD: the terminal is still on the old face (an unloaded face would be measured as Consolas)');
    assert.equal(h.pooledFamily, family('JetBrains Mono'), 'HELD: and so is the terminal no view shows');
    assert.equal(h.cell, h.cellBefore, 'HELD: the cell is the old one');
    const [picked] = r.rows.filter((x) => x.step === 'picked Martian Mono at 16px, no size change');
    assert.equal(picked.ready, true, 'LANDED: once the load ended the face is loaded');
    assert.equal(picked.family, family('Martian Mono'), 'LANDED: and on the terminal');
    assert.ok(picked.cell > h.cell, `LANDED: with its own wider cell (${h.cell} -> ${picked.cell})`);
  });

  test(`dpr ${dpr}: a failed save puts the list and the terminals back; the colours toggle saves its own key; a re-opened section shows the stored font`, async () => {
    const r = await result(dpr);
    assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
    assert.deepEqual(r.failed, {
      face: 'JetBrains Mono', selectValue: 'JetBrains Mono', family: family('JetBrains Mono'),
      alert: 'The terminal font could not be saved. The current one is unchanged.', saves: 0, stored: 'JetBrains Mono'
    });
    assert.deepEqual(r.failedToggle, { label: 'on', saves: 0, stored: null }, 'a colours save that fails: the toggle is back on, nothing stored');
    assert.deepEqual(r.toggled, { label: 'off', save: { terminalPatternColoring: false }, face: 'JetBrains Mono' });
    assert.deepEqual(r.reopened, {
      selectValue: 'Cascadia Mono', face: 'Cascadia Mono', family: family('Cascadia Mono'),
      pooledFamily: family('Cascadia Mono'), coloringLabel: 'off', saves: 1
    }, 'what the file holds, in the list and in every terminal; opening Settings saves nothing');
  });
}

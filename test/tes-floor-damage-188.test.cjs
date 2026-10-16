'use strict';
/**
 * PERF-FLOOR-FILL-188, RENDERED (scenarios/tes-floor-damage.tsx): the TES floor draws again only
 * what changed, and every frame so drawn is, px for px, the frame a full draw makes:
 * - at DPR 1, 1.25, 1.5, 1.75 and 2, in three panes each (576x587, 960x640, 700x470: 15 configs),
 *   with walkers, selects, an agent leaving and coming back, thought clouds coming and going,
 *   a still person dimmed, tinted, blended and put behind its chair in place, the shared layer
 *   dimmed and made unrenderable, and a lost WebGL context (the floor rebuilds and carries on);
 * - most frames are incremental, and they draw a fraction of the canvas;
 * - MUTANTS (DPR 1): a tracker that forgets a removed thing's old rect, a mover's old rect, the
 *   clear inside the scissor (pinned by the edge step: at 700x470@1, which leaves the vertical axis
 *   uncovered, a still person lifted half over the backdrop is put back; a vacuity guard asserts
 *   its old rect then holds backdrop px),
 *   the scissor's flip to GL's bottom-up rows, the rect's rounding margin, the bubbles, a sprite's
 *   own alpha/tint/blend, its depth, its ancestors' look or their renderable, is caught.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { runScenario, harnessTestTimeout } = require('./electron-harness/run.cjs');

const ROOT = join(__dirname, '..');
const TES = join(ROOT, 'themes', 'tes');
const SCENARIO = join(__dirname, 'electron-harness', 'scenarios', 'tes-floor-damage.tsx');
const DAMAGE = join(ROOT, 'src', 'renderer', 'src', 'scene', 'themes', 'damage.ts');
const FLOOR = join(ROOT, 'src', 'renderer', 'src', 'scene', 'themes', 'StationFloor.tsx');
const run = (env = {}) => runScenario(SCENARIO, {
  width: 1240, height: 940, timeoutMs: 300_000,
  env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]), ...env }
});

for (const dpr of ['1', '1.25', '1.5', '1.75', '2']) {
  test(`RENDERED (DPR ${dpr}): every frame drawn incrementally is the frame a full draw makes`, { timeout: harnessTestTimeout(300_000) }, async (t) => {
    const r = await run({ HARNESS_DPR: dpr });
    assert.equal(r.ok, true, r.error);
    t.diagnostic(JSON.stringify({ frames: r.frames, whole: r.whole, incremental: r.incremental, nothing: r.nothing, passes: r.passes, incShare: r.canvasPx ? +(r.incPx / r.canvasPx).toFixed(3) : null, configs: r.configs, apps: r.apps, afterRebuild: r.afterRebuild, diff: r.diffFrames, bad: r.badFrames.slice(0, 3) }));
    assert.deepEqual(r.errors, []);
    assert.equal(r.dpr, Number(dpr), 'the window has the DPR asked for');
    assert.ok(r.frames >= 600, `${r.frames} frames`);
    assert.equal(r.stillFound, true, 'a still person was found for the in-place looks');
    assert.equal(r.looks, 12, `every in-place look change was made (${r.looks})`);
    assert.ok(r.looksAt >= 260 && r.looksAt + 36 < 560, `the look changes ran on a settled floor before the context loss (from render ${r.looksAt})`);
    assert.equal(r.configs.length >= 3, true, `three panes at least (${r.configs})`);
    assert.equal(r.apps, 2, 'the context was lost and the floor rebuilt');
    assert.ok(r.afterRebuild >= 50, `frames after the rebuild: ${r.afterRebuild}`);
    assert.ok(r.incremental >= r.frames / 2, `most frames incremental (${r.incremental} of ${r.frames}; whole ${r.whole})`);
    assert.ok(r.incPx < 0.5 * r.canvasPx, `an incremental frame draws a fraction of the canvas (${(r.incPx / r.canvasPx).toFixed(3)})`);
    assert.equal(r.diffFrames, 0, `every frame equals a full draw (worst ${r.diffMax} px at ${r.diffAt})`);
    t.diagnostic(JSON.stringify({ edgeAt: r.edgeAt, edgeCheckAt: r.edgeCheckAt, edgeCfg: r.edgeCfg, edgeKind: r.edgeKind, edgeBackdropPx: r.edgeBackdropPx }));
    if (dpr === '1') {
      // The clear's pin is not vacuous: the person put back leaves backdrop px in its old rect, at n = 1.
      assert.equal(r.edgeCfg, '700x470@1', `the edge step ran in the 700x470 pane (${r.edgeCfg})`);
      assert.equal(r.edgeKind, 'incremental', `the edge's move back was drawn incrementally (${r.edgeKind})`);
      assert.ok(r.edgeBackdropPx > 0, `the person's lifted rect holds backdrop px once it is back (${r.edgeBackdropPx})`);
    }
  });
}

const MUTANTS = [
  ['removed thing: old rect dropped', DAMAGE, "    for (const [k, p] of prev) if (!now.has(k) && p.rect) dirty.push(p.rect);\n", ''],
  ['mover: old rect dropped', DAMAGE, '      if (p?.rect) dirty.push(p.rect);\n', ''],
  ['no clear inside the scissor', FLOOR, 'realRender({ container: app.stage, clear: true });', 'realRender({ container: app.stage, clear: false });'],
  ['scissor y not flipped to GL', FLOOR, 'gl.scissor(p.x, H - p.y - p.h, p.w, p.h);', 'gl.scissor(p.x, p.y, p.w, p.h);'],
  ['no rounding margin', DAMAGE, 'Math.floor(b.minX * r) - 1), y0 = Math.max(0, Math.floor(b.minY * r) - 1);', 'Math.round(b.minX * r)), y0 = Math.max(0, Math.round(b.minY * r));'],
  ['own alpha/tint/blend not signed', FLOOR, '|${c.alpha},${c.tint},${c.blendMode}|${c.zIndex}|', '||${c.zIndex}|'],
  ['depth not signed', FLOOR, '|${c.zIndex}|${c.renderable}`', '||${c.renderable}`'],
  ["ancestors' look not signed", FLOOR, 'visit(k, `${look}|${c.alpha},${c.tint},${c.blendMode},${c.renderable}`)', "visit(k, '')"],
  ["ancestors' renderable not signed", FLOOR, '${c.blendMode},${c.renderable}`)', '${c.blendMode}`)'],
  ['bubbles not drawn again', FLOOR, 'now.set(k, { rect: rectOf(k), sig: String(painted) });', 'now.set(k, { rect: rectOf(k), sig: \'b\' });']
];
test('MUTANTS (DPR 1): each is caught by the incremental == full check', { timeout: harnessTestTimeout(300_000 * MUTANTS.length) }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tes-damage-mut-'));
  try {
    for (const [name, file, from, to] of MUTANTS) {
      const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      assert.equal(src.split(from).length, 2, `${name}: the mutated text is in the source once`);
      const mut = join(dir, `${name.replace(/\W+/g, '-')}${file.endsWith('.tsx') ? '.tsx' : '.ts'}`);
      writeFileSync(mut, src.replace(from, to));
      const r = await run({ HARNESS_DPR: '1', HARNESS_SOURCE_OVERRIDES: JSON.stringify({ [file]: mut }) });
      t.diagnostic(`${name}: ok ${r.ok}, diff frames ${r.diffFrames}, worst ${r.diffMax} at ${r.diffAt}`);
      assert.ok(!r.ok || r.diffFrames > 0, `${name} is caught`);
      if (name === 'no clear inside the scissor') assert.ok(r.edgeDiff > 0, `${name} is caught on the edge step (render ${r.edgeCheckAt})`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

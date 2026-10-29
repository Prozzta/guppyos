'use strict';
require('./tools/own-job.cjs');

// TES-HULL-STRETCH-188: this is intentionally a rendered check.  The old 4096px one-row
// continuation passed all pixel-alignment tests while making a tall narrow pane look like a hull
// stretched many times its supplied art height.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const ROOT = path.join(__dirname, '..');
const TES = path.join(ROOT, 'themes', 'tes');
const SCENARIO = path.join(__dirname, 'electron-harness', 'scenarios', 'tes-hull-stretch-189.tsx');

test('TES lip-to-lip box is the largest centred uniform fit, with no synthetic hull, in every pane', { timeout: 180_000 }, async () => {
  const r = await runScenario(SCENARIO, { timeoutMs: 150_000, env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]) } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.aspects.map((a) => a.name), ['tall', 'screenshot', 'human', 'square', 'wide']);
  for (const a of r.aspects) {
    const width = a.box.x1 - a.box.x0, height = a.box.y1 - a.box.y0;
    assert.ok(Math.abs(a.scaleX - a.scaleY) < 1e-6, `${a.name}: scale is uniform`);
    assert.ok(Math.abs(a.scaleX - a.expectedScale) < 1e-6, `${a.name}: largest fit scale`);
    assert.ok(width <= a.size.width + 1 && height <= a.size.height + 1, `${a.name}: fit box stays in pane`);
    assert.ok(Math.min(Math.abs(width - a.size.width), Math.abs(height - a.size.height)) <= 1,
      `${a.name}: limiting axis is filled (${width}x${height} in ${a.size.width}x${a.size.height})`);
    assert.ok(Math.abs((a.box.x0 + a.box.x1) / 2 - a.size.width / 2) <= 1, `${a.name}: centred horizontally`);
    assert.ok(Math.abs((a.box.y0 + a.box.y1) / 2 - a.size.height / 2) <= 1, `${a.name}: centred vertically`);
    assert.ok(Number.isInteger(a.cacheScale) && a.cacheScale >= a.scaleX, `${a.name}: cached at a sharp whole source scale`);
    assert.equal(a.syntheticPixels, 0, `${a.name}: nothing synthetic below the supplied hull (${a.syntheticPixels} px)`);
  }
  const evidence = process.env.TES_HULL_STRETCH_EVIDENCE;
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true });
    for (const a of r.aspects) {
      const png = String(a.png).replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(path.join(evidence, `${a.name}.png`), Buffer.from(png, 'base64'));
    }
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({
      aspects: r.aspects.map(({ png, ...a }) => a),
    }, null, 2));
  }
});

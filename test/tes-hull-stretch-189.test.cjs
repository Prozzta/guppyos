'use strict';

// TES-HULL-STRETCH-188: this is intentionally a rendered check.  The old 4096px one-row
// continuation passed all pixel-alignment tests while making a tall narrow pane look like a hull
// stretched many times its supplied art height.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const ROOT = path.join(__dirname, '..');
const TES = path.join(ROOT, 'themes', 'tes');
const SCENARIO = path.join(__dirname, 'electron-harness', 'scenarios', 'tes-hull-stretch-189.tsx');

test('TES hull keeps its supplied proportions in tall, square, and wide panes', { timeout: 180_000 }, async () => {
  const r = await runScenario(SCENARIO, { timeoutMs: 150_000, env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]) } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.aspects.map((a) => a.name), ['tall', 'square', 'wide']);
  const tall = r.aspects[0];
  assert.ok(tall.n >= 1, 'whole-device-pixel camera remains enabled');
  assert.equal(tall.extraHullRows, 0,
    `below the TES art bottom is backdrop, not a ${tall.extraHullRows}px stretched hull in the tall pane`);
  for (const a of r.aspects) assert.ok(a.n >= 1, `${a.name} stays whole-pixel`);
});
